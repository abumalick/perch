import type { AgentMessage } from '@perch/contracts';
import {
  DEVICE_REFUSED,
  REFUSAL,
  IkResponder,
  WrongStaticKeyError,
  SecureSession,
  b64url,
  deviceFingerprint,
  handshakeFrame,
  handshakePattern,
  parseDeviceHello,
  readHandshakeFrame,
  startTimer,
  verifyDeviceHello,
  MAX_MESSAGE_BYTES,
  type DeviceHello,
} from '@perch/secure-channel';
import type { DeviceStanding, EnrolmentMode } from '../application/device-roster';
import type { DeviceGate, Redemption } from '../ports/device-gate-port';
import type { ClientConnection } from '../ports/client-connection';
import type { FrameSocket } from '../ports/frame-socket';

const SECURE_CHANNEL_FAILED = 4002;
// Until the handler has accepted the token, a socket would otherwise hold one of the relay's few
// pair slots until an idle timeout.
const AUTH_TIMEOUT_MS = 10_000;
// Until `auth` is accepted the phone sends one small message: nothing that has proven nothing may
// make the agent reassemble up to MAX_MESSAGE_BYTES.
export const PRE_AUTH_MAX_MESSAGE_BYTES = 8 * 1024;
// A phone sends `auth` once per connection; a socket repeating it is probing.
const MAX_AUTH_ATTEMPTS = 3;

// A pairing secret's shape (32 bytes, base64url), so a token is not looked up as one needlessly.
const PAIRING_SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface NoiseClientConnectionOptions {
  devices: DeviceGate;
  // Called once, when the accepted `authResult` goes out.
  onAuthenticated?: () => void;
  // Whether an enrolled device that asked may be served at once now (see PushBudget). Without
  // one, no device is.
  pushBudget?: { take(deviceKey: string): boolean };
  log?: (message: string) => void;
  // For lines a stranger can cause at will (one shared across connections, see LimitedLog); `log`
  // takes them without one.
  refusalLog?: { line(key: string, text: string): void };
  startTimer?: (fn: () => void, ms: number) => () => void;
}

type State =
  | { kind: 'handshake' }
  | { kind: 'checking' }
  // An unknown device: only `auth` reaches the handler, and a successful one enrols it.
  // `tokenEnrols`: whether the token may enrol it, or only a pairing code.
  | { kind: 'enrolling'; hello: DeviceHello; tokenEnrols: boolean }
  | { kind: 'open' }
  | { kind: 'failed' };

// A client reached through the relay. The relay only ever carries Noise ciphertext: the first
// frame must be the phone's IK handshake against this agent's static key, which tells the agent
// which phone it is before answering, so it refuses a revoked or unenrolled one. Nothing reaches
// the handler until the handshake has succeeded, and any failure closes the socket.
export class NoiseClientConnection implements ClientConnection {
  private session: SecureSession | null = null;
  private state: State = { kind: 'handshake' };
  private deviceKey: string | null = null;
  // What authenticates this client by its key: enrolled at the handshake, or paired just now.
  private keyAuth: 'device' | 'pairing' | null = null;
  // While an enrolment is being written, what the handler sends waits behind its authResult.
  private outbox: AgentMessage[] | null = null;
  // Messages that arrived while a pairing secret was being redeemed, in order.
  private held: unknown[] | null = null;
  private authAttempts = 0;
  // Set when the phone is served at once, until its first frame. Message 1 can be replayed by the
  // relay, so a pushed authResult does not end the deadline nor free the dial-back slot until the
  // phone has proven it holds the session keys by sending something.
  private awaitingPhone = false;
  // The pushed authResult went out while awaiting the phone: authenticated once it speaks.
  private deferredAuth = false;
  private readonly listeners: Array<(raw: unknown) => void> = [];
  private readonly keyAuthenticatedListeners: Array<() => void> = [];
  private readonly cancelDeadline: () => void;

