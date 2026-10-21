// Relay core. For one account it pairs each client socket with a socket the agent dials back,
// and moves frames between them untouched; it never parses a payload (end to end they are
// Noise ciphertext). Sockets, upgrades and the socket directory are ports, so the rules are
// testable without a network and the same core runs on Node and in a Durable Object.
//
// The core keeps no socket state of its own beyond clients still waiting for their dial: which
// socket is the control socket and which two sockets form a pair is asked of the directory on
// every event. A host that evicts the core from memory (a hibernating Durable Object) therefore
// only has to rebuild it over the same directory. A pending client holds an open request, which
// keeps such a host awake, so the pending map never has to survive eviction. What must survive
// (the agent's device policy, the key challenges are signed with) goes through the store port.
// The challenges themselves are stateless (signed and time-bound, see relay-challenge.ts): handing
// one out writes nothing. The nonces already used are remembered in memory for their lifetime; a
// host evicted from memory forgets them, which reopens a used nonce for at most CHALLENGE_TTL_MS.
//
// Clients are gated by device key. A client fetches a single-use challenge, signs it with its
// Ed25519 device key and upgrades with the signature; the relay admits the keys the agent
// published in its policy. An unknown key may carry an enrolment proof, which only the agent can
// check, so the relay passes it along in the dial and the agent refuses or dials back, within a
// per-account budget of such dials. A client without a device key is refused once the account's
// agent has published a policy; before that (an agent from before device keys, or the moments
// after a relay restart) the agent's own handshake is the only gate, and it takes IK only.
//
// A phone is refused in band: its upgrade is completed and closed at once with IN_BAND_REFUSAL +
// the HTTP status and a REFUSAL as the reason, since a browser's WebSocket reports 1006 for any
// refused upgrade and the phone could not say what went wrong. Every reason is one the phone could
// already read before (a non-browser client got it as the HTTP status and body), and each is given
// only after the checks that gave it: a device's standing only to a signature by that device, and
// the agent's reasons for a pairing code only to a proof made with that code.
import {
  IN_BAND_REFUSAL,
  MAX_FRAME_BYTES,
  REFUSAL,
  generateChallengeKey,
  mintChallenge,
  parseAgentControl,
  verifyChallenge,
  verifyDeviceAuth,
  type RelayPolicy,
} from '@perch/secure-channel';
import { SpentNonces } from './spent-nonces.ts';

export type RelayData = string | ArrayBuffer | Uint8Array;

export interface Peer {
  send(data: RelayData, binary: boolean): void;
  close(code?: number, reason?: string): void;
}

export type PeerLabel = { kind: 'control' } | { kind: 'client' | 'agent'; pair: string };

// An HTTP upgrade the relay has not answered yet. A client's upgrade is held open until its
// agent dials in, so the client only sees `open` once frames can actually reach the agent.
export interface PendingUpgrade {
  // Completes the handshake and files the socket under `label`; null when the underlying
  // connection is already gone.
  accept(label: PeerLabel): Peer | null;
  reject(status: number, reason: string): void;
  // Completes the handshake and closes the socket at once with `code` and `reason`, without
  // filing it: a refusal a browser can read.
  refuse(code: number, reason: string): void;
  onAbort(listener: () => void): void;
}

// The sockets of one account, as the host holds them. Only open sockets are ever returned, and
// the same socket must come back as the same Peer object. A host reports a closed socket to
// `Relay.closed` before forgetting it, so `labelOf` can still name it there.
export interface PeerDirectory {
  find(label: PeerLabel): Peer[];
  // Every open socket of the account, whatever its label.
  all(): Peer[];
  labelOf(peer: Peer): PeerLabel | null;
  count(kind: PeerLabel['kind']): number;
}

export interface DeviceProof {
  key: string;
  nonce: string;
  sig: string;
  proof?: string;
  // What the phone says it made the proof with. Unchecked: the agent only names a failure by it.
  cred?: 'pairing' | 'token';
}

export type RelayRequest =
  | { role: 'client'; account: string; device?: DeviceProof }
  | { role: 'challenge'; account: string }
  | { role: 'agent'; account: string; authorization?: string }
  | { role: 'dial'; account: string; id: string; authorization?: string };

