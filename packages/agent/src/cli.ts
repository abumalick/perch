import { homedir, hostname } from 'node:os';
import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AgentConfig } from './infrastructure/config';
import { systemClock, RandomIdGenerator, systemPathResolver } from './infrastructure/system';
import { TmuxAdapter } from './infrastructure/tmux-adapter';
import { FsProjectLister } from './infrastructure/fs-project-lister';
import { FileRecentStore } from './infrastructure/file-recent-store';
import { FileHiddenFoldersStore } from './infrastructure/file-hidden-folders-store';
import { GitRepoRemote } from './infrastructure/git-repo-remote';
import { FileClaudeSessionsStore } from './infrastructure/file-claude-sessions-store';
import { fsIsDirectory } from './infrastructure/fs-directory-checker';
import { createWorkspace } from './application/create-workspace';
import { listWorkspaces } from './application/list-workspaces';
import { closeWorkspace } from './application/close-workspace';
import { getRecentPaths } from './application/get-recent-paths';
import { browseDir } from './application/browse-dir';
import { isHiddenPath } from './application/is-hidden-path';
import { installHooks } from './application/install-hooks';
import { loadOrCreateRelayKeys } from './infrastructure/relay-key-file';
import { accountId } from '@perch/secure-channel';
import { FileDeviceStore } from './infrastructure/file-device-store';
import { enrolmentMode, forgetDevice, policyWarning, relayPolicy, revokeDevice, withEnrolmentMode, type Device, type DeviceRoster, type EnrolmentMode } from './application/device-roster';
import encodeQR from 'qr';
import { deviceFingerprint, generatePairingSecret, isJoinKey, parsePairingLink, sanitizeDeviceName } from '@perch/secure-channel';
import { parseEnvFile } from './application/agent-env';
import { connectMachine, mintPairingLink, pairingName } from './application/connect-machine';
import { FilePairingStore } from './infrastructure/file-pairing-store';
import { agentEnvFile, locateAgentEnv } from './infrastructure/agent-env-file';
import { agentService } from './infrastructure/agent-service';
import { relayJoinClient } from './infrastructure/relay-join-client';

function wire(config: AgentConfig) {
  const tmux = new TmuxAdapter();
  const recent = new FileRecentStore(config.recentStorePath);
  const lister = new FsProjectLister();
  const hiddenFolders = new FileHiddenFoldersStore(config.hiddenFoldersPath);
  const repoRemote = new GitRepoRemote();
  const claudeSessions = new FileClaudeSessionsStore(config.claudeSessionsDir);
  return { tmux, recent, lister, hiddenFolders, repoRemote, claudeSessions };
}

