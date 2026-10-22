import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATE_READY,
  IkResponder,
  REFUSAL,
  SecureSession,
  b64url,
  encodeGateChallenge,
  enrolKey,
  generateAgentKeys,
  handshakeFrame,
  parseDeviceHello,
  verifyDeviceHello,
  readHandshakeFrame,
  parseGateReply,
  verifyDeviceAuth,
  verifyEnrolProof,
} from '@perch/secure-channel';
import type { CloseInfo } from '../core/ports/socket';
import type { FrameSocket } from '../core/ports/frame-socket';
import { DeviceKeyError, type DeviceIdentity } from '../core/ports/device-identity';
import {
  ChallengeError,
  ChallengeTimeoutError,
  GATE_WAIT_MS,
  challengeUrl,
  fetchRelayChallenge,
  gateUrl,
  noiseSocketFactory,
} from './noise-socket';
import { loadDeviceIdentity, type IdentityRecordStore, type StoredIdentity } from './device-keys';

class FakeFrameSocket implements FrameSocket {
  sent: Uint8Array[] = [];
  texts: string[] = [];
  closed = false;
  private frame: Array<(f: Uint8Array) => void> = [];
  private text: Array<(t: string) => void> = [];
  private open: Array<() => void> = [];
  private close_: Array<(info?: CloseInfo) => void> = [];
  send(frame: Uint8Array): void {
    this.sent.push(frame);
  }
  close(): void {
    this.closed = true;
    this.close_.forEach((l) => l({ code: 1005 }));
  }
  sendText(text: string): void {
    this.texts.push(text);
  }
  onFrame(cb: (f: Uint8Array) => void): void {
    this.frame.push(cb);
  }
  onText(cb: (t: string) => void): void {
    this.text.push(cb);
  }
  deliverText(text: string): void {
    this.text.forEach((l) => l(text));
  }
  onOpen(cb: () => void): void {
    this.open.push(cb);
  }
  onClose(cb: (info?: CloseInfo) => void): void {
    this.close_.push(cb);
  }
  // The far end closes: the relay refusing the phone in band, or the agent.
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
// The fetch path: a relay this session already found predates the in-band gate.
const legacy = () => new Set(['wss://relay/acct']);
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

function setup(
  agentKey = agent.x25519.publicKey,
  nonce = 'nonce-1',
  device: () => Promise<DeviceIdentity> = () => identity,
  token = 'the-token',
  credential: 'pairing' | 'token' | 'none' = 'token',
) {
  const inner = new FakeFrameSocket();
  const urls: string[] = [];
  const challenges: string[] = [];
  const socket = noiseSocketFactory(
    (url) => {
      urls.push(url);
      return inner;
    },
    agentKey,
    {
      device,
      token,
      credential,
      deviceName: 'Test phone',
      fetchChallenge: async (url) => {
        challenges.push(url);
        return nonce;
      },
      legacyRelays: legacy(),
    },
  )('wss://relay/acct');
  const events: string[] = [];
  const messages: string[] = [];
  let closeInfo: CloseInfo | undefined;
  socket.onOpen(() => events.push('open'));
  socket.onMessage((m) => messages.push(m));
  socket.onClose((info) => {
    events.push('close');
    closeInfo = info;
  });
  return { inner, socket, events, messages, urls, challenges, closeInfo: () => closeInfo };
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

// The socket opens its frame socket only after the device key and the challenge are ready.
async function opened(inner: FakeFrameSocket): Promise<void> {
  await flush();
  inner.fireOpen();
  await flush();
}

describe('noise socket', () => {
  it('signs the relay challenge with the device key and adds a token proof for enrolment', async () => {
    const { urls, challenges } = setup();
    await flush();
    const me = await identity;
    expect(challenges).toEqual(['https://relay/acct?role=challenge']);
    const query = new URL(urls[0]!).searchParams;
    const claim = { account: 'acct', nonce: 'nonce-1', device: me.ed25519Public };
    expect(query.get('device')).toBe(me.ed25519Public);
    expect(query.get('nonce')).toBe('nonce-1');
    expect(await verifyDeviceAuth(query.get('sig')!, claim)).toBe(true);
    expect(verifyEnrolProof(enrolKey('the-token', 'acct'), query.get('proof')!, claim)).toBe(true);
    expect(query.get('cred')).toBe('token');
    expect(urls[0]).not.toContain('the-token');
  });

  it('proves enrolment with a pairing secret the same way, and the secret never enters a URL', async () => {
    const secret = 'S'.repeat(43);
    const { urls, challenges } = setup(agent.x25519.publicKey, 'nonce-1', () => identity, secret, 'pairing');
    await flush();
    const me = await identity;
    const claim = { account: 'acct', nonce: 'nonce-1', device: me.ed25519Public };
    expect(verifyEnrolProof(enrolKey(secret, 'acct'), new URL(urls[0]!).searchParams.get('proof')!, claim)).toBe(true);
    // Says which, so the agent's log can name a failure; the relay passes it along unchecked.
    expect(new URL(urls[0]!).searchParams.get('cred')).toBe('pairing');
    for (const url of [...urls, ...challenges]) expect(url).not.toContain(secret);
  });

  it('sends no enrolment proof when it holds neither a token nor a pairing secret (an enrolled paired phone)', async () => {
    const { urls } = setup(agent.x25519.publicKey, 'nonce-1', () => identity, '', 'none');
    await flush();
    const query = new URL(urls[0]!).searchParams;
    expect(query.get('sig')).toBeTruthy();
    expect(query.has('proof')).toBe(false);
    expect(query.has('cred')).toBe(false);
  });

  it("passes the relay's in-band refusal on with its code and reason", async () => {
    const { inner, events, closeInfo } = setup();
    await opened(inner);
    inner.fireClose({ code: 4403, reason: 'pairing code expired' });
    expect(events).toEqual(['close']);
    expect(closeInfo()).toEqual({ code: 4403, reason: 'pairing code expired' });
  });

  // Every relay hands out challenges and refuses an upgrade without one, so a challenge that
  // cannot be fetched (a brief network error during sign-in) fails the attempt to be retried:
  // connecting without device parameters would earn a final "device key required".
  it('closes with "relay challenge failed", without dialing, when the challenge cannot be fetched', async () => {
    const inner = new FakeFrameSocket();
    const urls: string[] = [];
    const socket = noiseSocketFactory((url) => (urls.push(url), inner), agent.x25519.publicKey, {
      device: () => identity,
      token: 't',
      deviceName: 'p',
      fetchChallenge: () => Promise.reject(new ChallengeError('network error')),
      legacyRelays: legacy(),
    })('wss://relay/acct');
    let info: CloseInfo | undefined;
    socket.onClose((i) => (info = i));
    await flush();
    expect(urls).toEqual([]);
    expect(info?.reason).toBe('relay challenge failed: network error');
    expect(info?.code).toBeUndefined();
  });

  it('presents the device key and name in the IK handshake, and opens once the pinned agent answers', async () => {
    const { inner, events } = setup();
    await opened(inner);
    expect(events).toEqual([]);
    const responder = new IkResponder(b64url.decode(agent.x25519.privateKey));
    const hello = parseDeviceHello(responder.readMessage1(readHandshakeFrame(inner.sent[0]!, 'ik')));
    expect(hello).toEqual({ sig: (await identity).ed25519Public, name: 'Test phone', proof: expect.any(String) });
    expect(b64url.encode(responder.remoteStatic())).toBe((await identity).x25519Public);
    // The hello proves its relay key over this handshake, as the agent requires to enrol it.
    expect(await verifyDeviceHello(hello!, responder.remoteStatic(), responder.payloadHash())).toBe(true);
    inner.deliver(handshakeFrame(responder.writeMessage2(), 'ik'));
    await flush();
    expect(events).toEqual(['open']);
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
      fetchChallenge: async () => 'n',
    })('wss://relay/acct');
    let reason: string | undefined;
    socket.onClose((info) => (reason = info?.reason));
    await flush();
    expect(reason).toBe('device key unavailable: no IndexedDB');
  });

  it('names the failure when the device key cannot sign the relay challenge', async () => {
    const failing = async () => ({
      ...(await identity),
      sign: () => Promise.reject(new DeviceKeyError('InvalidAccessError: key gone')),
    });
    const { closeInfo, urls } = setup(agent.x25519.publicKey, 'n', failing);
    await flush();
    expect(urls).toEqual([]);
    expect(closeInfo()?.reason).toBe('device key unavailable: InvalidAccessError: key gone');
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
    const { inner, closeInfo } = setup(agent.x25519.publicKey, 'n', failingDhOnCall(1));
    await opened(inner);
    expect(closeInfo()?.reason).toBe('device key unavailable: OperationError: dh failed');
  });

  it('blames the device key, not the agent key, when its DH fails reading the answer', async () => {
    const { inner, closeInfo } = setup(agent.x25519.publicKey, 'n', failingDhOnCall(2));
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
      fetchChallenge: async () => 'n',
    })('wss://relay/acct');
    let closes = 0;
    socket.onClose(() => (closes += 1));
    socket.close();
    reject(new Error('gone'));
    await flush();
    expect(closes).toBe(1);
  });

  // A fetch that hangs (a pooled connection that died while the device slept) must fail the
  // attempt so it is retried, not stand in for "no challenge": a gated relay would refuse that.
  it('closes with "relay challenge timed out", without dialing, when the challenge fetch times out', async () => {
    const inner = new FakeFrameSocket();
    const urls: string[] = [];
    const socket = noiseSocketFactory((url) => (urls.push(url), inner), agent.x25519.publicKey, {
      device: () => identity,
      token: 't',
      deviceName: 'p',
      fetchChallenge: () => Promise.reject(new ChallengeTimeoutError(5000)),
      legacyRelays: legacy(),
    })('wss://relay/acct');
    const events: string[] = [];
    let info: CloseInfo | undefined;
    socket.onOpen(() => events.push('open'));
    socket.onClose((i) => (events.push('close'), (info = i)));
    await flush();
    expect(urls).toEqual([]);
    expect(events).toEqual(['close']);
    expect(info?.reason).toBe('relay challenge timed out');
    socket.close();
    expect(events).toEqual(['close']);
  });

  it('reports how long each phase of the connect took', async () => {
    let t = 1000;
    const phases: Array<[string, string]> = [];
    const inner = new FakeFrameSocket();
    const socket = noiseSocketFactory(() => inner, agent.x25519.publicKey, {
      device: () => identity,
      token: 't',
      deviceName: 'p',
      fetchChallenge: async () => {
        t += 300;
        return 'n';
      },
      now: () => t,
      onPhase: (phase, detail) => phases.push([phase, detail]),
      legacyRelays: legacy(),
    })('wss://relay/acct');
    socket.onOpen(() => undefined);
    await flush();
    t += 200;
    inner.fireOpen();
    await flush();
    t += 100;
    await answer(inner);
    expect(phases).toEqual([
      ['challenge', 'ok 300ms'],
      ['ws-open', '500ms'],
      ['handshake', '600ms'],
    ]);
  });

  it('reports a challenge that timed out or failed', async () => {
    const phases: string[] = [];
    const run = (fetchChallenge: () => Promise<string>) =>
      noiseSocketFactory(() => new FakeFrameSocket(), agent.x25519.publicKey, {
        device: () => identity,
        token: 't',
        deviceName: 'p',
        fetchChallenge,
        now: () => 0,
        onPhase: (phase, detail) => phases.push(`${phase} ${detail}`),
        legacyRelays: legacy(),
      })('wss://relay/acct');
    run(() => Promise.reject(new ChallengeTimeoutError(5000)));
    run(() => Promise.reject(new ChallengeError('HTTP 503')));
    await flush();
    expect(phases).toEqual(['challenge timeout 0ms', 'challenge failed: HTTP 503 0ms']);
  });

  it('closes before dialing when asked to, reporting the close once', async () => {
    const { socket, urls, events } = setup();
    socket.close();
    await flush();
    expect(urls).toEqual([]);
    expect(events).toEqual(['close']);
  });
});

