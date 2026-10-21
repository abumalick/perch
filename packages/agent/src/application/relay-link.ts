import { REFUSAL, parseRelayControl, type RelayControl, type RelayPolicy } from '@perch/secure-channel';
import type { RelayTransport } from '../ports/relay-port';
import type { EnrolmentVerdict } from '../ports/device-gate-port';
import { withoutTrailingSlash } from './relay-url';
import { policyWarning } from './device-roster';

type Enrolment = NonNullable<Extract<RelayControl, { type: 'dial' }>['enrol']>;

export interface RelayLinkDeps<S> {
  // The relay's base URL, e.g. wss://relay.example.com.
  url: string;
  // This agent's account id on the relay (derived from its signing key).
  account: string;
  // Headers proving to the relay that this is the account's agent.
  authHeaders: (role: 'agent' | 'dial', dialId?: string) => Record<string, string>;
  // The relay host may send no pings of its own, so the agent keeps the control socket alive.
  heartbeatMs?: number;
  transport: RelayTransport<S>;
  // `release` frees the dial's slot: call it once the session authenticates or closes.
  onSocket: (socket: S, release: () => void) => void;
  // What the relay may admit, published on every open and whenever it changes.
  policy?: () => Promise<RelayPolicy>;
  // Checks an unknown device's enrolment proof; without it every enrolment is refused.
  admitEnrolment?: (enrol: Enrolment) => Promise<EnrolmentVerdict>;
  startTimer: (fn: () => void, ms: number) => () => void;
  log: (message: string) => void;
  now?: () => number;
  // Raised only by a test harness that enrols a new device for every test.
  enrolmentChecksPerMinute?: number;
}

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_MS = 20_000;
const DIAL_HEADER = 'x-perch-dial';
// The relay closes an agent's control socket with this code when another control socket for the
// same account arrives: latest wins. Two live agents holding one key would otherwise knock each
// other off every second, each redialing at once because its socket had opened.
const SUPERSEDED = 4000;
const SUPERSEDED_BACKOFF_MS = 60_000;
const MAX_SUPERSEDED_BACKOFF_MS = 15 * 60_000;
// Holding the relay this long means the rival is gone, so a later supersede starts over.
const SUPERSEDED_RESET_MS = 60 * 60_000;
const REFUSAL_LOG_EVERY_MS = 60_000;
// Dial-backs not yet authenticated: still connecting, or opened and in their handshake. A phone
// connect is one; the relay's own caps keep an honest relay far below this, so past it the relay
// is the one misbehaving. Each one is released within the session's auth deadline.
const MAX_DIALS_UNAUTHENTICATED = 32;
// Enrolment checks read the roster and the pairing file. The relay caps them at 10 a minute per
// account, but a hostile relay need not, so the agent bounds them too and refuses past the bounds
// without reading anything.
const MAX_ENROLMENT_CHECKS = 4;
const ENROLMENT_CHECKS_PER_MINUTE = 10;

// Keeps the agent's control socket to the relay up, and dials one fresh socket back for each
// client the relay announces. Each dialed socket is then an ordinary client connection.
export class RelayLink<S> {
  private backoff = BASE_BACKOFF_MS;
  // Per reason, so a stranger's stream of bad proofs cannot hide the owner's expired code.
  private readonly refusalLog = new Map<string, { last: number; held: number }>();
  private supersededCount = 0;
  private dialsUnauthenticated = 0;
  private enrolmentChecks = 0;
  private readonly enrolmentCheckTimes: number[] = [];
  private stopped = false;
  private cancelRetry: (() => void) | null = null;
  private closeControl: (() => void) | null = null;
  private sendControl: ((text: string) => void) | null = null;
  // Whether the relay acknowledged the latest policy. A relay whose code is upgraded under a
  // live control socket starts with none, and an older relay never acknowledges; either way the
  // policy goes out again with each heartbeat.
  private policyApplied = false;
  // The last warning logged about the policy, so a republish on each heartbeat says it once.
  private policyWarned: string | null = null;

