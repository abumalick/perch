import { constantTimeEqual } from '@perch/secure-channel';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { NoiseClientConnection, type NoiseClientConnectionOptions } from './noise-client-connection';
import type { FrameSocket } from '../ports/frame-socket';
import type { ClientConnection } from '../ports/client-connection';
import type { AddressInfo } from 'node:net';
import type { AgentConfig } from '../infrastructure/config';
import type { TmuxPort } from '../ports/tmux-port';
import type { RecentStorePort } from '../ports/recent-store-port';
import type { ProjectListerPort } from '../ports/project-lister-port';
import type { FileReaderPort } from '../ports/file-reader-port';
import type { PathResolver } from '../ports/path-resolver';
import type { DirectoryChecker } from '../ports/directory-checker';
import type { Clock } from '../ports/clock';
import type { IdGenerator } from '../ports/id-generator';
import type { PtyPort } from '../ports/pty-port';
import type { StatusStorePort } from '../ports/status-store-port';
import type { RepoRemotePort } from '../ports/repo-remote-port';
import type { ClaudeSessionsPort } from '../ports/claude-sessions-port';
import type { FileWriterPort } from '../ports/file-writer-port';
import type { BrowserDiscoveryPort } from '../ports/browser-discovery-port';
import type { BrowserCommandPort } from '../ports/browser-command-port';
import type { ConnectUpstream } from '../ports/browser-stream-port';
import type { HiddenFoldersPort } from '../ports/hidden-folders-port';
import type { CommandsPort } from '../ports/commands-port';
import type { LaunchersPort } from '../ports/launchers-port';
import type { KeytermsPort } from '../ports/keyterms-port';
import type { ClientLogPort } from '../ports/client-log-port';
import type { WorkspaceLogPort } from '../ports/workspace-log-port';
import type { ParkedStorePort } from '../ports/parked-store-port';
import type { LiveSnapshotPort } from '../ports/live-snapshot-port';
import type { ProcessScopePort } from '../ports/process-scope-port';
import type { SystemStatsPort } from '../ports/system-stats-port';
import { recordWorkspaceClosed } from '../application/record-workspace-closed';
import { trackLiveWorkspaces } from '../application/track-live-workspaces';
import type { Workspace } from '@perch/contracts';
import { ConnectionHandler } from './connection-handler';
import { ViewerRegistry } from './viewer-registry';
import { applyHookEvent } from '../application/apply-hook-event';
import { listWorkspaces } from '../application/list-workspaces';
import { isHiddenPath } from '../application/is-hidden-path';
import { closeWorkspaceBrowserSessions } from '../application/close-workspace-browsers';

export interface WsServerDeps {
  config: AgentConfig;
  // The secret `POST /hooks` takes (`~/.perch/token`, written for perch-hook.sh at startup). Not
  // PERCH_TOKEN: that one enrols phones, and a hook's secret is within reach of other local users
  // in ways a phone's credential must not be. Without it, no hook is accepted.
  hookToken?: string;
  tmux: TmuxPort;
  recent: RecentStorePort;
  lister: ProjectListerPort;
  reader: FileReaderPort;
  resolvePath: PathResolver;
  isDirectory: DirectoryChecker;
  clock: Clock;
  ids: IdGenerator;
  pty: PtyPort;
  status: StatusStorePort;
  writer: FileWriterPort;
  browserDiscovery: BrowserDiscoveryPort;
  browserCommands: BrowserCommandPort;
  hiddenFolders: HiddenFoldersPort;
  commands: CommandsPort;
  launchers: LaunchersPort;
  detectInstalled: (names: string[]) => Promise<string[]>;
  keyterms: KeytermsPort;
  clientLog: ClientLogPort;
  workspaceLog: WorkspaceLogPort;
  parked: ParkedStorePort;
  // Optional: where the live workspaces are snapshotted so those lost with their tmux server
  // come back parked (trackLiveWorkspaces). Without it nothing is recovered.
  liveSnapshot?: LiveSnapshotPort;
  connectUpstream: ConnectUpstream;
  repoRemote?: RepoRemotePort;
  claudeSessions?: ClaudeSessionsPort;
  scopes?: ProcessScopePort;
  // Absent on a platform with no collector: the agent then never sends `stats` and the
  // PWA shows no load strip for this machine.
  systemStats?: SystemStatsPort;
  titlePollMs?: number;
  statsPollMs?: number;
}