export const DIAL_HEADER = 'x-perch-dial';

// The challenge is fetched by the PWA from its own origin, so any page may read it; it is a
// nonce, useless to anyone but the device that signs it first.
export const CHALLENGE_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
} as const;

// `header` looks a request header up by its lower-case name.
export function parseRelayRequest(
  url: string,
  header: (name: string) => string | null | undefined = () => undefined,
): RelayRequest | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://relay');
  } catch {
    return null;
  }
  const { pathname, searchParams } = parsed;
  const account = pathname.slice(1);
  if (!/^[\w-]{1,64}$/.test(account)) return null;
  const role = searchParams.get('role');
  const authorization = header('authorization') ?? undefined;
  if (role === null) {
    const [key, nonce, sig] = ['device', 'nonce', 'sig'].map((name) => searchParams.get(name));
    if (!key && !nonce && !sig) return { role: 'client', account };
    if (!key || !nonce || !sig) return null;
    const proof = searchParams.get('proof') ?? undefined;
    const cred = searchParams.get('cred');
    // The same shapes the agent accepts in a dial: anything else would be forwarded, then
    // dropped by the agent, and hold a pending slot until the dial timeout.
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return null;
    if (!/^[\w-]{1,128}$/.test(nonce) || (proof !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(proof))) return null;
    return {
      role: 'client',
      account,
      device: { key, nonce, sig, ...(proof ? { proof } : {}), ...(cred === 'pairing' || cred === 'token' ? { cred } : {}) },
    };
  }
  if (role === 'challenge') return { role: 'challenge', account };
  if (role === 'agent') return { role: 'agent', account, authorization };
  const id = header(DIAL_HEADER);
  if (role === 'dial' && id) return { role: 'dial', account, id, authorization };
  return null;
}

// Small durable values of one account. Synchronous, like a Durable Object's KV storage.
export interface RelayStore {
  get(key: string): string | undefined;
  put(key: string, value: string): void;
  delete(key: string): void;
}

export class MemoryStore implements RelayStore {
  private readonly values = new Map<string, string>();
  get(key: string): string | undefined {
    return this.values.get(key);
  }
  put(key: string, value: string): void {
    this.values.set(key, value);
  }
  delete(key: string): void {
    this.values.delete(key);
  }
}

export interface RelayDeps {
  directory: PeerDirectory;
  // Dial ids, which reach only the agent and the relay.
  newId: () => string;
  store?: RelayStore;
  now?: () => number;
  startTimer: (fn: () => void, ms: number) => () => void;
  dialTimeoutMs?: number;
  maxPending?: number;
  maxPairs?: number;
  // Dials asking the agent to enrol an unknown key, per ENROLMENT_WINDOW_MS.
  maxEnrolments?: number;
  maxFrameBytes?: number;
}

interface PendingClient {
  control: Peer;
  upgrade: PendingUpgrade;
  cancelTimeout: () => void;
}

const DEFAULT_DIAL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING = 8;
const DEFAULT_MAX_PAIRS = 16;
const SUPERSEDED = 4000;
// The account was removed from the relay's registry: every socket it held is closed with this.
export const ACCOUNT_REMOVED = 4004;
const GOING_AWAY = 1001;
const MESSAGE_TOO_BIG = 1009;
export const CHALLENGE_TTL_MS = 30_000;
// Pairing a phone takes one enrolment dial; a stranger's stream of made-up proofs costs the agent
// two file reads and a key derivation each, so they are capped. A flood can hold the owner's
// pairing off for the rest of the window, no longer.
const DEFAULT_MAX_ENROLMENTS = 10;
export const ENROLMENT_WINDOW_MS = 60_000;
const POLICY_KEY = 'policy';
const CHALLENGE_KEY = 'challengeKey';
const ENROLMENTS_KEY = 'enrolments';
// Set when the account is removed from the registry, cleared when it joins again. A request
// already past the registry check (or answered from a host's stale cache) still reaches the
// account's relay, which must then refuse it and write nothing back.
const REMOVED_KEY = 'removed';
// Where challenges were kept before they were stateless; evicting an account still clears it.
const LEGACY_CHALLENGES_KEY = 'challenges';

type Enrolment = { device: string; nonce: string; proof: string; cred?: 'pairing' | 'token' };

