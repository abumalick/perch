import { randomBytes } from 'node:crypto';
import { homedir, hostname, userInfo } from 'node:os';
import { readFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, join as joinPath, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AgentConfig } from './infrastructure/config';
import { systemClock, systemPathResolver } from './infrastructure/system';
import { ShortWorkspaceIds } from './application/short-workspace-ids';
import { renameWorkspace } from './application/rename-workspace';
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
import { hooksFiles } from './infrastructure/hooks-files';
import { parseSetupFlags, planSetup, type PortOwner, type SetupState } from './application/setup-machine';
import { runSetup } from './application/run-setup';
import { serviceInstall } from './infrastructure/service-install';
import { tailscaleCli } from './infrastructure/tailscale-cli';
import { portOwner } from './infrastructure/port-owner';
import { answersUpgrade } from './infrastructure/listener-check';
import type { ServiceInstallPort } from './ports/service-install-port';
import type { TailscalePort } from './ports/tailscale-port';
import type { AgentServicePort } from './ports/agent-service-port';
import { loadOrCreateAgentKeys } from './infrastructure/agent-key-file';
import { FileDeviceStore } from './infrastructure/file-device-store';
import { enrolmentMode, forgetDevice, revokeDevice, withEnrolmentMode, type Device, type DeviceRoster, type EnrolmentMode } from './application/device-roster';
import encodeQR from 'qr';
import { deviceFingerprint, generatePairingSecret, isMachineUrl, MAX_ADDRESSES, parsePairingLink, sanitizeDeviceName } from '@perch/secure-channel';
import { parseEnvFile } from './application/agent-env';
import { mintPairingLink, pairingName } from './application/pairing-link';
import { PAIRING_TTL_MS } from './application/pairing';
import { FilePairingStore } from './infrastructure/file-pairing-store';
import { agentEnvFile, locateAgentEnv } from './infrastructure/agent-env-file';
import { agentService } from './infrastructure/agent-service';
import { FileStatusStore } from './infrastructure/file-status-store';
import { FileParkedStore } from './infrastructure/file-parked-store';
import { FsFileWriter } from './infrastructure/fs-file-writer';
import { fsResolveDirectory } from './infrastructure/fs-directory-checker';
import { spawnWorkspace } from './application/spawn-workspace';
import { sessionOfCodexThread, type AgentCli } from './application/agent-message';
import { loginShellResolver } from './infrastructure/installed-detector';
import type { CodexSpawnPort } from './ports/codex-spawn-port';
import { CodexAppServer } from './infrastructure/codex-app-server';
import { codexVersions } from './infrastructure/codex-versions';
import { formatWorkspaceTable } from './application/format-workspace-table';
import { isUnderPath, WORKSPACE_ROLES, workspaceRole, type WorkspaceRole } from './application/workspace-role';
import type { TmuxPort } from './ports/tmux-port';
import type { StatusStorePort } from './ports/status-store-port';

function wire(config: AgentConfig) {
  const tmux = new TmuxAdapter();
  const recent = new FileRecentStore(config.recentStorePath);
  const lister = new FsProjectLister();
  const hiddenFolders = new FileHiddenFoldersStore(config.hiddenFoldersPath);
  const repoRemote = new GitRepoRemote();
  const claudeSessions = new FileClaudeSessionsStore(config.claudeSessionsDir);
  return { tmux, recent, lister, hiddenFolders, repoRemote, claudeSessions };
}

// What `ls`, `spawn` and `peek` take from the process, injectable so tests reach no tmux server.
export interface CliIo {
  tmux?: TmuxPort;
  stdin?: () => Promise<string>;
  cwd?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  codex?: CodexSpawnPort;
  // Whether a command resolves through the login shell, as tmux will run it.
  resolveCommand?: (name: string) => Promise<boolean>;
  // What `setup` reads and changes outside agent.env and ~/.perch.
  setup?: {
    service?: ServiceInstallPort;
    tailscale?: TailscalePort;
    portOwner?: (port: number) => Promise<PortOwner>;
    restart?: AgentServicePort;
    checkListener?: (port: number) => Promise<boolean>;
  };
}

