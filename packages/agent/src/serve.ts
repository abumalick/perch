import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeVoice } from './application/claude-voice';
import { AplayVoicePlayer, FileClaudeSettings, LOOPBACK_DEVICE, aplayArgs } from './infrastructure/aplay-voice-player';
import { loadConfig, assertServerConfig, configWarnings, withLegacyEnv } from './infrastructure/config';
import { migrateStateDir } from './infrastructure/state-dir';
import { systemClock, systemPathResolver } from './infrastructure/system';
import { ShortWorkspaceIds } from './application/short-workspace-ids';
import { TmuxAdapter } from './infrastructure/tmux-adapter';
import { FileRecentStore } from './infrastructure/file-recent-store';
import { FileHiddenFoldersStore } from './infrastructure/file-hidden-folders-store';
import { FileLaunchersStore } from './infrastructure/file-launchers-store';
import { detectInstalled, loginShellResolver } from './infrastructure/installed-detector';
import { FileKeytermsStore } from './infrastructure/file-keyterms-store';
import { FileClaudeSessionsStore } from './infrastructure/file-claude-sessions-store';
import { ProcSystemStats } from './infrastructure/proc-system-stats';
import { SystemdScopeReaper } from './infrastructure/systemd-scope-reaper';
import { FileClientLogStore } from './infrastructure/file-client-log-store';
import { FileHookEventLog } from './infrastructure/file-hook-event-log';
import { FileMessageLog } from './infrastructure/file-message-log';
import { ProcAncestry } from './infrastructure/proc-ancestry';
import { CompositeDelivery } from './infrastructure/composite-delivery';
import { ClaudeInboxDelivery } from './infrastructure/claude-inbox-delivery';
import { PiInboxDelivery } from './infrastructure/pi-inbox-delivery';
import { CodexAppServer } from './infrastructure/codex-app-server';
import { CodexDelivery } from './infrastructure/codex-delivery';
import { FileWorkspaceLogStore } from './infrastructure/file-workspace-log-store';
import { FileParkedStore } from './infrastructure/file-parked-store';
import { reconcileAtStartup } from './application/startup-reconcile';
import { FileLiveSnapshotStore } from './infrastructure/file-live-snapshot-store';
import { FsProjectLister } from './infrastructure/fs-project-lister';
import { FsFileReader } from './infrastructure/fs-file-reader';
import { FsFileWriter } from './infrastructure/fs-file-writer';
import { fsIsDirectory } from './infrastructure/fs-directory-checker';
import { NodePtyAdapter } from './infrastructure/node-pty-adapter';
import { FileStatusStore } from './infrastructure/file-status-store';
import { FsBrowserDiscovery } from './infrastructure/fs-browser-discovery';
import { GitRepoRemote } from './infrastructure/git-repo-remote';
import { AgentBrowserCli } from './infrastructure/agent-browser-cli';
import { connectBrowserUpstream } from './infrastructure/ws-browser-stream-socket';
import { WsServer } from './server/ws-server';
import { startDeviceGate } from './server/device-gate-wiring';
import { startPhoneListener } from './infrastructure/phone-listener';
import { PhoneAdmission } from './application/phone-admission';
import { DiskReadLimiter } from './application/disk-read-limiter';
import { loadOrCreateAgentKeys } from './infrastructure/agent-key-file';
import { FileDeviceStore } from './infrastructure/file-device-store';
import { FilePairingStore } from './infrastructure/file-pairing-store';
import { writeHookToken } from './infrastructure/token-file';
import { assertPrivateFiles, securePrivateDir } from './infrastructure/private-dir';
import { ensureUtf8Locale } from './infrastructure/ensure-utf8-locale';
import { locateAgentEnv } from './infrastructure/agent-env-file';

const ROSTER_POLL_MS = 3000;