describe('noise socket through the in-band gate', () => {
  afterEach(() => vi.useRealTimers());

  function gated(options: { legacyRelays?: Set<string>; token?: string; credential?: 'pairing' | 'token' | 'none' } = {}) {
    const sockets: FakeFrameSocket[] = [];
    const urls: string[] = [];
    const challenges: string[] = [];
    const phases: string[] = [];
    let t = 0;
    const socket = noiseSocketFactory(
      (url) => {
        urls.push(url);
        const inner = new FakeFrameSocket();
        sockets.push(inner);
        return inner;
      },
      agent.x25519.publicKey,
      {
        device: () => identity,
        token: options.token ?? 'the-token',
        credential: options.credential ?? 'token',
        deviceName: 'Test phone',
        fetchChallenge: async (url) => {
          challenges.push(url);
          return 'fetched-nonce';
        },
        legacyRelays: options.legacyRelays,
        now: () => (t += 10),
        onPhase: (phase, detail) => phases.push(`${phase} ${detail}`),
      },
    )('wss://relay/acct');
    const events: string[] = [];
    let closeInfo: CloseInfo | undefined;
    socket.onOpen(() => events.push('open'));
    socket.onClose((info) => {
      events.push('close');
      closeInfo = info;
    });
    return { socket, sockets, urls, challenges, phases, events, closeInfo: () => closeInfo };
  }

  it('asks for the gate on the socket and fetches nothing', async () => {
    const { urls, challenges } = gated();
    await flush();
    expect(urls).toEqual([gateUrl('wss://relay/acct')]);
    expect(new URL(urls[0]!).searchParams.get('challenge')).toBe('1');
    expect(challenges).toEqual([]);
  });

  it('answers the challenge it is sent with the same proofs the query carries, then waits for ready', async () => {
    const { sockets } = gated();
    await flush();
    const inner = sockets[0]!;
    inner.fireOpen();
    expect(inner.sent).toEqual([]);
    inner.deliverText(encodeGateChallenge('nonce-9'));
    await flush();
    const reply = parseGateReply(inner.texts[0]!)!;
    const me = await identity;
    const claim = { account: 'acct', nonce: 'nonce-9', device: me.ed25519Public };
    expect(reply.key).toBe(me.ed25519Public);
    expect(await verifyDeviceAuth(reply.sig, claim)).toBe(true);
    expect(verifyEnrolProof(enrolKey('the-token', 'acct'), reply.proof!, claim)).toBe(true);
    expect(reply.cred).toBe('token');
    expect(inner.texts[0]).not.toContain('the-token');
    expect(inner.sent).toEqual([]);
  });

  it('starts the handshake on ready, and opens once the agent answers', async () => {
    const { sockets, events, phases } = gated({ token: '', credential: 'none' });
    await flush();
    const inner = sockets[0]!;
    inner.fireOpen();
    inner.deliverText(encodeGateChallenge('n'));
    await flush();
    expect(parseGateReply(inner.texts[0]!)!.proof).toBeUndefined();
    inner.deliverText(GATE_READY);
    await answer(inner);
    expect(events).toEqual(['open']);
    expect(phases.map((p) => p.split(' ')[0])).toEqual(['ws-open', 'challenge', 'admitted', 'handshake']);
  });

  it('fails on a binary frame before ready, or an unexpected text frame', async () => {
    const early = gated();
    await flush();
    early.sockets[0]!.fireOpen();
    early.sockets[0]!.deliverText(encodeGateChallenge('n'));
    early.sockets[0]!.deliver(new Uint8Array([3, 0]));
    expect(early.closeInfo()?.reason).toBe('secure channel failed');
    const garbled = gated();
    await flush();
    garbled.sockets[0]!.fireOpen();
    garbled.sockets[0]!.deliverText('{"type":"surprise"}');
    expect(garbled.closeInfo()?.reason).toBe('relay challenge failed: invalid challenge');
  });

  it('passes a refusal at the gate on as any in-band refusal', async () => {
    const { sockets, closeInfo, urls } = gated();
    await flush();
    sockets[0]!.fireOpen();
    sockets[0]!.deliverText(encodeGateChallenge('n'));
    await flush();
    sockets[0]!.fireClose({ code: 4403, reason: REFUSAL.notEnrolled });
    expect(closeInfo()).toEqual({ code: 4403, reason: REFUSAL.notEnrolled });
    expect(urls).toHaveLength(1);
  });

  // A relay from before the gate sees a client with no device parameters, and once its agent has
  // published a policy it refuses that for good. That refusal is the relay's age, not the phone's.
  it('falls back to the fetched challenge for a relay that predates the gate, and remembers it', async () => {
    const legacyRelays = new Set<string>();
    const first = gated({ legacyRelays });
    await flush();
    first.sockets[0]!.fireOpen();
    first.sockets[0]!.fireClose({ code: 4401, reason: REFUSAL.deviceKeyRequired });
    await flush();
    expect(first.events).toEqual([]);
    expect(first.challenges).toEqual(['https://relay/acct?role=challenge']);
    expect(new URL(first.urls[1]!).searchParams.get('nonce')).toBe('fetched-nonce');
    expect(first.phases[1]).toMatch(/^challenge-fallback legacy relay/);
    expect(legacyRelays.has('wss://relay/acct')).toBe(true);
    const inner = first.sockets[1]!;
    inner.fireOpen();
    await flush();
    await answer(inner);
    expect(first.events).toEqual(['open']);
    const next = gated({ legacyRelays });
    await flush();
    expect(next.urls[0]).toContain('nonce=fetched-nonce');
  });

  it('goes on over the fetched challenge when its gate is closed before ready, without remembering it', async () => {
    for (const reason of [REFUSAL.tooManyPending, REFUSAL.challengeUnanswered]) {
      const legacyRelays = new Set<string>();
      const { sockets, urls, events, phases } = gated({ legacyRelays });
      await flush();
      sockets[0]!.fireOpen();
      sockets[0]!.deliverText(encodeGateChallenge('n'));
      await flush();
      sockets[0]!.fireClose({ code: reason === REFUSAL.tooManyPending ? 4429 : 4408, reason });
      await flush();
      expect(events).toEqual([]);
      expect(urls[1]).toContain('nonce=fetched-nonce');
      expect(phases.some((p) => p.startsWith('challenge-fallback gate closed'))).toBe(true);
      expect(legacyRelays.size).toBe(0);
    }
  });

  it('keeps "device key required" final once the gate has sent its challenge', async () => {
    const legacyRelays = new Set<string>();
    const { sockets, closeInfo } = gated({ legacyRelays });
    await flush();
    sockets[0]!.fireOpen();
    sockets[0]!.deliverText(encodeGateChallenge('n'));
    sockets[0]!.fireClose({ code: 4401, reason: REFUSAL.deviceKeyRequired });
    expect(closeInfo()?.reason).toBe(REFUSAL.deviceKeyRequired);
    expect(legacyRelays.size).toBe(0);
  });

  // An older relay with no policy yet hands the socket straight to the agent, which says nothing
  // until the handshake: no challenge ever comes.
  it('falls back for this attempt only when no challenge arrives in time', async () => {
    vi.useFakeTimers();
    const legacyRelays = new Set<string>();
    const { sockets, urls, phases } = gated({ legacyRelays });
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.fireOpen();
    await vi.advanceTimersByTimeAsync(GATE_WAIT_MS - 1);
    expect(urls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets[0]!.closed).toBe(true);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('nonce=fetched-nonce');
    expect(phases.some((p) => p.startsWith('challenge-fallback no challenge'))).toBe(true);
    expect(legacyRelays.size).toBe(0);
  });

  it('does not fall back once the attempt was closed', async () => {
    vi.useFakeTimers();
    const { socket, sockets, urls, events } = gated();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]!.fireOpen();
    socket.close();
    await vi.advanceTimersByTimeAsync(GATE_WAIT_MS);
    expect(urls).toHaveLength(1);
    expect(events).toEqual(['close']);
  });
});