const HOOKS_DIR = joinPath(dirname(fileURLToPath(import.meta.url)), 'hooks');
const CODEX_NEXT_STEP = 'open Codex and trust the Perch hooks in /hooks; repeat after any hook change';

export async function run(argv: string[], env: NodeJS.ProcessEnv, home: string, io: CliIo = {}): Promise<string> {
  if (argv[0] === 'setup') return setup(argv.slice(1), env, home, io);
  if (argv[0] === 'connect' || argv[0] === 'relay-key' || (argv[0] === 'pair' && argv.includes('--relay'))) {
    throw new UsageError(RELAYS_GONE);
  }
  if (argv[0] === 'pair') return pair(argv.slice(1), env, home);
  if (argv[0] === 'ls' || argv[0] === 'spawn' || argv[0] === 'peek' || argv[0] === 'unpark' || argv[0] === 'rename' || argv[0] === 'send') {
    return orchestration(argv[0], argv.slice(1), env, home, io);
  }
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
          ids: new ShortWorkspaceIds({
            tmux,
            sessionPrefix: config.sessionPrefix,
            parked: new FileParkedStore(config.parkedStorePath),
            status: readOnlyStatus(config.statusStorePath),
            claudeSessions,
          }),
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
      const hooks = hooksFiles(home, HOOKS_DIR, config.port);
      const { codex } = await hooks.install();
      // Codex runs no hook until the user trusts it (keyed on a hash it does not document), so
      // that step stays with the user.
      if (!codex) return JSON.stringify({ installed: hooks.settingsPath, scriptPath: hooks.scriptPath });
      return JSON.stringify({
        installed: hooks.settingsPath,
        codexInstalled: hooks.codexHooksPath,
        codexNextStep: CODEX_NEXT_STEP,
        scriptPath: hooks.scriptPath,
      });
    }
    case 'devices':
      return devices(new FileDeviceStore(config.devicesPath), rest);
    default:
      throw new Error(`unknown command: ${command ?? '(none)'}`);
  }
}

const LS_USAGE = `usage: perch ls [--json] [--mine] [--parent <workspace id>] [--role ${WORKSPACE_ROLES.join('|')}] [--path <project dir>]`;
const SPAWN_USAGE = 'usage: perch spawn [--title <title>] [--child] [--model <model>] [--cli claude|codex|pi] <projectPath>   (brief on stdin)';
const SPAWN_CLIS: readonly AgentCli[] = ['claude', 'codex', 'pi'];
const PEEK_USAGE = 'usage: perch peek <workspace id> [-n <lines>]';
const UNPARK_USAGE = 'usage: perch unpark <workspace id>...';
const RENAME_USAGE = 'usage: perch rename [<workspace id>] <title>   (without an id: the workspace this runs in)';
const SEND_USAGE = 'usage: perch send <workspace id> "<message>"   (or the message on stdin)';