async function main(): Promise<void> {
  ensureUtf8Locale(process.env);
  // Before anything reads the state: ~/.perch becomes ~/.tarfa, and the agent key its new name.
  if ((await migrateStateDir(homedir())) === 'moved') {
    process.stdout.write(`tarfa agent: moved ~/.perch to ~/.tarfa (~/.perch is now a link to it)\n`);
  }
  const env = withLegacyEnv(process.env);
  const config = loadConfig(env, homedir());
  assertServerConfig(config);
  for (const warning of configWarnings(process.env)) process.stderr.write(`${warning}\n`);
  // Refused before anything is served: a secret another user can read is a leaked secret.
  await securePrivateDir(config.stateDir);
  await assertPrivateFiles([
    config.agentKeyPath,
    config.devicesPath,
    config.pairingPath,
    join(config.stateDir, 'token'),
    // It holds TARFA_TOKEN, which enrols a phone.
    await locateAgentEnv(env),
  ]);
  const hookToken = await writeHookToken(config.stateDir);
  const tmux = new TmuxAdapter();
  const status = new FileStatusStore(config.statusStorePath);
  const parked = new FileParkedStore(config.parkedStorePath);
  const liveSnapshot = new FileLiveSnapshotStore(config.liveSnapshotPath);
  const workspaceLog = new FileWorkspaceLogStore(config.workspaceLogPath);
  const claudeSessions = new FileClaudeSessionsStore(config.claudeSessionsDir);
  await reconcileAtStartup({
    tmux,
    snapshot: liveSnapshot,
    parked,
    status,
    workspaceLog,
    clock: systemClock,
    machineId: config.machineId,
    sessionPrefix: config.sessionPrefix,
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const server = new WsServer({
    config,
    hookToken,
    tmux,
    recent: new FileRecentStore(config.recentStorePath),
    lister: new FsProjectLister(),
    reader: new FsFileReader(),
    resolvePath: systemPathResolver,
    isDirectory: fsIsDirectory,
    clock: systemClock,
    ids: new ShortWorkspaceIds({ tmux, sessionPrefix: config.sessionPrefix, parked, status, claudeSessions }),
    pty: new NodePtyAdapter(),
    status,
    writer: new FsFileWriter(),
    browserDiscovery: new FsBrowserDiscovery(),
    browserCommands: new AgentBrowserCli(),
    hiddenFolders: new FileHiddenFoldersStore(config.hiddenFoldersPath),
    launchers: new FileLaunchersStore(config.launchersPath),
    detectInstalled: (names) => detectInstalled(names, loginShellResolver()),
    keyterms: new FileKeytermsStore(config.keytermsPath),
    clientLog: new FileClientLogStore(config.clientLogPath),
    hookEventLog: new FileHookEventLog(config.hookEventLogPath),
    messaging: {
      ancestry: new ProcAncestry(),
      delivery: new CompositeDelivery({
        claude: new ClaudeInboxDelivery(claudeSessions, async (id) => (await tmux.firstPaneId?.(id)) ?? null),
        pi: new PiInboxDelivery(config.inboxDir),
        codex: new CodexDelivery(new CodexAppServer()),
      }),
      log: new FileMessageLog(config.messageLogPath),
    },
    workspaceLog,
    parked,
    liveSnapshot,
    connectUpstream: connectBrowserUpstream,
    repoRemote: new GitRepoRemote(),
    claudeSessions,
    scopes: new SystemdScopeReaper(),
    ...(config.stats === false ? {} : { systemStats: new ProcSystemStats() }),
    claudeVoice:
      process.platform === 'linux'
        ? new ClaudeVoice({
            player: new AplayVoicePlayer('aplay', aplayArgs(config.voiceDevice ?? LOOPBACK_DEVICE)),
            settings: new FileClaudeSettings(join(homedir(), '.claude', 'settings.json')),
          })
        : undefined,
  });
  await server.start();
  process.stdout.write(`tarfa agent: hooks on 127.0.0.1:${server.address().port}\n`);
  // The agent key exists from the first start, so `tarfa pair` works on a fresh machine.
  const keys = await loadOrCreateAgentKeys(config.agentKeyPath);
  const log = (message: string) => process.stdout.write(`${message}\n`);
  const gate = startDeviceGate({
    keys,
    server,
    store: new FileDeviceStore(config.devicesPath),
    pairings: new FilePairingStore(config.pairingPath),
    log,
    rosterPollMs: ROSTER_POLL_MS,
  });
  // A port another agent on this machine already holds (a second Linux user left on the default)
  // must not crash-loop this one: it goes on without its phone port, and says so.
  try {
    const phones = await startPhoneListener({
      port: config.phonePort,
      gate,
      server,
      admission: new PhoneAdmission({ now: () => Date.now() }),
      limiter: new DiskReadLimiter(() => Date.now()),
      log,
    });
    log(`tarfa agent: phones on 127.0.0.1:${phones.port}`);
    if (config.phoneAddresses.length > 0) log(`tarfa agent: phone addresses ${config.phoneAddresses.join(', ')}`);
  } catch (err) {
    process.stderr.write(
      `tarfa agent: no phone port: 127.0.0.1:${config.phonePort} ${err instanceof Error ? err.message : String(err)}; set TARFA_PHONE_PORT in deploy/agent.env\n`,
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