// A phone's upgrade, whose every refusal is made in band.
function inBand(upgrade: PendingUpgrade): PendingUpgrade {
  return {
    accept: (label) => upgrade.accept(label),
    reject: (status, reason) => upgrade.refuse(IN_BAND_REFUSAL + status, reason),
    refuse: (code, reason) => upgrade.refuse(code, reason),
    onAbort: (listener) => upgrade.onAbort(listener),
  };
}

export class Relay {
  private readonly pending = new Map<string, PendingClient>();
  private readonly store: RelayStore;
  private readonly spent = new SpentNonces();

  constructor(private readonly deps: RelayDeps) {
    this.store = deps.store ?? new MemoryStore();
  }

  // A fresh nonce for a client of `account` to sign with its device key. Valid once, for
  // CHALLENGE_TTL_MS. Nothing is stored for it: only the key, once for the account's lifetime.
  // Null for a removed account.
  challenge(account: string): string | null {
    if (this.removed()) return null;
    return mintChallenge(this.challengeKey(), account, this.now(), CHALLENGE_TTL_MS);
  }

  handle(request: RelayRequest, upgrade: PendingUpgrade): void {
    if (this.removed()) {
      (request.role === 'client' ? inBand(upgrade) : upgrade).reject(404, REFUSAL.unknownAccount);
      return;
    }
    switch (request.role) {
      case 'agent':
        this.registerAgent(upgrade);
        return;
      case 'challenge':
        upgrade.reject(400, 'a challenge is fetched, not upgraded');
        return;
      case 'client': {
        const client = inBand(upgrade);
        if (request.device) this.admitDevice(request.account, request.device, client).catch(() => client.reject(500, REFUSAL.internal));
        else if (this.policy()) client.reject(401, REFUSAL.deviceKeyRequired);
        else this.requestDial(client);
        return;
      }
      case 'dial':
        this.completeDial(request.id, upgrade);
        return;
    }
  }

  message(peer: Peer, data: RelayData, binary: boolean): void {
    const label = this.deps.directory.labelOf(peer);
    if (!label) return;
    // The agent's heartbeat: the relay sends no pings of its own on every host. It is answered
    // on every socket, not only the control one, because a hibernating Durable Object answers
    // it in the runtime for all its sockets alike; relay traffic itself is binary.
    if (data === 'ping') {
      peer.send('pong', false);
      return;
    }
    if (label.kind === 'control') {
      // A frame that arrived before eviction closed the socket may still be delivered.
      if (this.removed()) peer.close(ACCOUNT_REMOVED, 'account removed');
      else if (typeof data === 'string') this.controlMessage(peer, data);
      return;
    }
    const partner = this.partnerOf(label);
    if (byteLength(data) > (this.deps.maxFrameBytes ?? MAX_FRAME_BYTES)) {
      peer.close(MESSAGE_TOO_BIG, 'frame too large');
      partner?.close(MESSAGE_TOO_BIG, 'frame too large');
      return;
    }
    if (!partner) {
      peer.close(GOING_AWAY, 'peer gone');
      return;
    }
    partner.send(data, binary);
  }

  closed(peer: Peer, code: number, reason: string): void {
    const label = this.deps.directory.labelOf(peer);
    if (label?.kind === 'control') {
      this.rejectPendingOf(peer);
      return;
    }
    if (label) this.partnerOf(label)?.close(sendableCode(code), reason);
  }