// `ls`, `spawn` and `peek` serve sessions in any repo, so none of them needs deploy/agent.env:
// it only lends the machine id, and the store paths come from $HOME.
async function orchestration(command: 'ls' | 'spawn' | 'peek' | 'unpark' | 'rename' | 'send', argv: string[], env: NodeJS.ProcessEnv, home: string, io: CliIo): Promise<string> {
  const values = await agentEnvValues(env).catch(() => ({}) as Record<string, string>);
  const config = loadConfig({ PERCH_MACHINE_ID: hostname().split('.')[0], ...env, ...values }, home);
  const tmux = io.tmux ?? new TmuxAdapter();
  const claudeSessions = new FileClaudeSessionsStore(config.claudeSessionsDir);
  const args = [...argv];
  const flag = (name: string) => {
    const at = args.indexOf(name);
    if (at !== -1) args.splice(at, 1);
    return at !== -1;
  };
  const list = async () => {
    const hidden = await new FileHiddenFoldersStore(config.hiddenFoldersPath).list();
    const status = readOnlyStatus(config.statusStorePath);
    const workspaces = await listWorkspaces({
      tmux,
      machineId: config.machineId,
      sessionPrefix: config.sessionPrefix,
      status,
      parked: new FileParkedStore(config.parkedStorePath),
      claudeSessions,
      messagedLast: { has: (id) => status.getMessagedLast(id) },
    });
    const shown = workspaces.filter((w) => !isHiddenPath(w.projectPath, hidden));
    return shown.map((w) => ({ ...w, role: workspaceRole(w, shown) }));
  };
  const table = (workspaces: Awaited<ReturnType<typeof list>>) =>
    formatWorkspaceTable(workspaces, { now: (io.now ?? Date.now)(), home });

  switch (command) {
    case 'ls': {
      const json = flag('--json');
      const mine = flag('--mine');
      const parent = takeOption(args, '--parent', LS_USAGE);
      const role = takeOption(args, '--role', LS_USAGE);
      const path = takeOption(args, '--path', LS_USAGE);
      if (args.length > 0 || (role !== undefined && !WORKSPACE_ROLES.includes(role as WorkspaceRole))) throw new Error(LS_USAGE);
      const of = mine ? await callerWorkspace(env, tmux, config.sessionPrefix) : parent;
      const given = path === undefined ? undefined : resolvePath(io.cwd ?? process.cwd(), path);
      // spawn stores the resolved folder, a workspace made from the phone the one it was given.
      const dirs = given === undefined ? undefined : [given, await realpath(given).catch(() => given)];
      const workspaces = (await list()).filter(
        (w) =>
          (of === undefined || w.parentId === of) &&
          (role === undefined || w.role === role) &&
          (dirs === undefined || dirs.some((dir) => isUnderPath(w.projectPath, dir))),
      );
      return json ? JSON.stringify(workspaces, null, 2) : table(workspaces);
    }
    case 'spawn': {
      const child = flag('--child');
      const title = takeOption(args, '--title', SPAWN_USAGE);
      const model = takeOption(args, '--model', SPAWN_USAGE);
      const cli = takeOption(args, '--cli', SPAWN_USAGE) ?? 'claude';
      const [projectPath, ...extra] = args;
      if (!projectPath || extra.length > 0 || projectPath.startsWith('--')) throw new Error(SPAWN_USAGE);
      if (!SPAWN_CLIS.includes(cli as AgentCli)) throw new Error(SPAWN_USAGE);
      const cwd = io.cwd ?? process.cwd();
      const resolveDirectory = fsResolveDirectory(cwd);
      if (!(await resolveDirectory(projectPath))) throw new Error(`not a directory: ${resolvePath(cwd, projectPath)}`);
      // Without it the pane's command fails at once and the workspace vanishes with no trace.
      if (cli === 'pi' && !(await (io.resolveCommand ?? loginShellResolver())('pi-reviewed'))) {
        throw new Error('perch spawn --cli pi needs pi-reviewed on PATH');
      }
      const parentId = child ? await callerWorkspace(env, tmux, config.sessionPrefix) : undefined;
      const brief = await (io.stdin ?? (() => readStdin("pass the brief on stdin, e.g. perch spawn <path> <<'EOF'")))();
      return spawnWorkspace(
        {
          tmux: withSpawnMethods(tmux),
          files: new FsFileWriter(),
          resolveDirectory,
          ids: new ShortWorkspaceIds({
            tmux,
            sessionPrefix: config.sessionPrefix,
            parked: new FileParkedStore(config.parkedStorePath),
            status: readOnlyStatus(config.statusStorePath),
            claudeSessions,
          }),
          nonce: () => randomBytes(6).toString('hex'),
          sleep: io.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
          spawnDir: joinPath(home, '.perch', 'spawn'),
          codex: io.codex ?? { versions: codexVersions(), createThread: (input) => new CodexAppServer().createThread(input) },
        },
        {
          projectPath,
          brief,
          cli: cli as AgentCli,
          ...(model ? { model } : {}),
          ...(title ? { title } : {}),
          ...(parentId ? { parent: { id: parentId } } : {}),
        },
      );
    }
    case 'peek': {
      const n = takeOption(args, '-n', PEEK_USAGE);
      const lines = n === undefined ? 40 : Number(n);
      const [id, ...extra] = args;
      if (!id || extra.length > 0 || !Number.isInteger(lines) || lines < 1) throw new Error(PEEK_USAGE);
      const workspace = (await list()).find((w) => w.id === id);
      if (!workspace) throw new Error(`no workspace ${id} (see perch ls)`);
      if (workspace.status === 'parked') {
        return `${table([workspace])}\n\n(parked: no pane until it is opened)`;
      }
      if (!tmux.capturePane) throw new Error('this tmux adapter cannot capture a pane');
      // History beyond N rows, since a full-screen UI leaves many of its rows blank.
      const text = await tmux.capturePane(id, lines * 4);
      const tail = text.split('\n').filter((line) => line.trim().length > 0).slice(-lines);
      return [table([workspace]), '', ...tail].join('\n');
    }
    case 'unpark': {
      if (args.length === 0 || args.some((id) => id.startsWith('-'))) throw new Error(UNPARK_USAGE);
      const post = agentPost(config.port, home, io.fetch ?? fetch);
      const lines: string[] = [];
      let failed = false;
      for (const id of args) {
        const { status, json } = await post('/unpark', { id });
        const result = json.result;
        if (status !== 200 || typeof result !== 'string') {
          throw new Error(`${id}: the agent answered ${status}${json.error ? ` (${json.error})` : ''}`);
        }
        failed ||= result !== 'unparked';
        lines.push(`${id}: ${UNPARK_WORDS[result] ?? result}`);
      }
      if (failed) throw new Error(lines.join('\n'));
      return lines.join('\n');
    }
    case 'send': {
      const [to, message, ...extra] = args;
      if (!to || to.startsWith('-') || extra.length > 0 || args.some((a) => a === '-f' || a === '--file' || a.startsWith('--file='))) {
        throw new Error(SEND_USAGE);
      }
      // Codex under its daemon runs this outside the pane, with a stale TMUX_PANE or none; its
      // thread id names the sender instead.
      const codexThread = env.CODEX_THREAD_ID || undefined;
      const pane = env.TMUX_PANE ?? '';
      if (!pane && !codexThread) throw new Error('not inside a Perch workspace: $TMUX_PANE is unset');
      const body = message ?? (await (io.stdin ?? (() => readStdin(`pass the message as an argument or on stdin: ${SEND_USAGE}`)))());
      const { status, json } = await agentPost(config.port, home, io.fetch ?? fetch)('/message', {
        pane,
        pid: process.pid,
        to,
        body,
        ...(codexThread ? { codexThread } : {}),
      });
      if (status === 200 && json.result === 'delivered') return `delivered to ${to}`;
      if (status === 200 && json.result === 'refused' && typeof json.reason === 'string') throw new Error(json.reason);
      throw new Error(`the agent answered ${status}${status === 404 ? ' (it predates perch send: restart it)' : ''}${json.error ? ` (${json.error})` : ''}`);
    }
    case 'rename': {
      if (args.length === 0) throw new Error(RENAME_USAGE);
      // A first word naming a workspace is its id; otherwise every word is the title. One shaped
      // like an id that names nothing is refused, not taken into the caller's title.
      const named = args.length > 1 && (await list()).some((w) => w.id === args[0]);
      if (args.length > 1 && !named && /^[a-z0-9_][a-z0-9_-]*-(?:\d+|[0-9a-f]{6})$/.test(args[0]!)) {
        throw new Error(`no workspace ${args[0]} (see perch ls), or quote the title: perch rename "${args.join(' ')}"`);
      }
      const id = named ? args[0]! : await callerWorkspace(env, tmux, config.sessionPrefix);
      const title = (named ? args.slice(1) : args).join(' ');
      const { locked } = await renameWorkspace(
        { tmux: withSpawnMethods(tmux), parked: new FileParkedStore(config.parkedStorePath) },
        id,
        title,
      );
      const done = `${id}: renamed to "${title.trim()}"`;
      return locked ? done : `${done} (this tmux cannot lock a title, so Claude may rename it again)`;
    }
  }
}

