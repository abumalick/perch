import { describe, expect, it } from 'vitest';
import {
  IkInitiator,
  SecureSession,
  b64url,
  deviceFingerprint,
  ed25519Signer,
  encodeDeviceHello,
  signDeviceHello,
  generateAgentKeys,
  generateDeviceKeys,
  handshakeFrame,
  rawStaticKey,
  readHandshakeFrame,
  REFUSAL,
} from '@perch/secure-channel';
import type { FrameSocket } from '../ports/frame-socket';
import type { DeviceStanding, EnrolmentMode } from '../application/device-roster';
import type { DeviceGate, Redemption } from '../ports/device-gate-port';
import type { AgentRefusal } from '@perch/secure-channel';
import { NoiseClientConnection } from './noise-client-connection';

class FakeFrameSocket implements FrameSocket {
  sent: Uint8Array[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  private frameListeners: Array<(frame: Uint8Array) => void> = [];
  private closeListeners: Array<() => void> = [];

  send(frame: Uint8Array): void {
    this.sent.push(frame);
  }
  onFrame(listener: (frame: Uint8Array) => void): void {
    this.frameListeners.push(listener);
  }
  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.closeListeners.forEach((l) => l());
  }
  deliver(frame: Uint8Array): void {
    this.frameListeners.forEach((l) => l(frame));
  }
}

const agentKeys = generateAgentKeys();
const staticPrivate = b64url.decode(agentKeys.x25519.privateKey);
const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

