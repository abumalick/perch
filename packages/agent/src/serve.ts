import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, assertServerConfig, configWarnings } from './infrastructure/config';
import { systemClock, RandomIdGenerator, systemPathResolver } from './infrastructure/system';
import { TmuxAdapter } from './infrastructure/tmux-adapter';
import { FileRecentStore } from './infrastructure/file-recent-store';
import { FileHiddenFoldersStore } from './infrastructure/file-hidden-folders-store';
import { FileCommandsStore } from './infrastructure/file-commands-store';
import { FileLaunchersStore } from './infrastructure/file-launchers-store';
import { detectInstalled, loginShellResolver } from './infrastructure/installed-detector';
import { FileKeytermsStore } from './infrastructure/file-keyterms-store';
import { FileClaudeSessionsStore } from './infrastructure/file-claude-sessions-store';
import { ProcSystemStats } from './infrastructure/proc-system-stats';
import { SystemdScopeReaper } from './infrastructure/systemd-scope-reaper';
import { FileClientLogStore } from './infrastructure/file-client-log-store';
import { FileHookEventLog } from './infrastructure/file-hook-event-log';
import { FileWorkspaceLogStore } from './infrastructure/file-workspace-log-store';
import { FileParkedStore } from './infrastructure/file-parked-store';
import { reconcileParked } from './application/reconcile-parked';
import { trackLiveWorkspaces } from './application/track-live-workspaces';
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
import { startRelayLinks } from './server/relay-wiring';
import { wsRelayTransport } from './infrastructure/ws-relay-transport';
import { frameSocketTransport } from './infrastructure/ws-frame-socket';
import { loadOrCreateRelayKeys } from './infrastructure/relay-key-file';
import { FileDeviceStore } from './infrastructure/file-device-store';
import { FilePairingStore } from './infrastructure/file-pairing-store';
import { writeHookToken } from './infrastructure/token-file';
import { assertPrivateFiles, securePrivateDir } from './infrastructure/private-dir';
import { ensureUtf8Locale } from './infrastructure/ensure-utf8-locale';
import { locateAgentEnv } from './infrastructure/agent-env-file';

const ROSTER_POLL_MS = 3000;

async function main(): Promise<void> {
  ensureUtf8Locale(process.env);
  const config = loadConfig(process.env, homedir());
  assertServerConfig(config);
  for (const warning of configWarnings(process.env)) process.stderr.write(`${warning}\n`);
  // Refused before anything is served: a secret another user can read is a leaked secret.
  await securePrivateDir(join(homedir(), '.perch'));
  await assertPrivateFiles([
    config.relayKeyPath,
    config.devicesPath,
    config.pairingPath,
    join(homedir(), '.perch', 'token'),
    // It holds PERCH_TOKEN, which enrols a phone.
    await locateAgentEnv(process.env),
  ]);
  const hookToken = await writeHookToken(homedir());
  const tmux = new TmuxAdapter();
  const status = new FileStatusStore(config.statusStorePath);
  const parked = new FileParkedStore(config.parkedStorePath);
  const liveSnapshot = new FileLiveSnapshotStore(config.liveSnapshotPath);
  const workspaceLog = new FileWorkspaceLogStore(config.workspaceLogPath);
  // Parks the workspaces lost with the tmux server (a reboot, a stray `pkill`) while their
  // status entries, and so their session ids, still exist. Before reconcileParked, which then
  // kills any bare shell tmux-resurrect put back under a now-parked id.
  // Best-effort: failing to recover must never keep the agent from starting.
  try {
    const recovered = await trackLiveWorkspaces({
      tmux,
      snapshot: liveSnapshot,
      parked,
      status,
      workspaceLog,
      clock: systemClock,
      machineId: config.machineId,
      sessionPrefix: config.sessionPrefix,
    });
    if (recovered.length > 0) {
      process.stdout.write(`perch agent: parked ${recovered.length} workspace(s) lost with the tmux server\n`);
    }
  } catch (err) {
    process.stderr.write(`perch agent: could not check for lost workspaces: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  // Kill any tmux session tmux-continuum resurrected under a parked workspace's id, so the
  // parked record stays the single source of truth. Must run before prune/list below.
  await reconcileParked({ parked, tmux, sessionPrefix: config.sessionPrefix });
  const sessions = await tmux.listSessions(config.sessionPrefix);
  const parkedIds = (await parked.list()).map((p) => p.id);
  // Parked workspaces have no live session, so their status entries must be preserved
  // explicitly or prune would drop them.
  status.prune([...sessions.map((s) => s.name), ...parkedIds]);
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
    ids: new RandomIdGenerator(),
    pty: new NodePtyAdapter(),
    status,
    writer: new FsFileWriter(),
    browserDiscovery: new FsBrowserDiscovery(),
    browserCommands: new AgentBrowserCli(),
    hiddenFolders: new FileHiddenFoldersStore(config.hiddenFoldersPath),
    commands: new FileCommandsStore(config.commandsPath),
    launchers: new FileLaunchersStore(config.launchersPath),
    detectInstalled: (names) => detectInstalled(names, loginShellResolver()),
    keyterms: new FileKeytermsStore(config.keytermsPath),
    clientLog: new FileClientLogStore(config.clientLogPath),
    hookEventLog: new FileHookEventLog(config.hookEventLogPath),
    workspaceLog,
    parked,
    liveSnapshot,
    connectUpstream: connectBrowserUpstream,
    repoRemote: new GitRepoRemote(),
    claudeSessions: new FileClaudeSessionsStore(config.claudeSessionsDir),
    scopes: new SystemdScopeReaper(),
    systemStats: new ProcSystemStats(),
  });
  await server.start();
  process.stdout.write(`perch agent: hooks on 127.0.0.1:${server.address().port}\n`);
  if (config.relayUrls.length > 0) {
    const keys = await loadOrCreateRelayKeys(config.relayKeyPath);
    const log = (message: string) => process.stdout.write(`${message}\n`);
    const relays = startRelayLinks({
      config,
      keys,
      server,
      store: new FileDeviceStore(config.devicesPath),
      pairings: new FilePairingStore(config.pairingPath),
      transport: frameSocketTransport(wsRelayTransport),
      log,
      rosterPollMs: ROSTER_POLL_MS,
    });
    log(`relay account ${relays.account}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