const UNPARK_WORDS: Record<string, string> = {
  unparked: 'opened',
  'not-parked': 'not parked',
  'missing-directory': 'its project directory no longer exists',
};

// `unpark` and `send` go through the running agent, the one process that writes status.json (it
// holds it in memory, so a write from here would be overwritten) and parked.json, and the one
// that tells the phones. It authenticates with the hooks secret the agent writes at each start.
function agentPost(port: number, home: string, fetchFn: typeof fetch) {
  const notRunning = `the Perch agent is not running (nothing answered on 127.0.0.1:${port})`;
  let token: Promise<string> | undefined;
  return async (route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
    token ??= readFile(joinPath(home, '.perch', 'token'), 'utf8').then(
      (text) => text.trim(),
      () => {
        throw new Error(`${notRunning}: no ${joinPath(home, '.perch', 'token')}`);
      },
    );
    const secret = await token;
    let res: Response;
    try {
      res = await fetchFn(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(notRunning);
    }
    if (res.status === 401) throw new Error('the agent refused the hooks secret: was it restarted since ~/.perch/token was read?');
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, json };
  };
}

// The workspace the caller's own pane belongs to. Targeted at $TMUX_PANE: an untargeted
// display-message answers for whichever session was most recently active. Codex under its daemon
// runs tools outside the pane with a stale TMUX_PANE, so its thread names the caller instead.
async function callerWorkspace(env: NodeJS.ProcessEnv, tmux: TmuxPort, sessionPrefix: string): Promise<string> {
  const thread = env.CODEX_THREAD_ID;
  if (thread) {
    const session = sessionOfCodexThread(await tmux.listSessions(sessionPrefix), thread);
    if (!session) throw new Error(`not inside a Perch workspace: no workspace records Codex thread ${thread}`);
    return session.name;
  }
  const pane = env.TMUX_PANE;
  if (!pane) throw new Error('not inside a Perch workspace: $TMUX_PANE is unset');
  const session = tmux.sessionOfPane ? await tmux.sessionOfPane(pane) : null;
  const ours = session !== null && (await tmux.listSessions(sessionPrefix)).some((s) => s.name === session);
  if (!session || !ours) {
    throw new Error(`not inside a Perch workspace: this pane's tmux session is ${session ?? 'unknown'}`);
  }
  return session;
}