class FakeGate implements DeviceGate {
  standings = new Map<string, DeviceStanding>();
  enrolment: EnrolmentMode = 'on';
  enrolled: Array<{ x25519: string; ed25519: string; name: string }> = [];
  enrolledVia: Array<'pairing' | 'token'> = [];
  pairings = new Set<string>();
  // Secrets this gate knows are dead, and why.
  dead = new Map<string, AgentRefusal>();
  redeemed: string[] = [];
  burned: Array<{ secret: string; device: string }> = [];
  async redeemPairing(secret: string, _device: string): Promise<Redemption> {
    this.redeemed.push(secret);
    if (this.pairings.delete(secret)) return { redeemed: true, fresh: true };
    const reason = this.dead.get(secret);
    return reason ? { redeemed: false, reason } : { redeemed: false };
  }
  async burnPairing(secret: string, device: string): Promise<boolean> {
    this.burned.push({ secret, device });
    return this.pairings.delete(secret);
  }
  async check(x25519: string) {
    return { standing: this.standings.get(x25519) ?? 'unknown', enrolment: this.enrolment };
  }
  // Resolves an enrolment; replace to hold it or make it fail.
  enrolWrite: () => Promise<boolean> = async () => true;
  async enrol(device: { x25519: string; ed25519: string; name: string }, via: 'pairing' | 'token') {
    this.enrolled.push(device);
    this.enrolledVia.push(via);
    const written = await this.enrolWrite();
    if (written) this.standings.set(device.x25519, 'enrolled');
    return written;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
// Until the connection has answered the handshake or closed: checking the hello's proof is
// asynchronous (WebCrypto).
async function settled(socket: FakeFrameSocket): Promise<void> {
  for (let i = 0; i < 100 && socket.sent.length === 0 && !socket.closedWith; i++) await flush();
}

function setup() {
  const socket = new FakeFrameSocket();
  const budget = { allow: true };
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const gate = new FakeGate();
  const logs: string[] = [];
  const authenticated: string[] = [];
  const pushes: string[] = [];
  const conn = new NoiseClientConnection(socket, staticPrivate, {
    devices: gate,
    pushBudget: { take: () => budget.allow },
    onAuthenticated: () => authenticated.push('auth'),
    log: (m) => logs.push(m),
    startTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const received: unknown[] = [];
  conn.onMessage((raw) => received.push(raw));
  conn.onKeyAuthenticated(() => pushes.push('push'));
  return { socket, conn, received, timers, gate, logs, authenticated, pushes, budget };
}

// Plays a phone with a device key: an IK handshake, then its end of the session. Its hello proves
// its relay key, unless `hello` says otherwise.
async function ikHandshake(
  socket: FakeFrameSocket,
  device = generateDeviceKeys(),
  hello: { proof?: boolean; relayKey?: string; push?: boolean } = {},
): Promise<SecureSession> {
  const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), b64url.decode(agentKeys.x25519.publicKey));
  const payload = async (hash: Uint8Array) =>
    encodeDeviceHello({
      sig: hello.relayKey ?? device.ed25519.publicKey,
      name: 'test phone',
      ...(hello.push ? { push: true } : {}),
      ...(hello.proof === false
        ? {}
        : { proof: await signDeviceHello(ed25519Signer(device.ed25519.privateKey), b64url.decode(device.x25519.publicKey), hash) }),
    });
  socket.deliver(handshakeFrame(await initiator.writeMessage1(payload), 'ik'));
  await settled(socket);
  await initiator.readMessage2(readHandshakeFrame(socket.sent[0]!, 'ik'));
  const { send, recv } = initiator.split();
  return new SecureSession(send, recv);
}

// Plays an enrolled phone: handshakes against the connection and returns its end of the session.
function handshake(socket: FakeFrameSocket, gate: FakeGate): Promise<SecureSession> {
  const device = generateDeviceKeys();
  gate.standings.set(device.x25519.publicKey, 'enrolled');
  return ikHandshake(socket, device);
}

describe('NoiseClientConnection', () => {
  it('completes the handshake, then hands decrypted messages to the handler as JSON', async () => {
    const { socket, received, gate } = setup();
    const phone = await handshake(socket, gate);
    for (const frame of phone.seal(utf8({ type: 'auth', token: 't' }))) socket.deliver(frame);
    expect(received).toEqual([{ type: 'auth', token: 't' }]);
  });

  it('encrypts what the handler sends', async () => {
    const { socket, conn, gate } = setup();
    const phone = await handshake(socket, gate);
    conn.send({ type: 'authResult', ok: true });
    const replies = socket.sent.slice(1).map((f) => phone.open(f)).filter((m): m is Uint8Array => m !== null);
    expect(replies.map((m) => JSON.parse(new TextDecoder().decode(m)))).toEqual([{ type: 'authResult', ok: true, enrolled: true }]);
  });

  it('reassembles a message larger than one frame', async () => {
    const { socket, conn, received, gate } = setup();
    const phone = await handshake(socket, gate);
    conn.send({ type: 'authResult', ok: true });
    const data = 'x'.repeat(1024 * 1024);
    const frames = phone.seal(utf8({ type: 'input', id: 'w', data }));
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) socket.deliver(frame);
    expect(received).toEqual([{ type: 'input', id: 'w', data }]);
  });

  // Before `auth` is accepted, only small messages are read: a relay or a stranger cannot make
  // the agent buffer 32 MiB on a socket that has proven nothing.
  it('refuses a large message before auth is accepted', async () => {
    const { socket, received, gate } = setup();
    const phone = await handshake(socket, gate);
    for (const frame of phone.seal(utf8({ type: 'auth', token: 'x'.repeat(64 * 1024) }))) socket.deliver(frame);
    expect(socket.closedWith?.code).toBe(4002);
    expect(received).toEqual([]);
  });

  it('closes a socket that keeps sending auth', async () => {
    const { socket, received, gate } = setup();
    const phone = await handshake(socket, gate);
    for (let i = 0; i < 4; i++) for (const frame of phone.seal(utf8({ type: 'auth', token: '' }))) socket.deliver(frame);
    expect(received).toHaveLength(3);
    expect(socket.closedWith).toEqual({ code: 4002, reason: 'too many auth attempts' });
  });

  it('closes without parsing anything when the first frame is not a valid handshake', () => {
    const { socket, received } = setup();
    socket.deliver(new TextEncoder().encode(JSON.stringify({ type: 'auth', token: 't' })));
    expect(socket.closedWith?.code).toBe(4002);
    expect(received).toEqual([]);
  });

  // The phone could not tell this from tampering, so it would keep redialing a typo.
  it('closes with "wrong agent key" when the phone pinned another agent key', async () => {
    const { socket, received } = setup();
    const device = generateDeviceKeys();
    const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), b64url.decode(generateAgentKeys().x25519.publicKey));
    socket.deliver(handshakeFrame(await initiator.writeMessage1(encodeDeviceHello({ sig: device.ed25519.publicKey, name: 'test phone' })), 'ik'));
    await flush();
    expect(socket.closedWith).toEqual({ code: 4003, reason: REFUSAL.wrongAgentKey });
    expect(socket.sent).toEqual([]);
    expect(received).toEqual([]);
  });

  it('closes on a tampered frame after the handshake and delivers nothing more', async () => {
    const { socket, received, gate } = setup();
    const phone = await handshake(socket, gate);
    const [frame] = phone.seal(utf8({ type: 'list' }));
    frame![3]! ^= 1;
    socket.deliver(frame!);
    expect(socket.closedWith?.code).toBe(4002);
    for (const good of phone.seal(utf8({ type: 'list' }))) socket.deliver(good);
    expect(received).toEqual([]);
  });