describe('fetchRelayChallenge', () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it('returns the nonce of a relay with device keys', async () => {
    await withFetch(async () => new Response('{"nonce":"n1"}'), async () => {
      expect(await fetchRelayChallenge('https://relay/acct?role=challenge')).toBe('n1');
    });
  });

  // A refused challenge carries no CORS headers, so a browser reads it as a network error too.
  it('rejects with ChallengeError when there is no nonce to be had', async () => {
    const failing = async (impl: typeof fetch, detail: string) =>
      withFetch(impl, async () => {
        const err = await fetchRelayChallenge('https://relay/acct?role=challenge').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ChallengeError);
        expect(err).not.toBeInstanceOf(ChallengeTimeoutError);
        expect((err as ChallengeError).detail).toBe(detail);
      });
    await failing(() => Promise.reject(new TypeError('Failed to fetch')), 'network error');
    await failing(async () => new Response('unknown account', { status: 404 }), 'HTTP 404');
    await failing(async () => new Response('{"nonce":""}'), 'no nonce');
    await failing(async () => new Response('not json'), 'no nonce');
  });
});

describe('fetchRelayChallenge timeout', () => {
  it('aborts a fetch that hangs and rejects with ChallengeTimeoutError', async () => {
    const original = globalThis.fetch;
    let signal: AbortSignal | undefined;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }) as typeof fetch;
    try {
      await expect(fetchRelayChallenge('https://relay/acct?role=challenge', 20)).rejects.toBeInstanceOf(ChallengeTimeoutError);
      expect(signal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('challengeUrl', () => {
  it('maps the relay machine URL to its challenge over HTTP', () => {
    expect(challengeUrl('wss://relay.example.com/acct')).toBe('https://relay.example.com/acct?role=challenge');
    expect(challengeUrl('ws://127.0.0.1:8450/acct/')).toBe('http://127.0.0.1:8450/acct/?role=challenge');
  });
});