  constructor(
    private readonly socket: FrameSocket,
    private readonly staticPrivate: Uint8Array,
    private readonly options: NoiseClientConnectionOptions,
  ) {
    this.cancelDeadline = (options.startTimer ?? startTimer)(() => this.fail('authentication timeout'), AUTH_TIMEOUT_MS);
    socket.onFrame((frame) => this.receive(frame));
    socket.onClose(() => this.cancelDeadline());
  }

  // The phone's X25519 device key, once its IK handshake has been read.
  get device(): string | null {
    return this.deviceKey;
  }

  get keyCredential(): 'device' | 'pairing' | undefined {
    return this.keyAuth !== null && this.state.kind !== 'failed' ? this.keyAuth : undefined;
  }

  // An accepted `auth` is answered with whether the device key is now enrolled: the phone drops
  // its token or pairing secret on `enrolled`, so for a new device the answer waits for the
  // roster to be written.
  send(message: AgentMessage): void {
    if (!this.session || this.state.kind === 'failed') return;
    if (this.outbox) {
      this.outbox.push(message);
      return;
    }
    if (message.type === 'authResult' && message.ok) {
      const accepted = message;
      if (!this.awaitingPhone) this.cancelDeadline();
      this.session.raiseCap(MAX_MESSAGE_BYTES);
      if (this.state.kind === 'enrolling') {
        const hello = this.state.hello;
        this.outbox = [];
        // What the phone sends behind its auth waits too: the roster may still refuse the device.
        this.held ??= [];
        void this.enrol(hello).then(async (outcome) => {
          if (outcome === 'declined') {
            this.held = null;
            this.fail(await this.declinedReason(), DEVICE_REFUSED);
            return;
          }
          const held = this.outbox ?? [];
          this.outbox = null;
          this.seal({ ...accepted, enrolled: outcome === 'enrolled' });
          this.options.onAuthenticated?.();
          held.forEach((m) => this.send(m));
          const incoming = this.held ?? [];
          this.held = null;
          incoming.forEach((raw) => this.dispatch(raw));
        });
        return;
      }
      if (this.keyAuth === 'device') message = { ...accepted, enrolled: true };
      this.seal(message);
      if (this.awaitingPhone) this.deferredAuth = true;
      else this.options.onAuthenticated?.();
      return;
    }
    this.seal(message);
  }

  private seal(message: AgentMessage): void {
    if (!this.session || this.state.kind === 'failed') return;
    for (const frame of this.session.seal(new TextEncoder().encode(JSON.stringify(message)))) {
      this.socket.send(frame);
    }
  }

  close(): void {
    this.socket.close();
  }

  refuse(reason: string): void {
    this.fail(reason, DEVICE_REFUSED);
  }

  onMessage(listener: (raw: unknown) => void): void {
    this.listeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.socket.onClose(listener);
  }

  onKeyAuthenticated(listener: () => void): void {
    this.keyAuthenticatedListeners.push(listener);
  }

  private receive(frame: Uint8Array): void {
    switch (this.state.kind) {
      case 'failed':
        return;
      case 'checking':
        // An honest phone waits for message 2 before sending anything.
        this.fail('secure channel failed');
        return;
      case 'handshake':
        this.handshake(frame);
        return;
      default:
        this.read(frame);
    }
  }

  private handshake(frame: Uint8Array): void {
    const pattern = handshakePattern(frame);
    if (pattern !== 'ik') {
      this.fail('secure channel failed');
      return;
    }
    let responder: IkResponder;
    let hello: DeviceHello | null;
    try {
      responder = new IkResponder(this.staticPrivate);
      hello = parseDeviceHello(responder.readMessage1(readHandshakeFrame(frame, 'ik')));
    } catch (err) {
      if (err instanceof WrongStaticKeyError) this.fail(REFUSAL.wrongAgentKey, DEVICE_REFUSED);
      else this.fail('secure channel failed');
      return;
    }
    if (!hello) {
      this.fail('secure channel failed');
      return;
    }
    const key = b64url.encode(responder.remoteStatic());
    this.deviceKey = key;
    this.state = { kind: 'checking' };
    Promise.all([this.options.devices.check(key), verifyDeviceHello(hello, responder.remoteStatic(), responder.payloadHash())]).then(
      ([{ standing, enrolment }, proven]) => this.admit(responder, hello, key, standing, enrolment, proven),
      () => this.fail('device roster unreadable'),
    );
  }