  it('closes a socket that has not completed the handshake within the deadline', () => {
    const { socket, received, timers } = setup();
    expect(timers.map((t) => t.ms)).toEqual([10_000]);
    timers[0]!.fn();
    expect(socket.closedWith).toEqual({ code: 4002, reason: 'authentication timeout' });
    expect(received).toEqual([]);
  });

  it('keeps the deadline running after the handshake until auth succeeds', async () => {
    // The handshake alone must not let a socket sit on one of the relay's pair slots.
    const { socket, conn, timers, gate } = setup();
    const phone = await handshake(socket, gate);
    for (const frame of phone.seal(utf8({ type: 'list' }))) socket.deliver(frame);
    conn.send({ type: 'error', code: 'unauthorized', message: 'authenticate first' });
    conn.send({ type: 'authResult', ok: false });
    expect(timers[0]!.cancelled).toBe(false);
    timers[0]!.fn();
    expect(socket.closedWith).toEqual({ code: 4002, reason: 'authentication timeout' });
  });

  it('cancels the deadline once the handler accepts the token', async () => {
    const { socket, conn, received, timers, gate } = setup();
    const phone = await handshake(socket, gate);
    conn.send({ type: 'authResult', ok: true });
    expect(timers[0]!.cancelled).toBe(true);
    for (const frame of phone.seal(utf8({ type: 'list' }))) socket.deliver(frame);
    expect(received).toEqual([{ type: 'list' }]);
    expect(socket.closedWith).toBeNull();
  });

  // The relay link counts a dial-back against its budget until then.
  it('reports authentication once the accepted authResult goes out, and only then', async () => {
    const { socket, conn, gate, authenticated } = setup();
    await handshake(socket, gate);
    conn.send({ type: 'authResult', ok: false });
    expect(authenticated).toEqual([]);
    conn.send({ type: 'authResult', ok: true });
    expect(authenticated).toEqual(['auth']);
  });

  it('reports a new device authenticated once its enrolment is written', async () => {
    const { socket, conn, gate, authenticated } = setup();
    let write!: (ok: boolean) => void;
    gate.enrolWrite = () => new Promise((r) => (write = r));
    const phone = await ikHandshake(socket);
    for (const frame of phone.seal(utf8({ type: 'auth', token: 't' }))) socket.deliver(frame);
    conn.send({ type: 'authResult', ok: true });
    await flush();
    expect(authenticated).toEqual([]);
    write(true);
    await flush();
    expect(authenticated).toEqual(['auth']);
  });

  it('sends nothing before the handshake completes', () => {
    const { socket, conn } = setup();
    conn.send({ type: 'authResult', ok: true });
    expect(socket.sent).toEqual([]);
  });
});

const replies = (socket: FakeFrameSocket, phone: SecureSession) =>
  socket.sent
    .slice(1)
    .map((f) => phone.open(f))
    .filter((m): m is Uint8Array => m !== null)
    .map((m) => JSON.parse(new TextDecoder().decode(m)) as Record<string, unknown>);