const DEFAULT_TITLE_POLL_MS = 2000;
// Load readings are ambient information, not a signal anyone acts on within seconds, so
// they run on their own slower interval rather than riding the title poll.
const DEFAULT_STATS_POLL_MS = 5000;

// Phones reach the agent only through the relays it dials out to. The one thing it listens for
// is Claude Code's hooks, from this machine, so the listener is bound to loopback whatever the
// environment says.
const LOOPBACK = '127.0.0.1';

// A hook event is a few kilobytes of JSON (Claude Code's hook input, no transcript); a body past
// this is refused rather than buffered.
export const HOOK_BODY_MAX_BYTES = 1024 * 1024;

export class WsServer {
  private http: Server | null = null;
  private readonly registry = new ViewerRegistry();
  // Separate registry for browser viewers: keys are session names, which could collide
  // with the terminal registry's workspace ids (sessions are named after workspaces).
  private readonly browserViewers = new ViewerRegistry();
  private readonly handlers = new Set<ConnectionHandler>();
  private readonly relayClients = new Set<NoiseClientConnection>();
  private titlePoll: ReturnType<typeof setInterval> | null = null;
  private statsPoll: ReturnType<typeof setInterval> | null = null;
  private readonly lastWorkspaces = new Map<string, Workspace>();
  private lastBrowserNames = new Set<string>();
  // Sessions parked on background work or on a peer session's reply, so the idle notification
  // that follows their Stop can be told apart from a genuine one. In-memory on purpose — see
  // applyHookEvent.
  private readonly deferred = new Set<string>();
  // Sessions whose last main-loop tool call was SendMessage — see applyHookEvent.
  private readonly messagedLast = new Set<string>();
  // Codex sessions with a question waiting on the user — see applyHookEvent.
  private readonly questionPending = new Set<string>();

  constructor(private readonly deps: WsServerDeps) {}

  // Removes and returns the last-known snapshot for a workspace id, if the poll has ever
  // observed it. Used by ConnectionHandler on an explicit close, both to build the log
  // entry (the session is about to be killed and tmux won't be able to answer afterward)
  // and to keep the disappearance poll from separately logging it as `exited` — in the
  // common case. Known limitation, accepted
  // by design: closeWorkspace's tmux kill is async, so a poll tick landing in that gap
  // can still observe the session as present and re-add it to this map; the poll then
  // logs a second, duplicate `exited` entry once the kill actually completes. Harmless
  // (one extra line in an append-only diagnostic file), just not airtight.
  forgetWorkspace(id: string): Workspace | undefined {
    const workspace = this.lastWorkspaces.get(id);
    this.lastWorkspaces.delete(id);
    // A closed workspace must not come back parked if the tmux server dies before the next tick.
    void this.deps.liveSnapshot?.remove(id).catch(() => undefined);
    return workspace;
  }

  // Pushes a `closed` message to every connected device — used when a workspace is closed
  // explicitly, so devices other than the requester learn about it immediately instead of
  // waiting for the next title-poll tick (which no longer fires it for this id, since
  // forgetWorkspace already removed it from the tracking map before the poll runs).
  broadcastClosed(id: string): void {
    for (const handler of this.handlers) {
      handler.pushClosed(id);
    }
  }

  // Samples the machine's load and pushes it to every connected device. Skipped entirely
  // while nobody is watching, and best-effort throughout: the interval is fire-and-forget,
  // so a rejection here would be both silent and permanent.
  private async pollStats(): Promise<void> {
    if (this.handlers.size === 0) return;
    let stats;
    try {
      stats = await this.deps.systemStats?.read();
    } catch {
      return;
    }
    if (!stats) return;
    for (const handler of this.handlers) {
      handler.pushStats(stats);
    }
  }

