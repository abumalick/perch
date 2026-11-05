import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IkResponder,
  SecureSession,
  b64url,
  generateAgentKeys,
  handshakeFrame,
  parseDeviceHello,
  readHandshakeFrame,
} from '@perch/secure-channel';
import type { CloseInfo } from '../core/ports/socket';
import type { FrameSocket } from '../core/ports/frame-socket';
import { DeviceKeyError, type DeviceIdentity } from '../core/ports/device-identity';
import { noiseSocketFactory } from './noise-socket';
import { loadDeviceIdentity, type IdentityRecordStore, type StoredIdentity } from './device-keys';

class FakeFrameSocket implements FrameSocket {
  sent: Uint8Array[] = [];
  closed = false;
  private frame: Array<(f: Uint8Array) => void> = [];
  private open: Array<() => void> = [];
  private close_: Array<(info?: CloseInfo) => void> = [];
  send(frame: Uint8Array): void {
    this.sent.push(frame);
  }
  close(): void {
    this.closed = true;
    this.close_.forEach((l) => l({ code: 1005 }));
  }
  onFrame(cb: (f: Uint8Array) => void): void {
    this.frame.push(cb);
  }
  onOpen(cb: () => void): void {
    this.open.push(cb);
  }
  onClose(cb: (info?: CloseInfo) => void): void {
    this.close_.push(cb);
  }
  // The far end closes: the agent refusing the phone, or whatever fronts it.
  fireClose(info: CloseInfo): void {
    this.close_.forEach((l) => l(info));
  }
  fireOpen(): void {
    this.open.forEach((l) => l());
  }
  deliver(frame: Uint8Array): void {
    this.frame.forEach((l) => l(frame));
  }
}

const agent = generateAgentKeys();
const flush = () => new Promise((r) => setTimeout(r, 0));

let record: StoredIdentity | undefined;
const identityStore: IdentityRecordStore = {
  get: async () => record,
  add: async (r) => {
    record = r;
    return true;
  },
  replace: async (r) => {
    record = r;
  },
  remove: async () => {
    record = undefined;
  },
};
// Noble keys: every step settles within one flush. The WebCrypto path is device-keys' concern.
const noCurves = { generateKey: () => Promise.reject(new Error('unsupported')) } as unknown as SubtleCrypto;
const identity = loadDeviceIdentity(identityStore, noCurves);

const ADDRESS = 'wss://dev.example.ts.net:10000/abu';

function setup(agentKey = agent.x25519.publicKey, device: () => Promise<DeviceIdentity> = () => identity, token = 'the-token') {
  const inner = new FakeFrameSocket();
  const urls: string[] = [];
  const socket = noiseSocketFactory(
    (url) => {
      urls.push(url);
      return inner;
    },
    agentKey,
    { device, token, deviceName: 'Test phone' },
  )(ADDRESS);
  const events: string[] = [];
  const messages: string[] = [];
  let closeInfo: CloseInfo | undefined;
  socket.onOpen(() => events.push('open'));
  socket.onMessage((m) => messages.push(m));
  socket.onClose((info) => {
    events.push('close');
    closeInfo = info;
  });
  return { inner, socket, events, messages, urls, closeInfo: () => closeInfo };
}

// Plays the agent: answers the phone's handshake and returns its end of the session.
async function answer(inner: FakeFrameSocket, staticPrivate = agent.x25519.privateKey): Promise<SecureSession> {
  await flush();
  const responder = new IkResponder(b64url.decode(staticPrivate));
  responder.readMessage1(readHandshakeFrame(inner.sent[0]!, 'ik'));
  inner.deliver(handshakeFrame(responder.writeMessage2(), 'ik'));
  await flush();
  const { send, recv } = responder.split();
  return new SecureSession(send, recv);
}

// The socket opens its frame socket only once the device key is loaded.
async function opened(inner: FakeFrameSocket): Promise<void> {
  await flush();
  inner.fireOpen();
  await flush();
}