// A phone whose key is enrolled is authenticated by the handshake alone, so one that asks (`push`
// in its hello) is served at once: the agent answers `authResult` and the opening requests right
// behind message 2, a round trip sooner. Message 1 can be replayed by the relay, so the session
// still counts as unauthenticated (deadline, dial-back slot) until the phone itself speaks in it.
describe('NoiseClientConnection serving an enrolled device at once', () => {
  const enrolledPhone = (gate: FakeGate) => {
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    return device;
  };
  const deliver = (socket: FakeFrameSocket, phone: SecureSession, message: unknown) => {
    for (const frame of phone.seal(utf8(message))) socket.deliver(frame);
  };

  it('offers it right after message 2 to an enrolled device that asked', async () => {
    const { socket, gate, pushes } = setup();
    await ikHandshake(socket, enrolledPhone(gate), { push: true });
    expect(pushes).toEqual(['push']);
  });

  it('offers nothing to an enrolled device that did not ask, nor to an unknown one that did', async () => {
    const quiet = setup();
    await ikHandshake(quiet.socket, enrolledPhone(quiet.gate));
    expect(quiet.pushes).toEqual([]);
    const unknown = setup();
    const phone = await ikHandshake(unknown.socket, generateDeviceKeys(), { push: true });
    expect(unknown.pushes).toEqual([]);
    // Still the unknown device's rule: auth and nothing else.
    deliver(unknown.socket, phone, { type: 'list' });
    expect(unknown.socket.closedWith).toEqual({ code: 4003, reason: 'device not enrolled' });
  });

  // Each replay of a message 1 would make the agent build the workspace list again.
  it('serves the old way once the push budget for that key is spent', async () => {
    const { socket, gate, pushes, budget } = setup();
    budget.allow = false;
    await ikHandshake(socket, enrolledPhone(gate), { push: true });
    expect(pushes).toEqual([]);
  });

  it('seals the pushed authResult as enrolled, but counts the session authenticated only once the phone speaks', async () => {
    const { socket, conn, gate, timers, authenticated } = setup();
    const phone = await ikHandshake(socket, enrolledPhone(gate), { push: true });
    conn.send({ type: 'authResult', ok: true, credential: 'device' });
    expect(replies(socket, phone)).toEqual([{ type: 'authResult', ok: true, credential: 'device', enrolled: true }]);
    expect(timers[0]!.cancelled).toBe(false);
    expect(authenticated).toEqual([]);
    deliver(socket, phone, { type: 'auth', token: '' });
    expect(timers[0]!.cancelled).toBe(true);
    expect(authenticated).toEqual(['auth']);
    deliver(socket, phone, { type: 'list' });
    expect(authenticated).toEqual(['auth']);
  });

  // A replayed message 1: the agent's answer is unreadable to whoever replayed it, and nothing it
  // sends back can be opened, so the session is closed at the usual deadline.
  it('closes a pushed session in which the phone never speaks', async () => {
    const { socket, conn, gate, timers, authenticated } = setup();
    await ikHandshake(socket, enrolledPhone(gate), { push: true });
    conn.send({ type: 'authResult', ok: true, credential: 'device' });
    timers[0]!.fn();
    expect(socket.closedWith).toEqual({ code: 4002, reason: 'authentication timeout' });
    expect(authenticated).toEqual([]);
  });
});