function withSpawnMethods(tmux: TmuxPort) {
  const { setPaneTitle } = tmux;
  if (!setPaneTitle) throw new Error('this tmux adapter cannot set a pane title');
  return {
    createSession: tmux.createSession.bind(tmux),
    hasSession: tmux.hasSession.bind(tmux),
    setPaneTitle: setPaneTitle.bind(tmux),
    supportsTitleLock: tmux.supportsTitleLock?.bind(tmux),
    lockPaneTitle: tmux.lockPaneTitle?.bind(tmux),
  };
}

// Read-only: nothing here ever calls set or prune, so the agent's file is never rewritten. A
// file that cannot be read at all (a directory, no permission) reads as no statuses.
function readOnlyStatus(path: string): Pick<StatusStorePort, 'get' | 'getChangedAt' | 'getUrgent' | 'getMessagedLast' | 'ids'> {
  try {
    return new FileStatusStore(path);
  } catch {
    return { get: () => undefined, getChangedAt: () => undefined, getUrgent: () => false, getMessagedLast: () => false, ids: () => [] };
  }
}

async function readStdin(ttyError: string): Promise<string> {
  if (process.stdin.isTTY) throw new Error(ttyError);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const RELAYS_GONE = 'relays are gone: perch setup sets a machine up for phones, and perch pair pairs one';
const PAIR_USAGE = 'usage: perch pair [--pwa <PWA origin>] [--ttl <minutes, 1-10, default 10>]';

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

// `perch pair` reads the agent.env the service reads rather than expecting it in the shell's
// environment.
async function pair(argv: string[], env: NodeJS.ProcessEnv, home: string): Promise<string> {
  const args = [...argv];
  const config = loadConfig({ ...env, ...(await agentEnvValues(env)) }, home);
  let origin = pwaOrigin(takeOption(args, '--pwa', PAIR_USAGE));
  const ttl = takeOption(args, '--ttl', PAIR_USAGE) ?? String(PAIRING_TTL_MS / 60_000);
  const minutes = Number(ttl);
  if (!/^\d+$/.test(ttl) || minutes < 1 || minutes * 60_000 > PAIRING_TTL_MS) throw new Error(`--ttl takes whole minutes from 1 to ${PAIRING_TTL_MS / 60_000} (got ${ttl})`);
  if (args.length > 0) throw new Error(PAIR_USAGE);
  try {
    origin ??= pwaOrigin(config.pwaOrigin)!;
  } catch {
    throw new Error(`PERCH_PWA_ORIGIN in agent.env must be the http(s) origin phones open the app at (got ${config.pwaOrigin})`);
  }
  if (config.phoneAddresses.length === 0) {
    throw new Error('this machine has no PERCH_PHONE_ADDRESSES: run perch setup first (perch setup --help)');
  }
  const bad = config.phoneAddresses.find((url) => !isMachineUrl(url));
  if (bad) throw new Error(`PERCH_PHONE_ADDRESSES holds ${bad}, which a phone refuses: wss://<host>[:port][/<slug>] (run perch setup)`);
  if (config.phoneAddresses.length > MAX_ADDRESSES) throw new Error(`PERCH_PHONE_ADDRESSES holds more than ${MAX_ADDRESSES} addresses`);
  const link = await mintPairingLink(
    {
      keys: await loadOrCreateAgentKeys(config.agentKeyPath),
      machineId: pairingName(config.machineId, hostname()),
      ...(config.defaultPath ? { defaultPath: config.defaultPath } : {}),
      pairings: new FilePairingStore(config.pairingPath),
      newSecret: generatePairingSecret,
      now: () => new Date(),
      ttlMs: minutes * 60_000,
    },
    { phoneUrls: config.phoneAddresses, pwaOrigin: origin },
  );
  return pairingInstructions(link, minutes);
}

export class UsageError extends Error {
  readonly exitCode = 2;
}

export const SETUP_USAGE = `usage: perch setup --machine-id <id> --project-roots <dir,dir> [options]

Sets this machine up as a Perch agent, without prompting: deploy/agent.env (backed up first), the
agent key, a new device roster that admits pairing codes only (an existing one is kept), the service started at boot (systemd
user unit with linger, or launchd), the Claude Code hooks, and optionally a Tailscale address for
phones. Rerunning it with the same flags changes nothing. It refuses rather than replace anything
it did not make (an agent key, a token, another tailscale serve entry).

  --machine-id <id>             the name phones show for this machine
  --project-roots <dir,dir>     absolute folders new workspaces may be made in
  --default-path <dir>          where a phone resolves relative paths (in pairing links)
  --phone-port <n>              loopback port phones reach (default 8797); every Linux user on one
                                machine needs their own, e.g. 8797 and 8798
  --tailscale serve|funnel|none publish the phone port on the tailnet (serve), also on the public
                                internet (funnel), or not at all (none, the default)
  --tailscale-port <n>          the HTTPS port Tailscale serves it on (default 443 for serve, 10000
                                for funnel; Funnel allows only 443, 8443 and 10000)
  --slug <name>                 serve under /<name>, so several agents share one port
  --address <wss-url>           another address phones try, after the Tailscale one (repeatable,
                                4 in all), e.g. a reverse proxy
  --pwa <origin>                where phones open the app (default https://tarfa.app; an existing
                                PERCH_PWA_ORIGIN is kept unless this is given)
  --token-enrolment on|off      let PERCH_TOKEN enrol phones (off by default on a new roster)
  --pair                        print a pairing link and QR code at the end
  --dry-run                     print the plan and the Tailscale checks; change nothing

Tailscale, once per node:
  1. Install Tailscale and run \`tailscale up\`.
  2. In the admin console (DNS page): turn on MagicDNS and HTTPS certificates.
  3. For --tailscale funnel: give the node the funnel attribute in the policy file, e.g.
       "nodeAttrs": [{ "target": ["<you or the node's tag>"], "attr": ["funnel"] }]
     Funnel serves only ports 443, 8443 and 10000.
  4. If Tailscale says it needs root, make yourself its operator once:
       sudo tailscale set --operator=$USER
Several agents on one node (one per Linux user) share a Tailscale port, each under its own --slug.
The node has one operator: a second user runs \`--tailscale none --slug <name> --address <url>\`
with their own --phone-port, and setup prints the \`tailscale serve\` line for the operator to run:
on the port of that --address (or --tailscale-port), as \`tailscale funnel\` when the port is already
on Funnel. Setup refuses to give phones an address while token enrolment is on, until
--token-enrolment says which way. Run as another user (sudo -u), set XDG_RUNTIME_DIR=/run/user/<uid>.

Example:
  perch setup --machine-id dev --project-roots ~/workspace --tailscale funnel --slug me --pair`;

async function setup(argv: string[], env: NodeJS.ProcessEnv, home: string, io: CliIo): Promise<string> {
  if (argv.includes('--help') || argv.includes('-h')) return SETUP_USAGE;
  const flags = parseSetupFlags(argv);
  if ('error' in flags) throw new UsageError(`${flags.error}\n\n${SETUP_USAGE.split('\n')[0]}\n(perch setup --help for every option)`);

  const envPath = await locateAgentEnv(env);
  // The checkout the service runs: the one whose deploy/ holds agent.env.
  const repo = resolvePath(dirname(envPath), '..');
  const envText = await readFile(envPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  const config = loadConfig({ ...parseEnvFile(envText ?? ''), PERCH_MACHINE_ID: flags.machineId }, home);
  const fx = io.setup ?? {};
  const service = fx.service ?? serviceInstall({ repo, home, user: userInfo().username, uid: process.getuid?.() ?? 0 });
  const tailscale = fx.tailscale ?? tailscaleCli();
  const owner = fx.portOwner ?? portOwner;
  const hooks = hooksFiles(home, HOOKS_DIR, config.port);
  const devices = new FileDeviceStore(config.devicesPath);
  const hasRoster = await readFile(config.devicesPath).then(() => true, () => false);

  const state: SetupState = {
    repo,
    service: { kind: service.kind, template: await service.template(), installed: await service.installed(), enabled: await service.enabled() },
    envText,
    newToken: randomBytes(32).toString('hex'),
    hasKey: await readFile(config.agentKeyPath).then(() => true, () => false),
    roster: hasRoster ? enrolmentMode(await devices.read()) : 'absent',
    hooksCurrent: await hooks.current(),
    phonePortOwner: await owner(flags.phonePort),
    hooksPortOwner: await owner(config.port),
    tailscale: flags.tailscale === 'none' ? null : await tailscale.status(),
    // Under --tailscale none, read only to word the operator's line: unreadable means the serve form.
    serve: flags.tailscale === 'none' && !flags.slug ? null : await tailscale.serveStatus(),
  };
  const plan = planSetup(flags, state);
  if ('error' in plan) throw new Error(plan.error);

  const envFile = agentEnvFile(envPath);
  const result = await runSetup(
    plan,
    {
      envPath,
      writeEnv: (text) => envFile.write(text),
      createKey: async () => {
        await loadOrCreateAgentKeys(config.agentKeyPath);
      },
      writeRoster: async (mode) => {
        await mkdir(dirname(config.devicesPath), { recursive: true, mode: 0o700 });
        await devices.update((roster) => withEnrolmentMode(roster, mode));
      },
      installUnit: (text) => service.install(text),
      installHooks: async () => {
        const { codex } = await hooks.install();
        if (codex) process.stderr.write(`${CODEX_NEXT_STEP}\n`);
      },
      serve: (entry) => tailscale.serve(entry),
      restart: () => (fx.restart ?? agentService()).restart(),
      checkListener: fx.checkListener ?? ((port) => answersUpgrade(port)),
      pair: () => pair([], env, home),
    },
    { dryRun: flags.dryRun, phonePort: flags.phonePort },
  );
  if (!result.ok) throw new Error(result.lines.join('\n'));
  return result.lines.join('\n');
}

function pairingInstructions(link: string, minutes = PAIRING_TTL_MS / 60_000): string {
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
    `It works once, for ${minutes} minute${minutes === 1 ? '' : 's'}. \`perch pair\` makes another.`,
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

// The phones this agent accepts. A running agent picks up a change within seconds, and closes a
// revoked phone's sessions.
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
      process.exitCode = err instanceof UsageError ? err.exitCode : 1;
    });
}