describe('noise socket', () => {
  it('dials the address as given, with nothing added, and starts the handshake as soon as it opens', async () => {
    const { inner, urls } = setup();
    await flush();
    expect(urls).toEqual([ADDRESS]);
    expect(inner.sent).toEqual([]);
    inner.fireOpen();
    await flush();
    expect(inner.sent).toHaveLength(1);
    expect(inner.sent[0]![0]).toBe(0x03);
  });

  it("passes the agent's refusal on with its code and reason", async () => {
    const { inner, events, closeInfo } = setup();
    await opened(inner);
    inner.fireClose({ code: 4003, reason: 'pairing code expired' });
    expect(events).toEqual(['close']);
    expect(closeInfo()).toEqual({ code: 4003, reason: 'pairing code expired' });
  });

  it('presents the device key and name in the IK handshake, and opens once the pinned agent answers', async () => {
    const { inner, events } = setup();
    await opened(inner);
    expect(events).toEqual([]);
    const responder = new IkResponder(b64url.decode(agent.x25519.privateKey));
    const hello = parseDeviceHello(responder.readMessage1(readHandshakeFrame(inner.sent[0]!, 'ik')));
    // No relay proof any more: the agent knows the phone by its IK key alone.
    expect(hello).toEqual({ sig: (await identity).ed25519Public, name: 'Test phone' });
    expect(b64url.encode(responder.remoteStatic())).toBe((await identity).x25519Public);
    inner.deliver(handshakeFrame(responder.writeMessage2(), 'ik'));
    await flush();
    expect(events).toEqual(['open']);
  });

  // A phone holding a credential takes the old ordering, so the agent sees its `auth` (and burns a
  // pairing code, or refuses the token) before any `enrolled` lets the phone forget it.
  it('asks to be served at once only when the entry holds no credential', async () => {
    for (const [token, push] of [['', true], ['the-token', undefined], ['S'.repeat(43), undefined]] as const) {
      const { inner } = setup(agent.x25519.publicKey, () => identity, token);
      await opened(inner);
      const responder = new IkResponder(b64url.decode(agent.x25519.privateKey));
      expect(parseDeviceHello(responder.readMessage1(readHandshakeFrame(inner.sent[0]!, 'ik')))?.push).toBe(push);
    }
  });

  it('encrypts what the connection sends and decrypts what the agent sends', async () => {
    const { inner, socket, messages } = setup();
    await opened(inner);
    const agentSide = await answer(inner);
    socket.send('{"type":"auth","token":"t"}');
    const received = inner.sent.slice(1).map((f) => agentSide.open(f)).filter((m): m is Uint8Array => m !== null);
    expect(received.map((m) => new TextDecoder().decode(m))).toEqual(['{"type":"auth","token":"t"}']);
    expect(inner.sent.slice(1).every((f) => !new TextDecoder().decode(f).includes('token'))).toBe(true);
    for (const frame of agentSide.seal(new TextEncoder().encode('{"type":"authResult","ok":true}'))) inner.deliver(frame);
    await flush();
    expect(messages).toEqual(['{"type":"authResult","ok":true}']);
  });

  it('drops what the connection sends before the handshake completes', async () => {
    const { inner, socket } = setup();
    socket.send('{"type":"auth","token":"t"}');
    await opened(inner);
    expect(inner.sent).toHaveLength(1);
  });

  it('closes with "agent key mismatch" when whoever answers does not hold the pinned key', async () => {
    const { inner, events, closeInfo } = setup();
    await opened(inner);
    const impostor = generateAgentKeys();
    expect(() => new IkResponder(b64url.decode(impostor.x25519.privateKey)).readMessage1(readHandshakeFrame(inner.sent[0]!, 'ik'))).toThrow();
    const forged = new Uint8Array(49);
    forged[0] = 0x03;
    inner.deliver(forged);
    await flush();
    expect(inner.closed).toBe(true);
    expect(events).toEqual(['close']);
    expect(closeInfo()?.reason).toBe('agent key mismatch');
  });

  it('closes when a frame fails authentication after the handshake', async () => {
    const { inner, events, messages, closeInfo } = setup();
    await opened(inner);
    const agentSide = await answer(inner);
    const [frame] = agentSide.seal(new TextEncoder().encode('{"type":"pong"}'));
    frame![4]! ^= 1;
    inner.deliver(frame!);
    await flush();
    expect(messages).toEqual([]);
    expect(events).toEqual(['open', 'close']);
    expect(closeInfo()?.reason).toBe('secure channel failed');
  });

  it('closes with a clear reason when the configured agent key is malformed, without dialing', async () => {
    const { urls, closeInfo } = setup('not a key');
    await flush();
    expect(urls).toEqual([]);
    expect(closeInfo()?.reason).toBe('invalid agent key');
  });

  it('closes with a clear reason when the device key cannot be loaded', async () => {
    const inner = new FakeFrameSocket();
    const socket = noiseSocketFactory(() => inner, agent.x25519.publicKey, {
      device: () => Promise.reject(new Error('no IndexedDB')),
      token: 't',
      deviceName: 'p',
    })(ADDRESS);
    let reason: string | undefined;
    socket.onClose((info) => (reason = info?.reason));
    await flush();
    expect(reason).toBe('device key unavailable: no IndexedDB');
  });

  // The device key's DH runs once in the first handshake message and once in the agent's answer.
  const failingDhOnCall = (n: number) => async (): Promise<DeviceIdentity> => {
    const real = await identity;
    let calls = 0;
    const dh = (remote: Uint8Array) =>
      ++calls === n ? Promise.reject(new DeviceKeyError('OperationError: dh failed')) : real.x25519.dh(remote);
    return { ...real, x25519: { ...real.x25519, dh } };
  };

  it('blames the device key, not the channel, when its DH fails writing the handshake', async () => {
    const { inner, closeInfo } = setup(agent.x25519.publicKey, failingDhOnCall(1));
    await opened(inner);
    expect(closeInfo()?.reason).toBe('device key unavailable: OperationError: dh failed');
  });

  it('blames the device key, not the agent key, when its DH fails reading the answer', async () => {
    const { inner, closeInfo } = setup(agent.x25519.publicKey, failingDhOnCall(2));
    await opened(inner);
    await answer(inner);
    expect(closeInfo()?.reason).toBe('device key unavailable: OperationError: dh failed');
  });

  it('reports the close once when the device key fails after an early close', async () => {
    let reject!: (err: Error) => void;
    const socket = noiseSocketFactory(() => new FakeFrameSocket(), agent.x25519.publicKey, {
      device: () => new Promise((_, r) => (reject = r)),
      token: 't',
      deviceName: 'p',
    })(ADDRESS);
    let closes = 0;
    socket.onClose(() => (closes += 1));
    socket.close();
    reject(new Error('gone'));
    await flush();
    expect(closes).toBe(1);
  });

  it('reports how long each phase of the connect took', async () => {
    let t = 1000;
    const phases: Array<[string, string]> = [];
    const inner = new FakeFrameSocket();
    const socket = noiseSocketFactory(() => inner, agent.x25519.publicKey, {
      device: async () => {
        t += 50;
        return identity;
      },
      token: 't',
      deviceName: 'p',
      now: () => t,
      onPhase: (phase, detail) => phases.push([phase, detail]),
    })(ADDRESS);
    socket.onOpen(() => undefined);
    await flush();
    t += 200;
    inner.fireOpen();
    await flush();
    t += 100;
    await answer(inner);
    expect(phases).toEqual([
      ['device-key', '50ms'],
      ['ws-open', '250ms'],
      ['handshake', '350ms'],
    ]);
  });

  it('closes before dialing when asked to, reporting the close once', async () => {
    const { socket, urls, events } = setup();
    socket.close();
    await flush();
    expect(urls).toEqual([]);
    expect(events).toEqual(['close']);
  });
});