  constructor(private readonly deps: RelayLinkDeps<S>) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.closeControl?.();
  }

  async publish(): Promise<void> {
    if (!this.sendControl || !this.deps.policy) return;
    const send = this.sendControl;
    this.policyApplied = false;
    try {
      const policy = await this.deps.policy();
      const warning = policyWarning(policy);
      if (warning !== this.policyWarned) {
        this.policyWarned = warning;
        if (warning) this.deps.log(`${warning} (${this.origin()})`);
      }
      send(JSON.stringify(policy));
    } catch (err) {
      this.deps.log(`relay policy not published (${this.origin()}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private connect(): void {
    const control = this.deps.transport.openControl(this.urlFor('agent'), this.deps.authHeaders('agent'));
    this.closeControl = () => control.close();
    let cancelHeartbeat: (() => void) | null = null;
    let openedAt: number | null = null;
    const beat = () => {
      cancelHeartbeat = this.deps.startTimer(() => {
        control.send('ping');
        if (!this.policyApplied) void this.publish();
        beat();
      }, this.deps.heartbeatMs ?? HEARTBEAT_MS);
    };
    control.onOpen(() => {
      this.backoff = BASE_BACKOFF_MS;
      openedAt = this.now();
      this.deps.log(`relay control socket open (${this.origin()})`);
      this.sendControl = (text) => control.send(text);
      beat();
      void this.publish();
    });
    control.onMessage((text) => {
      const message = parseRelayControl(text);
      if (!message) return;
      if (message.type === 'applied') this.policyApplied = true;
      else if (message.enrol) void this.dialForEnrolment(message.id, message.enrol, (reply) => control.send(reply));
      else this.dial(message.id);
    });
    control.onClose((code) => {
      cancelHeartbeat?.();
      this.closeControl = null;
      this.sendControl = null;
      if (this.stopped) return;
      if (openedAt !== null && this.now() - openedAt >= SUPERSEDED_RESET_MS) this.supersededCount = 0;
      let delay: number;
      if (code === SUPERSEDED) {
        delay = Math.min(SUPERSEDED_BACKOFF_MS * 2 ** this.supersededCount, MAX_SUPERSEDED_BACKOFF_MS);
        this.supersededCount += 1;
        this.deps.log(
          `relay control socket superseded by another agent using this relay key (${this.origin()}); ` +
            `redialing in ${delay / 1000}s. Two agents with one key take turns on a relay: stop one of them.`,
        );
      } else {
        delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
        this.deps.log(`relay control socket closed (${this.origin()}); redialing in ${delay}ms`);
      }
      this.cancelRetry = this.deps.startTimer(() => {
        this.cancelRetry = null;
        this.connect();
      }, delay);
    });
  }

  private async dialForEnrolment(id: string, enrol: Enrolment, reply: (text: string) => void): Promise<void> {
    const now = this.now();
    while (this.enrolmentCheckTimes.length > 0 && now - this.enrolmentCheckTimes[0]! >= 60_000) this.enrolmentCheckTimes.shift();
    if (this.enrolmentChecks >= MAX_ENROLMENT_CHECKS || this.enrolmentCheckTimes.length >= (this.deps.enrolmentChecksPerMinute ?? ENROLMENT_CHECKS_PER_MINUTE)) {
      this.logLimited(REFUSAL.tooManyEnrolments, `refused an enrolment through ${this.origin()}: too many enrolment attempts`);
      reply(JSON.stringify({ type: 'refuse', id, reason: REFUSAL.tooManyEnrolments }));
      return;
    }
    this.enrolmentCheckTimes.push(now);
    this.enrolmentChecks += 1;
    let verdict: EnrolmentVerdict | null = null;
    try {
      verdict = (await this.deps.admitEnrolment?.(enrol)) ?? null;
    } catch {
      // Refused below.
    } finally {
      this.enrolmentChecks -= 1;
    }
    if (verdict?.admitted) {
      this.dial(id);
      return;
    }
    const reason = verdict?.reason;
    this.logLimited(reason ?? '', `refused an enrolment through ${this.origin()}: ${verdict?.detail ?? 'the agent could not check its proof'}`);
    reply(JSON.stringify({ type: 'refuse', id, ...(reason ? { reason } : {}) }));
  }

  // A stranger can repeat these as fast as the relay lets them through, so the journal gets one
  // line a minute for each reason.
  private logLimited(reason: string, line: string): void {
    const now = this.now();
    const entry = this.refusalLog.get(reason) ?? { last: -Infinity, held: 0 };
    if (now - entry.last >= REFUSAL_LOG_EVERY_MS) {
      const held = entry.held ? ` (and ${entry.held} more in the last minute)` : '';
      this.deps.log(`${line}${held}`);
      this.refusalLog.set(reason, { last: now, held: 0 });
    } else {
      this.refusalLog.set(reason, { ...entry, held: entry.held + 1 });
    }
  }

  private dial(id: string): void {
    if (this.dialsUnauthenticated >= MAX_DIALS_UNAUTHENTICATED) {
      this.logLimited('dials', `relay ${this.origin()}: not dialing, ${MAX_DIALS_UNAUTHENTICATED} unauthenticated dial-backs already`);
      return;
    }
    this.dialsUnauthenticated += 1;
    let held = true;
    const release = () => {
      if (!held) return;
      held = false;
      this.dialsUnauthenticated -= 1;
    };
    const headers = { ...this.deps.authHeaders('dial', id), [DIAL_HEADER]: id };
    this.deps.transport.dial(this.urlFor('dial'), headers).then(
      (socket) => this.deps.onSocket(socket, release),
      (err: unknown) => {
        release();
        this.deps.log(`relay dial ${id} failed (${this.origin()}): ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private origin(): string {
    return withoutTrailingSlash(this.deps.url);
  }

  private urlFor(role: 'agent' | 'dial'): string {
    const url = new URL(`${withoutTrailingSlash(this.deps.url)}/${this.deps.account}`);
    url.searchParams.set('role', role);
    return url.toString();
  }
}