describe('NoiseClientConnection with device keys (IK)', () => {
  const deliver = (socket: FakeFrameSocket, phone: SecureSession, message: unknown) => {
    for (const frame of phone.seal(utf8(message))) socket.deliver(frame);
  };

  it('serves an enrolled device like any client', async () => {
    const { socket, received, gate, logs } = setup();
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    const phone = await ikHandshake(socket, device);
    deliver(socket, phone, { type: 'auth', token: 't' });
    deliver(socket, phone, { type: 'list' });
    expect(received).toEqual([{ type: 'auth', token: 't' }, { type: 'list' }]);
    expect(logs.join('\n')).toMatch(/device .* "test phone" enrolled/);
  });

  it("refuses an unknown device whose hello does not prove its relay key, or names another phone's", async () => {
    for (const hello of [{ proof: false }, { relayKey: generateDeviceKeys().ed25519.publicKey }]) {
      const { socket, gate } = setup();
      // The phone's side fails once the agent closes without answering.
      const attempt = ikHandshake(socket, generateDeviceKeys(), hello).catch(() => undefined);
      await settled(socket);
      await flush();
      expect(socket.sent).toEqual([]);
      expect(socket.closedWith).toEqual({ code: 4003, reason: 'device signature invalid' });
      expect(gate.enrolled).toEqual([]);
      await attempt;
    }
  });

  it('serves an enrolled device whose hello carries no proof, as an older PWA sends it', async () => {
    const { socket, received, gate } = setup();
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    const phone = await ikHandshake(socket, device, { proof: false });
    deliver(socket, phone, { type: 'auth', token: '' });
    expect(received).toEqual([{ type: 'auth', token: '' }]);
  });

  it('refuses a revoked device before answering the handshake', async () => {
    const { socket, gate } = setup();
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'revoked');
    const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), b64url.decode(agentKeys.x25519.publicKey));
    socket.deliver(handshakeFrame(await initiator.writeMessage1(encodeDeviceHello({ sig: device.ed25519.publicKey, name: 'p' })), 'ik'));
    await flush();
    expect(socket.sent).toEqual([]);
    expect(socket.closedWith).toEqual({ code: 4003, reason: 'device revoked' });
  });

  it('refuses an unknown device while enrolment is closed', async () => {
    const { socket, gate } = setup();
    gate.enrolment = 'closed';
    const device = generateDeviceKeys();
    const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), b64url.decode(agentKeys.x25519.publicKey));
    socket.deliver(handshakeFrame(await initiator.writeMessage1(encodeDeviceHello({ sig: device.ed25519.publicKey, name: 'p' })), 'ik'));
    await flush();
    expect(socket.closedWith).toEqual({ code: 4003, reason: 'device not enrolled' });
  });

  it('lets an unknown device send only auth, and enrols it once the token is accepted', async () => {
    const { socket, conn, received, gate } = setup();
    const device = generateDeviceKeys();
    const phone = await ikHandshake(socket, device);
    deliver(socket, phone, { type: 'auth', token: 't' });
    expect(received).toEqual([{ type: 'auth', token: 't' }]);
    expect(gate.enrolled).toEqual([]);
    conn.send({ type: 'authResult', ok: true });
    await flush();
    expect(gate.enrolled).toEqual([{ x25519: device.x25519.publicKey, ed25519: device.ed25519.publicKey, name: 'test phone' }]);
    expect(gate.enrolledVia).toEqual(['token']);
    deliver(socket, phone, { type: 'list' });
    expect(received.at(-1)).toEqual({ type: 'list' });
  });

  // The phone forgets its token once its key is enrolled, so `enrolled` must mean written: the
  // authResult waits for the roster, and whatever the handler sends meanwhile follows it.
  it('answers authResult only once the enrolment is written, saying so, and keeps what follows in order', async () => {
    const { socket, conn, gate } = setup();
    let write!: (ok: boolean) => void;
    gate.enrolWrite = () => new Promise((r) => (write = r));
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 't' });
    conn.send({ type: 'authResult', ok: true, credential: 'token' });
    conn.send({ type: 'workspaces', workspaces: [] });
    await flush();
    expect(replies(socket, phone)).toEqual([]);
    write(true);
    await flush();
    expect(replies(socket, phone)).toEqual([
      { type: 'authResult', ok: true, credential: 'token', enrolled: true },
      { type: 'workspaces', workspaces: [] },
    ]);
  });

  it('says the key is not enrolled when the roster could not be written, so the phone keeps its token', async () => {
    const { socket, conn, gate } = setup();
    gate.enrolWrite = async () => {
      throw new Error('devices.json is locked');
    };
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 't' });
    conn.send({ type: 'authResult', ok: true, credential: 'token' });
    await flush();
    expect(replies(socket, phone)).toEqual([{ type: 'authResult', ok: true, credential: 'token', enrolled: false }]);
  });

  // The operator turned enrolment off (or closed it) between the phone's handshake and its auth:
  // the token that authenticated this session may no longer enrol, so it does not get a session.
  it.each([
    ['off', 'token', 'enrolment off'],
    ['closed', 'token', 'enrolment closed'],
    ['on', 'token', 'enrolment refused'],
  ] as const)('closes the session when the roster declines the enrolment (mode %s, %s)', async (mode, _via, reason) => {
    const { socket, conn, gate, authenticated } = setup();
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 't' });
    gate.enrolment = mode;
    gate.enrolWrite = async () => false;
    conn.send({ type: 'authResult', ok: true, credential: 'token' });
    conn.send({ type: 'workspaces', workspaces: [] });
    await flush();
    await flush();
    expect(replies(socket, phone)).toEqual([]);
    expect(socket.closedWith).toEqual({ code: 4003, reason });
    expect(authenticated).toEqual([]);
  });

  // The credential was good at the handshake, but the roster may still refuse the device: nothing
  // sent behind the auth may reach the handler before the roster has answered.
  // A hostile relay can dial in one stranger after another; the lines they cause go through the
  // agent's shared limiter, while an enrolled device is named every time.
  it('logs what strangers cause through the shared limiter, and enrolled devices in full', async () => {
    const logs: string[] = [];
    const limited: Array<{ key: string; text: string }> = [];
    const gate = new FakeGate();
    gate.enrolment = 'off';
    const open = () => {
      const socket = new FakeFrameSocket();
      new NoiseClientConnection(socket, staticPrivate, {
        devices: gate,
        log: (m) => logs.push(m),
        refusalLog: { line: (key, text) => limited.push({ key, text }) },
        startTimer: () => () => {},
      });
      return socket;
    };
    for (let i = 0; i < 3; i++) {
      const socket = open();
      deliver(socket, await ikHandshake(socket), { type: 'auth', token: 't' });
    }
    const known = open();
    await handshake(known, gate);
    expect(limited.map((l) => l.key)).toEqual(['handshake:unknown', 'token-off', 'handshake:unknown', 'token-off', 'handshake:unknown', 'token-off']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/" enrolled$/);
  });

  it('holds what the phone sends behind an accepted auth until the enrolment is written', async () => {
    const { socket, conn, received, gate } = setup();
    let write!: (ok: boolean) => void;
    gate.enrolWrite = () => new Promise((r) => (write = r));
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 't' });
    conn.send({ type: 'authResult', ok: true, credential: 'token' });
    deliver(socket, phone, { type: 'list' });
    deliver(socket, phone, { type: 'listCommands' });
    await flush();
    expect(received).toEqual([{ type: 'auth', token: 't' }]);
    write(true);
    await flush();
    expect(received).toEqual([{ type: 'auth', token: 't' }, { type: 'list' }, { type: 'listCommands' }]);
  });

  it('drops what the phone sent behind its auth when the roster declines the enrolment', async () => {
    const { socket, conn, received, gate } = setup();
    let write!: (ok: boolean) => void;
    gate.enrolWrite = () => new Promise((r) => (write = r));
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 't' });
    conn.send({ type: 'authResult', ok: true, credential: 'token' });
    deliver(socket, phone, { type: 'create', name: 'x', path: '/', command: 'touch pwned' });
    gate.enrolment = 'off';
    write(false);
    await flush();
    await flush();
    expect(received).toEqual([{ type: 'auth', token: 't' }]);
    expect(socket.closedWith?.code).toBe(4003);
  });

  it('hands on what the phone sent behind its auth when the roster write failed, as the session goes on', async () => {
    const { socket, conn, received, gate } = setup();
    gate.enrolWrite = async () => {
      throw new Error('devices.json is locked');
    };
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 't' });
    conn.send({ type: 'authResult', ok: true, credential: 'token' });
    deliver(socket, phone, { type: 'list' });
    await flush();
    expect(received).toEqual([{ type: 'auth', token: 't' }, { type: 'list' }]);
  });

  it('holds what follows a redeemed pairing code until the enrolment is written', async () => {
    const { socket, conn, received, gate } = setup();
    const secret = 'p'.repeat(43);
    gate.pairings.add(secret);
    let write!: (ok: boolean) => void;
    gate.enrolWrite = () => new Promise((r) => (write = r));
    conn.onMessage((raw) => {
      if ((raw as { type?: string }).type === 'auth') conn.send({ type: 'authResult', ok: true, credential: 'pairing' });
    });
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: secret });
    deliver(socket, phone, { type: 'list' });
    await flush();
    await flush();
    expect(received).toEqual([{ type: 'auth', token: secret }]);
    write(true);
    await flush();
    expect(received).toEqual([{ type: 'auth', token: secret }, { type: 'list' }]);
  });

  it('tells an enrolled device its key is enrolled', async () => {
    const { socket, conn, gate } = setup();
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    const phone = await ikHandshake(socket, device);
    deliver(socket, phone, { type: 'auth', token: '' });
    conn.send({ type: 'authResult', ok: true, credential: 'device' });
    expect(replies(socket, phone)).toEqual([{ type: 'authResult', ok: true, credential: 'device', enrolled: true }]);
  });

  // A phone that paired, then lost its enrolment (forgotten, or the roster was reset), has no
  // token to offer: it needs pairing again, whatever the enrolment mode says of the token.
  it('refuses an unknown device that offers no credential as not enrolled, in every mode', async () => {
    for (const mode of ['on', 'off'] as const) {
      const { socket, received, gate } = setup();
      gate.enrolment = mode;
      const phone = await ikHandshake(socket);
      deliver(socket, phone, { type: 'auth', token: '' });
      await flush();
      expect(received).toEqual([]);
      expect(socket.closedWith).toEqual({ code: 4003, reason: 'device not enrolled' });
    }
  });

  it('refuses the token from an unknown device while enrolment is off, before the handler sees it', async () => {
    const { socket, received, gate } = setup();
    gate.enrolment = 'off';
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 't' });
    await flush();
    expect(received).toEqual([]);
    expect(socket.closedWith).toEqual({ code: 4003, reason: 'enrolment off' });
    expect(gate.enrolled).toEqual([]);
  });

  it('refuses a pairing-shaped secret it does not know while enrolment is off, rather than try it as a token', async () => {
    const { socket, received, gate } = setup();
    gate.enrolment = 'off';
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 'q'.repeat(43) });
    await flush();
    expect(received).toEqual([]);
    expect(socket.closedWith).toEqual({ code: 4003, reason: 'enrolment off' });
  });

  it('still enrols a phone with a pairing code while enrolment is off', async () => {
    const { socket, conn, gate } = setup();
    gate.enrolment = 'off';
    const secret = 'p'.repeat(43);
    gate.pairings.add(secret);
    const device = generateDeviceKeys();
    const phone = await ikHandshake(socket, device);
    deliver(socket, phone, { type: 'auth', token: secret });
    await flush();
    conn.send({ type: 'authResult', ok: true });
    await flush();
    expect(socket.closedWith).toBeNull();
    expect(gate.enrolled.map((d) => d.x25519)).toEqual([device.x25519.publicKey]);
    expect(gate.enrolledVia).toEqual(['pairing']);
  });

  it('serves an enrolled device whatever the enrolment mode', async () => {
    const { socket, gate, received } = setup();
    gate.enrolment = 'closed';
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    const phone = await ikHandshake(socket, device);
    deliver(socket, phone, { type: 'list' });
    expect(socket.closedWith).toBeNull();
    expect(received).toEqual([{ type: 'list' }]);
  });

  it('closes an unknown device that sends anything before auth, without handing it on', async () => {
    const { socket, received, gate } = setup();
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'list' });
    expect(received).toEqual([]);
    expect(socket.closedWith).toEqual({ code: 4003, reason: 'device not enrolled' });
    expect(gate.enrolled).toEqual([]);
  });

  it('does not enrol a device whose token was refused', async () => {
    const { socket, conn, gate } = setup();
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 'wrong' });
    conn.send({ type: 'authResult', ok: false });
    await flush();
    expect(gate.enrolled).toEqual([]);
  });

  it('is authenticated by its key once enrolled, so a phone paired without a token gets in', async () => {
    const { socket, conn, gate } = setup();
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    expect(conn.keyCredential).toBeUndefined();
    await ikHandshake(socket, device);
    expect(conn.keyCredential).toBe('device');
  });

  it('never counts an unknown device as authenticated by its key', async () => {
    const { socket, conn } = setup();
    await ikHandshake(socket);
    expect(conn.keyCredential).toBeUndefined();
  });

  it('redeems a pairing secret sent as the auth token, then enrols the device on authResult ok', async () => {
    const { socket, conn, received, gate, logs } = setup();
    const secret = 'p'.repeat(43);
    gate.pairings.add(secret);
    const device = generateDeviceKeys();
    const phone = await ikHandshake(socket, device);
    deliver(socket, phone, { type: 'auth', token: secret });
    expect(received).toEqual([]);
    await flush();
    expect(gate.redeemed).toEqual([secret]);
    expect(conn.keyCredential).toBe('pairing');
    expect(received).toEqual([{ type: 'auth', token: secret }]);
    conn.send({ type: 'authResult', ok: true });
    await flush();
    expect(gate.enrolled.map((d) => d.x25519)).toEqual([device.x25519.publicKey]);
    expect(logs.join('\n')).toContain(`pairing code used by device ${deviceFingerprint(device.x25519.publicKey)}`);
    expect(logs.join('\n')).not.toContain(secret);
  });

  // While a pairing secret is being redeemed, what the phone sends waits. The relay forwards
  // whatever the sender pushes meanwhile, so the wait is bounded in attempts and in messages.
  it('counts auth attempts as they arrive while a pairing secret is being redeemed', async () => {
    const { socket, received, gate } = setup();
    let redeem!: (value: Redemption) => void;
    gate.redeemPairing = () => new Promise((resolve) => { redeem = resolve; });
    const phone = await ikHandshake(socket);
    for (let i = 0; i < 4; i += 1) deliver(socket, phone, { type: 'auth', token: 'q'.repeat(43) });
    expect(socket.closedWith).toEqual({ code: 4002, reason: 'too many auth attempts' });
    redeem({ redeemed: false });
    await flush();
    expect(received).toEqual([]);
  });

  it('does not count a held auth again when the queue drains', async () => {
    const { socket, received, gate } = setup();
    const secret = 'p'.repeat(43);
    gate.pairings.add(secret);
    let redeem!: (value: Redemption) => void;
    // The first redemption is held; the held auths are then redeemed by the gate as usual.
    const usual = gate.redeemPairing.bind(gate);
    gate.redeemPairing = () => {
      gate.redeemPairing = usual;
      return new Promise((resolve) => { redeem = resolve; });
    };
    const phone = await ikHandshake(socket);
    for (let i = 0; i < 3; i += 1) deliver(socket, phone, { type: 'auth', token: secret });
    expect(socket.closedWith).toBeNull();
    redeem({ redeemed: true, fresh: true });
    await flush();
    expect(socket.closedWith).toBeNull();
    expect(received).toHaveLength(3);
  });

  it('closes a sender that queues more than 16 messages while its credential is checked', async () => {
    const { socket, received, gate } = setup();
    let redeem!: (value: Redemption) => void;
    gate.redeemPairing = () => new Promise((resolve) => { redeem = resolve; });
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 'q'.repeat(43) });
    for (let i = 0; i < 16; i += 1) deliver(socket, phone, { type: 'list', n: i });
    expect(socket.closedWith).toBeNull();
    deliver(socket, phone, { type: 'list', n: 16 });
    expect(socket.closedWith).toEqual({ code: 4002, reason: 'too many messages before auth' });
    redeem({ redeemed: false });
    await flush();
    expect(received).toEqual([]);
  });

  it('does not authenticate a spent or unknown pairing secret; the handler then checks it as a token', async () => {
    const { socket, conn, received, gate } = setup();
    const phone = await ikHandshake(socket);
    deliver(socket, phone, { type: 'auth', token: 'q'.repeat(43) });
    await flush();
    expect(conn.keyCredential).toBeUndefined();
    expect(received).toEqual([{ type: 'auth', token: 'q'.repeat(43) }]);
    expect(gate.enrolled).toEqual([]);
  });

  it('closes the session with 4003 and why, for a pairing code spent or expired since the relay let it through', async () => {
    for (const reason of ['pairing code used', 'pairing code expired', 'enrolment closed'] as const) {
      const { socket, received, gate, logs } = setup();
      const secret = 'p'.repeat(43);
      gate.dead.set(secret, reason);
      const phone = await ikHandshake(socket);
      deliver(socket, phone, { type: 'auth', token: secret });
      await flush();
      expect(socket.closedWith).toEqual({ code: 4003, reason });
      expect(received).toEqual([]);
      expect(gate.enrolled).toEqual([]);
      expect(logs.join('\n')).toContain(reason);
    }
  });

  it('burns a live pairing code an enrolled device presents, and serves the device as usual', async () => {
    const { socket, conn, gate, received, logs } = setup();
    const device = generateDeviceKeys();
    const secret = 'p'.repeat(43);
    gate.pairings.add(secret);
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    const phone = await ikHandshake(socket, device);
    deliver(socket, phone, { type: 'auth', token: secret });
    await flush();
    expect(gate.redeemed).toEqual([]);
    expect(gate.burned).toEqual([{ secret, device: device.x25519.publicKey }]);
    expect(gate.pairings.size).toBe(0);
    expect(conn.keyCredential).toBe('device');
    expect(received).toEqual([{ type: 'auth', token: secret }]);
    expect(logs.join('\n')).toContain(`pairing code used by device ${deviceFingerprint(device.x25519.publicKey)}`);
  });

  it('does not refuse an enrolled device over a dead code: its key is its credential', async () => {
    const { socket, gate, received } = setup();
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    const phone = await ikHandshake(socket, device);
    deliver(socket, phone, { type: 'auth', token: 'p'.repeat(43) });
    await flush();
    expect(socket.closedWith).toBeNull();
    expect(received).toEqual([{ type: 'auth', token: 'p'.repeat(43) }]);
  });

  it('refuses a message 1 without a valid device hello', async () => {
    const { socket } = setup();
    const device = generateDeviceKeys();
    const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), b64url.decode(agentKeys.x25519.publicKey));
    socket.deliver(handshakeFrame(await initiator.writeMessage1(utf8({ name: 'no key' })), 'ik'));
    await flush();
    expect(socket.closedWith?.code).toBe(4002);
  });

  it('names the device it serves, so a revocation can close it', async () => {
    const { socket, conn, gate } = setup();
    const device = generateDeviceKeys();
    gate.standings.set(device.x25519.publicKey, 'enrolled');
    expect(conn.device).toBeNull();
    await ikHandshake(socket, device);
    expect(conn.device).toBe(device.x25519.publicKey);
    conn.refuse('device revoked');
    expect(socket.closedWith).toEqual({ code: 4003, reason: 'device revoked' });
  });

  // NK (no device key) is retired: its handshake flag is not a handshake any more.
  it('refuses a handshake without a device key, answering nothing', () => {
    const { socket, received } = setup();
    socket.deliver(Uint8Array.of(0x02, ...new Uint8Array(48)));
    expect(socket.sent).toEqual([]);
    expect(socket.closedWith?.code).toBe(4002);
    expect(received).toEqual([]);
  });
});