  // `proven`: the hello's relay key is the phone's own. An enrolled device is known by its X25519
  // key already; a new one must prove the relay key the agent is about to publish for it.
  private admit(responder: IkResponder, hello: DeviceHello, key: string, standing: DeviceStanding, enrolment: EnrolmentMode, proven: boolean): void {
    if (this.state.kind !== 'checking') return;
    const line = `relay client: device ${deviceFingerprint(key)} "${hello.name}" ${standing}`;
    if (standing === 'enrolled') this.options.log?.(line);
    else this.logRefusal(`handshake:${standing}`, line);
    if (standing === 'revoked') {
      this.fail(REFUSAL.revoked, DEVICE_REFUSED);
      return;
    }
    if (standing === 'unknown' && enrolment === 'closed') {
      this.fail(REFUSAL.notEnrolled, DEVICE_REFUSED);
      return;
    }
    if (standing === 'unknown' && !proven) {
      this.fail(REFUSAL.signature, DEVICE_REFUSED);
      return;
    }
    try {
      this.socket.send(handshakeFrame(responder.writeMessage2(), 'ik'));
      const { send, recv } = responder.split();
      this.session = new SecureSession(send, recv, { maxMessageBytes: PRE_AUTH_MAX_MESSAGE_BYTES });
    } catch {
      this.fail('secure channel failed');
      return;
    }
    this.keyAuth = standing === 'enrolled' ? 'device' : null;
    this.state = standing === 'enrolled' ? { kind: 'open' } : { kind: 'enrolling', hello, tokenEnrols: enrolment === 'on' };
    if (standing === 'enrolled' && hello.push && this.keyAuthenticatedListeners.length > 0 && this.options.pushBudget?.take(key)) {
      this.awaitingPhone = true;
      this.keyAuthenticatedListeners.forEach((l) => l());
    }
  }

  private read(frame: Uint8Array): void {
    let message: Uint8Array | null;
    try {
      message = this.session!.open(frame);
    } catch {
      this.fail('secure channel failed');
      return;
    }
    if (this.awaitingPhone) {
      this.awaitingPhone = false;
      if (this.deferredAuth) {
        this.cancelDeadline();
        this.options.onAuthenticated?.();
      }
    }
    if (!message) return;
    const text = new TextDecoder().decode(message);
    let raw: unknown = text;
    try {
      raw = JSON.parse(text);
    } catch {
      // Handed on as text; the handler answers it as an invalid message.
    }
    this.dispatch(raw);
  }

  private dispatch(raw: unknown): void {
    if (this.held) {
      this.held.push(raw);
      return;
    }
    if (this.state.kind === 'failed') return;
    const message = raw as { type?: unknown; token?: unknown } | null;
    if (message?.type === 'auth' && ++this.authAttempts > MAX_AUTH_ATTEMPTS) {
      this.fail('too many auth attempts');
      return;
    }
    // An unknown device may send `auth` and nothing else, and one with no credential at all (a
    // phone whose enrolment was lost since it paired) can only be told to pair again.
    if (this.state.kind === 'enrolling' && (message?.type !== 'auth' || message.token === '')) {
      this.fail(REFUSAL.notEnrolled, DEVICE_REFUSED);
      return;
    }
    // A pairing secret in place of the token is spent before the handler answers: for a new
    // device, so the `authResult ok` that enrols it is backed by a secret nobody else can use
    // again; for an enrolled one, which needs no code, so the link admits nobody after it.
    const pairing = message?.type === 'auth' && typeof message.token === 'string' && PAIRING_SECRET.test(message.token);
    if (pairing && (this.state.kind === 'enrolling' || this.keyAuth !== null)) {
      this.spendPairing(message.token as string, raw);
      return;
    }
    if (this.refusesToken()) return;
    this.listeners.forEach((l) => l(raw));
  }

