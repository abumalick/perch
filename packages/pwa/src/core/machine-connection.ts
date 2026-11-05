import { parseAgentMessage, type AgentMessage, type ClientMessage } from '@perch/contracts';
import type { CloseInfo, Socket, SocketFactory } from './ports/socket';
import { REFUSAL } from '@perch/secure-channel';
import { describeRefusal, type RefusalContext } from './refusal';
import { en } from './i18n/en';

// Recorded in English for the connection log; the UI words them in the current language.
const DIAGNOSTIC = en.status.diagnostic;

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

// A human-readable explanation of why a connection failed, surfaced in the UI so a
// user can tell apart "never reached the machine" from "agent dropped us" from "auth
// rejected". `code` is the WebSocket close code when one was reported.
export interface ConnectionDiagnostic {
  message: string;
  code?: number;
  at: number;
  // The agent refused this phone, and `message` says why in the owner's words.
  refused?: true;
  // A refusal that redialing cannot help: the machine waits for the owner instead.
  final?: true;
  // Failed attempts in a row, and the backoff before the next one (absent when none is due).
  attempt?: number;
  retryInMs?: number;
}

export interface MachineConnectionDeps {
  // Where the agent is reached, tried in this order within one attempt.
  addresses: string[];
  // The address that last reached `online` in this app session, tried first; and where to
  // remember a new one.
  preferredAddress?: () => string | undefined;
  onAddressWorked?: (address: string) => void;
  // One address failing and the next being tried, for the connection log.
  onPhase?: (phase: string, detail: string) => void;
  token: string;
  socketFactory: SocketFactory;
  onMessage: (message: AgentMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
  onDiagnostic?: (diagnostic: ConnectionDiagnostic) => void;
  schedule?: (fn: () => void, ms: number) => void;
  // Arms a one-shot timer and returns a canceller. Used for the connect deadline; kept
  // separate from `schedule` (the reconnect backoff) so it can be cancelled once open.
  startTimer?: (fn: () => void, ms: number) => () => void;
  now?: () => number;
  // Names the machine and the credential in a refusal's message.
  refusalContext?: RefusalContext;
  // `all`: the agent said, inside the session, that this phone's device key is enrolled; the
  // entry's token and pairing secret are to be forgotten, and the connection sends neither from
  // then on. `pairing`: an agent from before it said so accepted the pairing secret, which is
  // spent.
  onCredentialsSpent?: (scope: 'all' | 'pairing') => void;
  // Asked for on every (re)connect once authenticated, unless the agent already pushed the
  // replies with its authResult (`pushed`).
  openingRequests?: ClientMessage[];
}

const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 10_000;
// A socket that never reaches `open` within this window is reaped and retried. Without it,
// iOS WebKit can leave a socket hanging in CONNECTING indefinitely when the network path is
// briefly flaky, stranding the machine on "connecting" forever with no retry.
const CONNECT_TIMEOUT_MS = 10_000;
// How long one address of several may take to open before the next is tried. It must allow
// Chrome's first local-network prompt and a slow first open (measured 1.5–5 s on Android). The
// last address gets at least what is left of CONNECT_TIMEOUT_MS, so a lone address keeps it all.
export const ADDRESS_OPEN_MS = 6_000;
// Failed attempts before a machine that has NEVER connected gives up auto-retrying and
// waits for a manual `reconnect()`. An unreachable peer that kept retrying would churn the
// network and starve the other machines' connections; going quiet keeps the app usable.
// A machine that has connected before is exempt (see `everConnected`) — it retries forever.
const MAX_CONNECT_ATTEMPTS = 4;
// Liveness heartbeat. While online, ping every interval and expect *some* inbound traffic
// within the timeout; a missed reply means the socket is dead — often a half-open TCP that
// never fires `close` (common when a phone backgrounds the PWA or switches networks). We
// then close it ourselves so the reconnect path takes over. Any inbound frame counts as
// proof of life (even an older agent's error reply to the unknown `ping`), so the worst case
// is a needless reconnect, never a stuck terminal.
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export class MachineConnection {
  private socket: Socket | null = null;
  private backoff = BASE_BACKOFF_MS;
  private failCount = 0;
  // Heartbeat state: the canceller for the currently-armed heartbeat timer (either the
  // idle interval before the next ping, or the post-ping reply deadline), and whether any
  // inbound frame has arrived since the last ping was sent.
  private heartbeatCancel: (() => void) | null = null;
  private pongSeen = false;
  // Once a machine has connected, it's known-reachable: keep auto-retrying through later
  // drops (e.g. a phone switching WiFi↔cellular) so it self-heals. Only a machine that has
  // never connected gives up, so a peer you add while it's offline can't churn the network.
  private everConnected = false;
  private rejected = false;
  // Monotonic token identifying the current connect "chain". Bumped by reconnect()/close() so a
  // pending backoff retry (an uncancellable fire-and-forget timer) fired after a supersede is a
  // no-op instead of spawning a second, overlapping connect chain. Overlapping chains left
  // stalled sockets in CONNECTING that WebKit never tears down, wedging reconnect until the
  // machine was toggled off/on (which called close() — the only thing that quiesced them).
  private generation = 0;
  private closedByUser = false;
  // The current attempt's addresses in the order it tries them, the one being dialed, and when
  // the attempt began.
  private order: string[] = [];
  private index = 0;
  private attemptStarted = 0;
  // Per-socket diagnostic state, reset on each dial.
  private opened = false;
  private errored = false;
  private timedOut = false;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly startTimer: (fn: () => void, ms: number) => () => void;
  private readonly now: () => number;
  // What `auth` carries: the entry's credential until the agent says the device key is enrolled.
  private token: string;
  // The token held back after a "token not needed" close, until the agent confirms the key is
  // enrolled (forgotten) or says it is not (sent again).
  private withheld: string | null = null;

  constructor(private readonly deps: MachineConnectionDeps) {
    this.token = deps.token;
    this.schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.startTimer =
      deps.startTimer ??
      ((fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => clearTimeout(id);
      });
    this.now = deps.now ?? (() => Date.now());
  }

  // One attempt: the addresses in order, the one that last worked first. An address that fails
  // without the agent answering (no route, a hang, a refused upgrade) hands over to the next; one
  // the agent answered on, with a session or a refusal, decides the attempt, since every address
  // leads to the same agent.
  connect(): void {
    this.stopHeartbeat();
    this.deps.onStatus('connecting');
    const preferred = this.deps.preferredAddress?.();
    const addresses = this.deps.addresses;
    this.order = preferred && addresses.includes(preferred) ? [preferred, ...addresses.filter((a) => a !== preferred)] : [...addresses];
    this.index = 0;
    this.attemptStarted = this.now();
    this.dial();
  }

  private isLastAddress(): boolean {
    return this.index >= this.order.length - 1;
  }

  // The current socket failed before the agent answered: try the next address, superseding it
  // first so its late events are ignored.
  private nextAddress(socket: Socket, why: string): void {
    this.deps.onPhase?.('address', `${this.order[this.index]} ${why}`);
    this.index += 1;
    this.dial();
    socket.close();
  }

  private dial(): void {
    this.opened = false;
    this.errored = false;
    this.timedOut = false;
    const address = this.order[this.index]!;
    const socket = this.deps.socketFactory(address);
    this.socket = socket;
    const deadline = this.isLastAddress()
      ? Math.max(ADDRESS_OPEN_MS, CONNECT_TIMEOUT_MS - (this.now() - this.attemptStarted))
      : ADDRESS_OPEN_MS;
    // Reap a connection that stalls in CONNECTING: hand over to the next address, or close it so
    // the `onClose` path below marks the machine offline and schedules a retry, instead of
    // hanging forever.
    const cancelDeadline = this.startTimer(() => {
      if (this.socket !== socket || this.opened) return;
      if (!this.isLastAddress()) return this.nextAddress(socket, `timed out after ${deadline}ms`);
      this.timedOut = true;
      socket.close();
    }, deadline);
    socket.onOpen(() => {
      // Ignore a late open from a socket we've already superseded (reconnect/close swapped it
      // out): it must not authenticate or become the live connection.
      if (this.socket !== socket) return;
      cancelDeadline();
      this.opened = true;
      socket.send(JSON.stringify({ type: 'auth', token: this.token } satisfies ClientMessage));
    });
    socket.onError?.(() => {
      this.errored = true;
    });
    socket.onMessage((data) => {
      if (this.socket !== socket) return;
      this.handle(socket, data);
    });
    socket.onClose((info) => {
      cancelDeadline();
      if (this.socket !== socket) {
        return;
      }
      this.stopHeartbeat();
      this.socket = null;
      if (this.closedByUser) {
        return;
      }
      if (this.rejected) {
        // Auth failure is reported in `handle`; the close that follows is expected.
        return;
      }
      let refusal = this.deps.refusalContext && !this.timedOut ? describeRefusal(info?.code, info?.reason, this.deps.refusalContext) : null;
      // The close reason comes from outside the session, so whatever fronts the agent could send it:
      // the token is held back for the next attempt, never forgotten on this alone.
      if (refusal && info?.reason === REFUSAL.tokenNotNeeded && this.token) {
        this.withheld = this.token;
        this.token = '';
      } else if (refusal && info?.reason === REFUSAL.notEnrolled && this.withheld !== null) {
        this.restoreWithheld();
        refusal = { ...refusal, final: false };
      }
      if (!refusal && !this.opened && !this.timedOut && !this.isLastAddress()) {
        this.nextAddress(socket, info?.code ? `closed (code ${info.code})` : 'closed');
        return;
      }
      const diagnostic: ConnectionDiagnostic = refusal
        ? { message: refusal.message, code: info?.code, at: this.now(), refused: true, ...(refusal.final ? { final: true as const } : {}) }
        : this.diagnose(info);
      if (refusal?.final) {
        // Redialing would be refused the same way; `reconnect()` (a tap, or a fresh pairing code)
        // tries again.
        this.deps.onDiagnostic?.(diagnostic);
        this.deps.onStatus('offline');
        this.rejected = true;
        return;
      }
      this.failCount += 1;
      // Give up only for a machine that has never connected: it stops churning the
      // network and waits for an explicit `reconnect()`. A machine that connected
      // before keeps retrying so it recovers on its own from a transient drop.
      const givingUp = !this.everConnected && this.failCount >= MAX_CONNECT_ATTEMPTS;
      const delay = this.backoff;
      this.deps.onDiagnostic?.({ ...diagnostic, attempt: this.failCount, ...(givingUp ? {} : { retryInMs: delay }) });
      this.deps.onStatus('offline');
      if (givingUp) return;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      // Tie this retry to the current chain: a reconnect() or close() before it fires bumps
      // `generation`, turning the (uncancellable) timer into a no-op so chains never stack.
      const gen = this.generation;
      this.schedule(() => {
        if (this.generation === gen) this.connect();
      }, delay);
    });
  }

  // Resume connecting after a manual trigger (e.g. a "Reconnect" tap), clearing the
  // give-up state so a machine that went quiet — or was auth-rejected — tries again.
  reconnect(): void {
    // Supersede any pending backoff retry and in-flight socket so we replace the current chain
    // rather than stacking a second one on top of it (the wedge this whole mechanism prevents).
    this.generation += 1;
    this.closedByUser = false;
    this.rejected = false;
    this.failCount = 0;
    this.backoff = BASE_BACKOFF_MS;
    this.stopHeartbeat();
    const existing = this.socket;
    this.socket = null;
    existing?.close();
    this.connect();
  }

  // Make the next retry, if the attempt in flight fails, the first one's. An attempt started
  // before the app was backgrounded fails right after it returns, and must not wait the backoff
  // the background built up.
  resetBackoff(): void {
    this.backoff = BASE_BACKOFF_MS;
  }

  // Probe the link immediately instead of waiting for the next heartbeat interval. Used when
  // the app returns to the foreground, where the socket may have silently died while the PWA
  // was backgrounded — this surfaces that within the reply timeout rather than up to a full
  // interval later. No-op unless a heartbeat is running (i.e. the machine is online).
  checkLiveness(): void {
    const socket = this.socket;
    if (!socket || !this.heartbeatCancel) return;
    this.stopHeartbeat();
    this.sendPingAndAwait(socket);
  }

  private diagnose(info?: CloseInfo): ConnectionDiagnostic {
    const code = info?.code;
    const reason = info?.reason?.trim();
    let message: string;
    if (this.timedOut) {
      // We reaped the socket ourselves after it stalled in CONNECTING.
      message = DIAGNOSTIC.timedOut;
    } else if (!this.opened) {
      // Closed before ever opening: never reached the agent. A 1006 abnormal closure here
      // means the address could not be reached. A reason means the socket knows better (e.g. the
      // handshake failed).
      const why = reason
        ? reason
        : this.errored || code === 1006
          ? DIAGNOSTIC.networkError
          : DIAGNOSTIC.neverOpened;
      message = DIAGNOSTIC.failed(why);
    } else if (reason) {
      message = DIAGNOSTIC.closedByAgent(reason);
    } else {
      message = DIAGNOSTIC.dropped;
    }
    return { message, code, at: this.now() };
  }

  send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  close(): void {
    // Bump the chain token so a pending backoff retry can't resurrect the connection after close.
    this.generation += 1;
    this.closedByUser = true;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
  }

  private handle(socket: Socket, data: string): void {
    // Any inbound frame is proof the link is alive, satisfying a pending heartbeat — recorded
    // before parsing so even a frame we can't parse still counts.
    this.pongSeen = true;
    let message: AgentMessage;
    try {
      message = parseAgentMessage(JSON.parse(data));
    } catch {
      return;
    }
    if (message.type === 'authResult') {
      if (message.ok) {
        if (message.enrolled === true) this.forgetCredentials();
        else this.restoreWithheld();
        if (message.enrolled === undefined && this.deps.refusalContext?.credential === 'pairing') this.deps.onCredentialsSpent?.('pairing');
        this.backoff = BASE_BACKOFF_MS;
        this.failCount = 0;
        this.everConnected = true;
        this.deps.onAddressWorked?.(this.order[this.index]!);
        this.startHeartbeat(socket);
        if (!message.pushed) this.deps.openingRequests?.forEach((request) => socket.send(JSON.stringify(request)));
        this.deps.onStatus('online');
      } else {
        this.rejected = true;
        this.deps.onDiagnostic?.({ message: DIAGNOSTIC.authRejected, at: this.now() });
        this.deps.onStatus('offline');
        this.socket?.close();
      }
      return;
    }
    // `pong` is purely a liveness reply (handled above); don't forward it to the app.
    if (message.type === 'pong') {
      return;
    }
    this.deps.onMessage(message);
  }

  private forgetCredentials(): void {
    this.token = '';
    this.withheld = null;
    this.deps.onCredentialsSpent?.('all');
  }

  private restoreWithheld(): void {
    if (this.withheld === null) return;
    this.token = this.withheld;
    this.withheld = null;
  }

  private startHeartbeat(socket: Socket): void {
    this.stopHeartbeat();
    this.armPing(socket);
  }

  private armPing(socket: Socket): void {
    this.heartbeatCancel = this.startTimer(() => {
      if (this.socket !== socket) return;
      this.sendPingAndAwait(socket);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private sendPingAndAwait(socket: Socket): void {
    this.pongSeen = false;
    socket.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    this.heartbeatCancel = this.startTimer(() => {
      if (this.socket !== socket) return;
      if (this.pongSeen) {
        this.armPing(socket);
      } else {
        // The ping went unanswered: the link is dead. Closing it routes through `onClose`,
        // which marks the machine offline and schedules a reconnect.
        socket.close();
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private stopHeartbeat(): void {
    this.heartbeatCancel?.();
    this.heartbeatCancel = null;
  }
}