  start(): Promise<void> {
    if (this.http) {
      return Promise.reject(new Error('server already started'));
    }
    this.deps.status.onChange((workspaceId) => {
      void this.broadcastWorkspace(workspaceId);
    });
    this.titlePoll = setInterval(() => {
      // Tracked first, so a workspace lost with its tmux server is already parked when the
      // title poll looks for it, rather than logged and pushed as closed.
      void this.trackLive().then(() => this.pollTitles());
      void this.pollBrowserSessions();
    }, this.deps.titlePollMs ?? DEFAULT_TITLE_POLL_MS);
    this.titlePoll.unref?.();
    if (this.deps.systemStats) {
      this.statsPoll = setInterval(() => {
        void this.pollStats();
      }, this.deps.statsPollMs ?? DEFAULT_STATS_POLL_MS);
      this.statsPoll.unref?.();
    }
    return new Promise((resolve, reject) => {
      const http = createServer((req, res) => {
        this.handleHttp(req, res);
      });
      this.http = http;
      http.on('error', (err) => {
        this.http = null;
        reject(err);
      });
      http.listen(this.deps.config.port, LOOPBACK, () => {
        resolve();
      });
    });
  }

  // A socket the agent dialed out to the relay on a client's behalf. It is served only through
  // the end-to-end Noise session keyed by the agent's static X25519 key.
  acceptRelaySocket(socket: FrameSocket, staticPrivate: Uint8Array, options: NoiseClientConnectionOptions): void {
    const conn = new NoiseClientConnection(socket, staticPrivate, options);
    this.relayClients.add(conn);
    conn.onClose(() => this.relayClients.delete(conn));
    this.accept(conn);
  }

  // Closes the relay sessions of devices that have since been revoked. Only revocation closes a
  // live session: a device that is merely unknown here may be one whose enrolment is still being
  // written.
  refuseRevokedDevices(isRevoked: (x25519: string) => boolean): void {
    for (const conn of this.relayClients) {
      if (conn.device && isRevoked(conn.device)) conn.refuse('device revoked');
    }
  }