  // The account was removed from the registry: nothing it held on the relay stays open, and
  // nothing it left in the store (its policy, its challenge key) outlives it.
  evict(): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      waiting.cancelTimeout();
      waiting.upgrade.reject(404, REFUSAL.unknownAccount);
    }
    for (const peer of this.deps.directory.all()) peer.close(ACCOUNT_REMOVED, 'account removed');
    this.store.delete(POLICY_KEY);
    this.store.delete(CHALLENGE_KEY);
    this.store.delete(LEGACY_CHALLENGES_KEY);
    this.store.delete(ENROLMENTS_KEY);
    this.store.put(REMOVED_KEY, '1');
    this.spent.clear();
  }

  // The account joined the registry again.
  reinstate(): void {
    this.store.delete(REMOVED_KEY);
  }

  private registerAgent(upgrade: PendingUpgrade): void {
    // Latest wins: a restarted agent can arrive before the relay notices its old socket died.
    for (const old of this.deps.directory.find({ kind: 'control' })) {
      old.close(SUPERSEDED, 'superseded');
      this.rejectPendingOf(old);
    }
    upgrade.accept({ kind: 'control' });
  }

  private async admitDevice(account: string, device: DeviceProof, upgrade: PendingUpgrade): Promise<void> {
    // Spent before the signature is checked, so a failed attempt cannot be retried on it.
    if (!this.consumeChallenge(account, device.nonce)) {
      upgrade.reject(401, REFUSAL.challenge);
      return;
    }
    if (!(await verifyDeviceAuth(device.sig, { account, nonce: device.nonce, device: device.key }))) {
      upgrade.reject(401, REFUSAL.signature);
      return;
    }
    const policy = this.policy();
    if (!policy) {
      this.requestDial(upgrade);
      return;
    }
    if (policy.revoked.includes(device.key)) {
      upgrade.reject(403, REFUSAL.revoked);
    } else if (policy.devices.includes(device.key)) {
      this.requestDial(upgrade);
    } else if (!device.proof) {
      upgrade.reject(403, REFUSAL.notEnrolled);
    } else if (!policy.enrol) {
      // Said to anyone who signs with a key of their own: it names a setting, not a device or a
      // credential, and the agent is not asked (a closed enrolment must not cost it a dial).
      upgrade.reject(403, REFUSAL.enrolmentClosed);
    } else if (policy.tokenEnrol === false && device.cred === 'token') {
      // The phone's own word for its credential, unchecked: lying gains nothing, since the agent
      // refuses a token proof itself.
      upgrade.reject(403, REFUSAL.enrolmentOff);
    } else if (!this.takeEnrolment()) {
      upgrade.reject(429, REFUSAL.tooManyEnrolments);
    } else {
      const { key, nonce, proof, cred } = device;
      this.requestDial(upgrade, { device: key, nonce, proof, ...(cred ? { cred } : {}) });
    }
  }

  private requestDial(upgrade: PendingUpgrade, enrol?: Enrolment): void {
    const control = this.deps.directory.find({ kind: 'control' }).at(-1);
    if (!control) {
      upgrade.reject(503, REFUSAL.agentOffline);
      return;
    }
    if (this.pending.size >= (this.deps.maxPending ?? DEFAULT_MAX_PENDING)) {
      upgrade.reject(429, REFUSAL.tooManyPending);
      return;
    }
    // Pending clients count too: each is a pair the agent is about to dial.
    if (this.deps.directory.count('client') + this.pending.size >= (this.deps.maxPairs ?? DEFAULT_MAX_PAIRS)) {
      upgrade.reject(429, REFUSAL.tooManyConnections);
      return;
    }
    const id = this.deps.newId();
    const cancelTimeout = this.deps.startTimer(() => {
      this.pending.delete(id);
      upgrade.reject(504, REFUSAL.agentSilent);
    }, this.deps.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS);
    this.pending.set(id, { control, upgrade, cancelTimeout });
    upgrade.onAbort(() => {
      cancelTimeout();
      this.pending.delete(id);
    });
    try {
      control.send(JSON.stringify({ type: 'dial', id, ...(enrol ? { enrol } : {}) }), false);
    } catch {
      this.pending.delete(id);
      cancelTimeout();
      upgrade.reject(503, REFUSAL.agentOffline);
    }
  }

  private completeDial(id: string, upgrade: PendingUpgrade): void {
    const waiting = this.pending.get(id);
    if (!waiting) {
      upgrade.reject(404, 'no such pending client');
      return;
    }
    this.pending.delete(id);
    waiting.cancelTimeout();
    const client = waiting.upgrade.accept({ kind: 'client', pair: id });
    if (!client) {
      upgrade.reject(410, 'client gone');
      return;
    }
    const agent = upgrade.accept({ kind: 'agent', pair: id });
    if (!agent) client.close(GOING_AWAY, 'agent gone');
  }

  private controlMessage(control: Peer, text: string): void {
    const message = parseAgentControl(text);
    if (message?.type === 'policy') {
      const { type: _, ...policy } = message;
      this.store.put(POLICY_KEY, JSON.stringify(policy));
      control.send(JSON.stringify({ type: 'applied' }), false);
    } else if (message?.type === 'refuse') {
      const waiting = this.pending.get(message.id);
      if (!waiting || waiting.control !== control) return;
      this.pending.delete(message.id);
      waiting.cancelTimeout();
      waiting.upgrade.reject(403, message.reason ?? REFUSAL.enrolmentRefused);
    }
  }

  // The last policy the account's agent published. It outlives the control socket, so an agent
  // that drops does not reopen the gate; null only while no agent has ever published one.
  private policy(): Omit<RelayPolicy, 'type'> | null {
    const raw = this.store.get(POLICY_KEY);
    return raw ? (JSON.parse(raw) as Omit<RelayPolicy, 'type'>) : null;
  }

  private challengeKey(): string {
    let key = this.store.get(CHALLENGE_KEY);
    if (!key) {
      key = generateChallengeKey();
      this.store.put(CHALLENGE_KEY, key);
    }
    return key;
  }

  private consumeChallenge(account: string, nonce: string): boolean {
    const now = this.now();
    if (this.spent.has(nonce, now)) return false;
    const expires = verifyChallenge(this.challengeKey(), account, nonce, now, CHALLENGE_TTL_MS);
    return expires !== null && this.spent.use(nonce, expires, now);
  }

  // The window lives in the store, so a host that rebuilds the relay (a Durable Object waking
  // from hibernation) does not hand out a fresh one. Only an attempt within the budget writes.
  private takeEnrolment(): boolean {
    const now = this.now();
    const raw = this.store.get(ENROLMENTS_KEY);
    let window = raw ? (JSON.parse(raw) as { start: number; count: number }) : { start: -Infinity, count: 0 };
    if (now - window.start >= ENROLMENT_WINDOW_MS) window = { start: now, count: 0 };
    if (window.count >= (this.deps.maxEnrolments ?? DEFAULT_MAX_ENROLMENTS)) return false;
    this.store.put(ENROLMENTS_KEY, JSON.stringify({ start: window.start, count: window.count + 1 }));
    return true;
  }

  private removed(): boolean {
    return this.store.get(REMOVED_KEY) !== undefined;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private rejectPendingOf(control: Peer): void {
    for (const [id, waiting] of this.pending) {
      if (waiting.control !== control) continue;
      this.pending.delete(id);
      waiting.cancelTimeout();
      waiting.upgrade.reject(503, REFUSAL.agentOffline);
    }
  }

  private partnerOf(label: Exclude<PeerLabel, { kind: 'control' }>): Peer | undefined {
    const kind = label.kind === 'client' ? 'agent' : 'client';
    return this.deps.directory.find({ kind, pair: label.pair })[0];
  }
}