export async function run(argv: string[], env: NodeJS.ProcessEnv, home: string): Promise<string> {
  if (argv[0] === 'connect' || argv[0] === 'pair') return relaySetup(argv[0], argv.slice(1), env, home);
  const config = loadConfig({ ...env, ...(await agentEnvValues(env)) }, home);
  const { tmux, recent, lister, hiddenFolders, repoRemote, claudeSessions } = wire(config);
  const [command, ...rest] = argv;

  switch (command) {
    case 'list': {
      const hidden = await hiddenFolders.list();
      const workspaces = (
        await listWorkspaces({
          tmux,
          machineId: config.machineId,
          sessionPrefix: config.sessionPrefix,
          status: { get: () => undefined, getChangedAt: () => undefined, getUrgent: () => false },
          repoRemote,
          claudeSessions,
        })
      ).filter((w) => !isHiddenPath(w.projectPath, hidden));
      return JSON.stringify(workspaces, null, 2);
    }
    case 'create': {
      const projectPath = rest[0];
      if (!projectPath) throw new Error('usage: perch create <projectPath> [command]');
      const cmd = rest[1] ?? 'claude';
      const ws = await createWorkspace(
        {
          tmux,
          recent,
          resolvePath: systemPathResolver,
          isDirectory: fsIsDirectory,
          clock: systemClock,
          ids: new RandomIdGenerator(),
          machineId: config.machineId,
        },
        { projectPath, command: cmd },
      );
      return JSON.stringify(ws, null, 2);
    }
    case 'close': {
      const id = rest[0];
      if (!id) throw new Error('usage: perch close <workspaceId>');
      await closeWorkspace({ tmux }, id);
      return JSON.stringify({ closed: id });
    }
    case 'recent': {
      const hidden = await hiddenFolders.list();
      return JSON.stringify(await getRecentPaths({ recent, hidden }), null, 2);
    }
    case 'browse': {
      const path = rest[0];
      if (!path) throw new Error('usage: perch browse <path>');
      const hidden = await hiddenFolders.list();
      return JSON.stringify(await browseDir({ lister, hidden }, path, config.projectRoots), null, 2);
    }
    case 'install-hooks': {
      // Copy the hook script to a stable, $HOME-relative location so the
      // registered command is byte-identical across machines (the repo itself
      // lives at different sub-paths per machine). Copy rather than symlink so
      // the reference never goes stale if the repo moves or is removed.
      const hooksDir = joinPath(dirname(fileURLToPath(import.meta.url)), 'hooks');
      const stableScript = joinPath(home, '.perch', 'perch-hook.sh');
      await mkdir(dirname(stableScript), { recursive: true });
      for (const script of ['perch-hook.sh', 'perch-guard.sh']) {
        const stable = joinPath(home, '.perch', script);
        await copyFile(joinPath(hooksDir, script), stable);
        await chmod(stable, 0o755);
      }

      const settingsPath = joinPath(home, '.claude', 'settings.json');
      let current: Record<string, unknown> = {};
      try {
        current = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const hookCommand = 'bash ~/.perch/perch-hook.sh';
      const guardCommand = 'bash ~/.perch/perch-guard.sh';
      const merged = installHooks({ settings: current }, { hookCommand, guardCommand, port: config.port });
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf8');

      // Codex gets the same hooks only where it is installed, so a machine without it does not
      // grow a ~/.codex. Codex runs no hook until the user trusts it (keyed on a hash it does not
      // document), so that step stays with the user.
      const codexDir = joinPath(home, '.codex');
      if (!(await fsIsDirectory(codexDir))) {
        return JSON.stringify({ installed: settingsPath, scriptPath: stableScript });
      }
      const codexHooksPath = joinPath(codexDir, 'hooks.json');
      let codexCurrent: Record<string, unknown> = {};
      try {
        codexCurrent = JSON.parse(await readFile(codexHooksPath, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      const codexMerged = installHooks({ settings: codexCurrent }, { hookCommand, guardCommand, port: config.port, agent: 'codex' });
      await writeFile(codexHooksPath, JSON.stringify(codexMerged, null, 2), 'utf8');
      return JSON.stringify({
        installed: settingsPath,
        codexInstalled: codexHooksPath,
        codexNextStep: 'open Codex and trust the Perch hooks in /hooks; repeat after any hook change',
        scriptPath: stableScript,
      });
    }
    case 'relay-key': {
      const keys = await loadOrCreateRelayKeys(config.relayKeyPath);
      const account = accountId(keys.ed25519.publicKey);
      const lines = [
        `relay key file: ${config.relayKeyPath}`,
        `account: ${account}`,
        `agent key: ${keys.x25519.publicKey}`,
      ];
      for (const url of config.relayUrls) lines.push(`phone URL: ${url}/${account}`);
      return lines.join('\n');
    }
    case 'devices':
      return devices(new FileDeviceStore(config.devicesPath), rest);
    default:
      throw new Error(`unknown command: ${command ?? '(none)'}`);
  }
}

const CONNECT_USAGE = 'usage: perch connect <relay URL> --key <join key> (or PERCH_JOIN_KEY) [--pwa <PWA origin>] [--agent-url <relay URL for this agent>]';
const PAIR_USAGE = 'usage: perch pair [--relay <relay URL>] [--pwa <PWA origin>]';

function takeOption(args: string[], name: string, usage: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(usage);
  args.splice(at, 2);
  return value;
}

function pwaOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`--pwa must be the origin the phone opens Perch at, e.g. https://host:8443 (got ${value})`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`--pwa must be an http(s) origin (got ${value})`);
  return url.origin;
}

const isLoopbackRelay = (url: string) => /^wss?:\/\/(127\.|localhost[:/]|localhost$|\[::1\])/.test(url);

// What the service reads, over the shell's environment: a shell inside a workspace has none of
// the agent's variables, or a stale copy of them. No agent.env (a machine not set up as a
// service) leaves the environment alone.
async function agentEnvValues(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(await locateAgentEnv(env), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

// `perch connect` and `perch pair` configure the machine itself, so they read the agent.env the
// service reads rather than expecting it in the shell's environment.
async function relaySetup(command: 'connect' | 'pair', argv: string[], env: NodeJS.ProcessEnv, home: string): Promise<string> {
  const args = [...argv];
  const usage = command === 'connect' ? CONNECT_USAGE : PAIR_USAGE;
  const envFile = agentEnvFile(await locateAgentEnv(env));
  const config = loadConfig({ ...env, ...parseEnvFile(await envFile.read()) }, home);
  const keys = await loadOrCreateRelayKeys(config.relayKeyPath);
  const deps = {
    keys,
    machineId: pairingName(config.machineId, hostname()),
    ...(config.defaultPath ? { defaultPath: config.defaultPath } : {}),
    relay: relayJoinClient,
    env: envFile,
    service: agentService(),
    pairings: new FilePairingStore(config.pairingPath),
    newSecret: generatePairingSecret,
    now: () => new Date(),
  };
  const pwa = pwaOrigin(takeOption(args, '--pwa', usage));
  if (command === 'connect') {
    // From the environment instead, the key stays out of the process list other local users see.
    const joinKey = takeOption(args, '--key', usage) ?? env.PERCH_JOIN_KEY;
    const agentUrl = takeOption(args, '--agent-url', usage);
    const [relayUrl, ...extra] = args;
    if (!relayUrl || extra.length > 0 || !joinKey) throw new Error(CONNECT_USAGE);
    if (!isJoinKey(joinKey)) throw new Error('--key must be the relay\'s join key, as its operator printed it');
    const { lines, link } = await connectMachine(deps, { relayUrl, agentUrl, joinKey, pwaOrigin: pwa });
    return link ? [...lines, '', pairingInstructions(link)].join('\n') : lines.join('\n');
  }
  let relay = takeOption(args, '--relay', usage);
  if (args.length > 0) throw new Error(PAIR_USAGE);
  if (!relay) {
    const reachable = config.relayUrls.filter((url) => !isLoopbackRelay(url));
    if (reachable.length !== 1) {
      throw new Error(
        reachable.length === 0
          ? 'this machine holds no relay a phone can reach: run perch connect first, or name one with --relay'
          : `this machine holds several relays; name one with --relay: ${reachable.join(', ')}`,
      );
    }
    relay = reachable[0]!;
  }
  const origin = pwa ?? pwaOrigin(config.pwaOrigin);
  if (!origin) throw new Error('no PWA origin: pass --pwa <where your phone opens Perch>, e.g. https://host:8443');
  return pairingInstructions(await mintPairingLink(deps, { phoneUrl: relay, pwaOrigin: origin }));
}

function pairingInstructions(link: string): string {
  return [
    'On the phone, in Perch: Settings → Scan QR code, then scan this. Or open the link below on the',
    'phone (Android opens the installed app; on an iPhone copy it and use Settings → Paste pairing link).',
    '',
    // Half-height blocks: about 60 columns, where `term` needs twice that.
    encodeQR(link, 'ascii', { ecc: 'low' }),
    link,
    '',
    // The phone asks before pairing and shows this fingerprint: they must match.
    `The phone will show machine key ${deviceFingerprint(parsePairingLink(link)!.agentKey)}; check it matches.`,
    'It works once, for 10 minutes. `perch pair` makes another.',
  ].join('\n');
}

const DEVICES_USAGE = [
  'usage: perch devices [list | revoke <id|key> | forget <id|key> | enrolment on|off|closed]',
  '  enrolment on      the token or a pairing code enrols a new phone',
  '  enrolment off     only a pairing code from `perch pair` enrols one',
  '  enrolment closed  no new phone can enrol',
].join('\n');

const ENROLMENT_MODES: Record<EnrolmentMode, string> = {
  on: 'on (the token or a pairing code enrols a phone)',
  off: 'off (only a pairing code from `perch pair` enrols a phone)',
  closed: 'closed (no new phone can enrol)',
};

// The phones this agent accepts through the relay. A running agent picks up a change within
// seconds: it republishes the list to its relays and closes a revoked phone's sessions.
async function devices(store: FileDeviceStore, [action = 'list', arg]: string[]): Promise<string> {
  switch (action) {
    case 'list':
      return formatRoster(await store.read());
    case 'revoke':
    case 'forget': {
      if (!arg) throw new Error(DEVICES_USAGE);
      const found: { device: Device | null } = { device: null };
      const written = await store.update((roster) => {
        const result = action === 'revoke' ? revokeDevice(roster, arg, new Date()) : forgetDevice(roster, arg);
        found.device = result.device;
        return result.roster;
      });
      const { device } = found;
      if (!device) throw new Error(`no single device matches ${arg}; see perch devices, and name it by its full key if its id is shared`);
      if (action === 'forget') return `forgot ${device.id} (${sanitizeDeviceName(device.name)}); it can enrol again (a \`perch pair\` code, or the token while enrolment is on)`;
      const lines = [`revoked ${device.id} (${sanitizeDeviceName(device.name)}); this key stays refused until forgotten`];
      // The lost phone may also hold the token, which can enrol a fresh key while enrolment is on.
      if (enrolmentMode(written) === 'on') {
        lines.push('enrolment is on: whoever holds the token can still enrol a new key.');
        lines.push('Run `perch devices enrolment off`, or rotate the token, to stop that.');
      }
      return lines.join('\n');
    }
    case 'enrolment': {
      if (arg !== 'on' && arg !== 'off' && arg !== 'closed') throw new Error(DEVICES_USAGE);
      await store.update((roster) => withEnrolmentMode(roster, arg));
      return `enrolment: ${ENROLMENT_MODES[arg]}`;
    }
    default:
      throw new Error(DEVICES_USAGE);
  }
}

function formatRoster(roster: DeviceRoster): string {
  const day = (iso: string) => iso.slice(0, 10);
  const lines = [`enrolment: ${ENROLMENT_MODES[enrolmentMode(roster)]}`];
  for (const d of roster.devices) lines.push(`${d.id}  ${sanitizeDeviceName(d.name)}  enrolled ${day(d.enrolledAt)}  key ${d.x25519}`);
  for (const d of roster.revoked) lines.push(`${d.id}  ${sanitizeDeviceName(d.name)}  revoked ${day(d.revokedAt)}  key ${d.x25519}`);
  if (roster.devices.length + roster.revoked.length === 0) lines.push('no devices');
  const warning = policyWarning(relayPolicy(roster));
  if (warning) lines.push('', `warning: ${warning}`);
  return lines.join('\n');
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  run(process.argv.slice(2), process.env, homedir())
    .then((out) => {
      process.stdout.write(`${out}\n`);
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