  // Serves one client connection. In production every one is a relay-dialed Noise session
  // (acceptRelaySocket); tests hand in their own.
  accept(conn: ClientConnection): void {
    const handler = new ConnectionHandler(conn, {
      ...this.deps,
      registry: this.registry,
      browserViewers: this.browserViewers,
      forgetWorkspace: (id: string) => this.forgetWorkspace(id),
      broadcastClosed: (id: string) => this.broadcastClosed(id),
    });
    this.handlers.add(handler);
    conn.onClose(() => {
      this.handlers.delete(handler);
    });
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/hooks') {
      res.writeHead(404).end();
      return;
    }
    const token = this.deps.hookToken;
    const authorization = req.headers.authorization ?? '';
    if (!token || !constantTimeEqual(authorization, `Bearer ${token}`)) {
      res.writeHead(401).end();
      return;
    }
    let body = '';
    let bytes = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      bytes += chunk.length;
      if (bytes > HOOK_BODY_MAX_BYTES) {
        refused = true;
        res.writeHead(413, { connection: 'close' }).end();
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (refused) return;
      try {
        const parsed: unknown = JSON.parse(body);
        const { sessionName, event, claude, agent } = parsed as {
          sessionName?: unknown;
          event?: unknown;
          claude?: unknown;
          agent?: unknown;
        };
        if (typeof sessionName !== 'string' || typeof event !== 'string') {
          res.writeHead(400).end();
          return;
        }
        applyHookEvent(
          {
            store: this.deps.status,
            deferred: this.deferred,
            messagedLast: this.messagedLast,
            questionPending: this.questionPending,
          },
          { sessionName, event, claude, agent: typeof agent === 'string' ? agent : undefined },
        );
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  }

  // Runs whether or not a client is connected: the snapshot must be current when the server dies.
  // Best-effort, as the interval is fire-and-forget.
  private async trackLive(): Promise<void> {
    if (!this.deps.liveSnapshot) return;
    try {
      await trackLiveWorkspaces({
        tmux: this.deps.tmux,
        snapshot: this.deps.liveSnapshot,
        parked: this.deps.parked,
        status: this.deps.status,
        workspaceLog: this.deps.workspaceLog,
        clock: this.deps.clock,
        machineId: this.deps.config.machineId,
        sessionPrefix: this.deps.config.sessionPrefix,
      });
    } catch {
      return;
    }
  }

  // Detects pane-title renames (which have no hook) and pushes the new name, and detects
  // sessions that have disappeared (the inner process exited and tmux destroyed the session)
  // and pushes a `closed` so the workspace stops lingering as a ghost in connected clients.
  // The first sighting of a session only records its name; later changes broadcast.
  private async pollTitles(): Promise<void> {
    if (this.handlers.size === 0) return;
    let workspaces;
    try {
      workspaces = await listWorkspaces({
        tmux: this.deps.tmux,
        machineId: this.deps.config.machineId,
        sessionPrefix: this.deps.config.sessionPrefix,
        status: this.deps.status,
        repoRemote: this.deps.repoRemote,
        claudeSessions: this.deps.claudeSessions,
        parked: this.deps.parked,
      });
    } catch {
      return;
    }
    const hidden = await this.deps.hiddenFolders.list();
    const present = new Set<string>();
    for (const workspace of workspaces) {
      if (isHiddenPath(workspace.projectPath, hidden)) continue;
      present.add(workspace.id);
      const previous = this.lastWorkspaces.get(workspace.id);
      this.lastWorkspaces.set(workspace.id, workspace);
      if (previous !== undefined && previous.name !== workspace.name) {
        for (const handler of this.handlers) {
          handler.pushWorkspaceUpdated(workspace);
        }
      }
    }
    for (const id of this.lastWorkspaces.keys()) {
      if (!present.has(id)) {
        const workspace = this.lastWorkspaces.get(id)!;
        this.lastWorkspaces.delete(id);
        for (const handler of this.handlers) {
          handler.pushClosed(id);
        }
        await recordWorkspaceClosed(
          { workspaceLog: this.deps.workspaceLog, status: this.deps.status, clock: this.deps.clock },
          workspace,
          'exited',
        );
        // The inner process exited and tmux destroyed the session without a Perch `close`
        // message, so the connection-handler cascade never ran — close the workspace's
        // orphaned browser sessions here. Best-effort (never throws); pollBrowserSessions
        // then broadcasts the shrunken set.
        await closeWorkspaceBrowserSessions(
          { discovery: this.deps.browserDiscovery, commands: this.deps.browserCommands },
          id,
        );
      }
    }
  }

  // The agent only answers `list` with browserSessions, so a session started outside that
  // request/reply cycle (the CLI, another device's start button) would stay invisible until
  // a reconnect. This piggybacks on the title poll: when the live set of session names
  // changes, push the fresh list to every connected client. Discovery is a cheap fs scan.
  private async pollBrowserSessions(): Promise<void> {
    if (this.handlers.size === 0) return;
    let sessions;
    try {
      sessions = await this.deps.browserDiscovery.listSessions();
    } catch {
      return;
    }
    const names = new Set(sessions.map((s) => s.name));
    const unchanged =
      names.size === this.lastBrowserNames.size && [...names].every((n) => this.lastBrowserNames.has(n));
    if (unchanged) return;
    this.lastBrowserNames = names;
    // Names only — streamPort never leaves the agent (same rule as the `list` reply).
    const payload = sessions.map(({ name }) => ({ name }));
    for (const handler of this.handlers) {
      handler.pushBrowserSessions(payload);
    }
  }

  private async broadcastWorkspace(workspaceId: string): Promise<void> {
    const workspaces = await listWorkspaces({
      tmux: this.deps.tmux,
      machineId: this.deps.config.machineId,
      sessionPrefix: this.deps.config.sessionPrefix,
      status: this.deps.status,
      repoRemote: this.deps.repoRemote,
      claudeSessions: this.deps.claudeSessions,
      parked: this.deps.parked,
    });
    const workspace = workspaces.find((w) => w.id === workspaceId);
    if (!workspace) {
      return;
    }
    const hidden = await this.deps.hiddenFolders.list();
    if (isHiddenPath(workspace.projectPath, hidden)) {
      return;
    }
    for (const handler of this.handlers) {
      handler.pushWorkspaceUpdated(workspace);
    }
  }

  address(): { port: number } {
    const addr = this.http?.address() as AddressInfo | null;
    return { port: addr?.port ?? 0 };
  }

  stop(): Promise<void> {
    if (this.titlePoll) {
      clearInterval(this.titlePoll);
      this.titlePoll = null;
    }
    if (this.statsPoll) {
      clearInterval(this.statsPoll);
      this.statsPoll = null;
    }
    this.lastWorkspaces.clear();
    this.lastBrowserNames.clear();
    const http = this.http;
    if (!http) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      http.close((err) => {
        this.http = null;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