function byteLength(data: RelayData): number {
  return typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength;
}

// 1005/1006/1015 describe a close nobody sent and may not be put on the wire.
function sendableCode(code: number): number {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    ? code
    : GOING_AWAY;
}

// A directory for hosts that keep sockets in memory (the Node server, tests).
export class MemoryDirectory implements PeerDirectory {
  private readonly entries = new Map<Peer, { label: PeerLabel; isOpen: () => boolean }>();

  add(peer: Peer, label: PeerLabel, isOpen: () => boolean): void {
    this.entries.set(peer, { label, isOpen });
  }

  remove(peer: Peer): void {
    this.entries.delete(peer);
  }

  find(label: PeerLabel): Peer[] {
    const found: Peer[] = [];
    for (const [peer, entry] of this.entries) {
      if (entry.isOpen() && sameLabel(entry.label, label)) found.push(peer);
    }
    return found;
  }

  all(): Peer[] {
    return [...this.entries].filter(([, entry]) => entry.isOpen()).map(([peer]) => peer);
  }

  labelOf(peer: Peer): PeerLabel | null {
    return this.entries.get(peer)?.label ?? null;
  }

  count(kind: PeerLabel['kind']): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.isOpen() && entry.label.kind === kind) n += 1;
    return n;
  }
}

function sameLabel(a: PeerLabel, b: PeerLabel): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'control' || (b.kind !== 'control' && a.pair === b.pair);
}