  private spendPairing(secret: string, auth: unknown): void {
    this.held = [];
    const key = this.deviceKey!;
    const fingerprint = deviceFingerprint(key);
    const resume = (redemption: Redemption) => {
      if (redemption.redeemed && this.keyAuth === null) this.keyAuth = 'pairing';
      if (redemption.redeemed && redemption.fresh) this.options.log?.(`relay client: pairing code used by device ${fingerprint}`);
      const held = this.held ?? [];
      this.held = null;
      if (this.state.kind === 'failed') return;
      // A code this agent knows is dead (spent, or expired since the relay let it through): say
      // so. An unknown one may be a token after all, so the handler checks it.
      if (!redemption.redeemed && redemption.reason) {
        this.logRefusal(redemption.reason, `relay client: device ${fingerprint} refused: ${redemption.reason}`);
        this.fail(redemption.reason, DEVICE_REFUSED);
        return;
      }
      if (!redemption.redeemed && this.refusesToken()) return;
      this.listeners.forEach((l) => l(auth));
      held.forEach((raw) => this.dispatch(raw));
    };
    const failed = () => resume({ redeemed: false });
    if (this.state.kind === 'enrolling') {
      this.options.devices.redeemPairing(secret, key).then(resume, failed);
    } else {
      // An enrolled device is served whatever became of the code: its key is its credential.
      this.options.devices.burnPairing(secret, key).then(
        (burned) => resume({ redeemed: true, fresh: burned }),
        () => resume({ redeemed: true, fresh: false }),
      );
    }
  }

  // An unknown device whose `auth` is about to be checked as a token, while only a pairing code
  // may enrol it: refused here, so the token never gets as far as the handler.
  private refusesToken(): boolean {
    if (this.state.kind !== 'enrolling' || this.state.tokenEnrols || this.keyAuth !== null) return false;
    this.logRefusal('token-off', `relay client: device ${deviceFingerprint(this.deviceKey!)} refused: token enrolment is off`);
    this.fail(REFUSAL.enrolmentOff, DEVICE_REFUSED);
    return true;
  }

  // `declined`: the roster would not take the device (enrolment turned off or closed since the
  // handshake, or its id taken), so the credential that authenticated this session no longer
  // admits it. `failed`: the write itself failed; the session goes on unenrolled, and the phone
  // keeps its credential to try again.
  private async enrol(hello: DeviceHello): Promise<'enrolled' | 'declined' | 'failed'> {
    const key = this.deviceKey!;
    // Only a redeemed pairing secret authenticates an unknown key before `authResult`.
    const via = this.keyAuth === 'pairing' ? 'pairing' : 'token';
    this.state = { kind: 'open' };
    try {
      const enrolled = await this.options.devices.enrol({ x25519: key, ed25519: hello.sig, name: hello.name }, via);
      this.options.log?.(
        enrolled
          ? `relay client: enrolled device ${deviceFingerprint(key)} "${hello.name}"`
          : `relay client: device ${deviceFingerprint(key)} not enrolled (enrolment changed meanwhile, or its id is taken); closing its session`,
      );
      return enrolled ? 'enrolled' : 'declined';
    } catch (err) {
      this.options.log?.(`relay client: enrolling ${deviceFingerprint(key)} failed: ${String(err)}`);
      return 'failed';
    }
  }

  private async declinedReason(): Promise<string> {
    try {
      const { enrolment } = await this.options.devices.check(this.deviceKey!);
      if (enrolment === 'closed') return REFUSAL.enrolmentClosed;
      if (enrolment === 'off' && this.keyAuth !== 'pairing') return REFUSAL.enrolmentOff;
    } catch {
      // Named generically below.
    }
    return REFUSAL.enrolmentRefused;
  }

  private logRefusal(key: string, line: string): void {
    if (this.options.refusalLog) this.options.refusalLog.line(key, line);
    else this.options.log?.(line);
  }

  private fail(reason: string, code = SECURE_CHANNEL_FAILED): void {
    if (this.state.kind === 'failed') return;
    this.state = { kind: 'failed' };
    this.cancelDeadline();
    this.socket.close(code, reason);
  }
}
