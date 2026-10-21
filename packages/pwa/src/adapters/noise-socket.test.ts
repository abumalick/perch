import { describe, expect, it } from 'vitest';
import {
  IkResponder,
  SecureSession,
  b64url,
  enrolKey,
  generateAgentKeys,
  handshakeFrame,
  parseDeviceHello,
  verifyDeviceHello,
  readHandshakeFrame,
  verifyDeviceAuth,
  verifyEnrolProof,
} from '@perch/secure-channel';
import type { CloseInfo } from '../core/ports/socket';
import type { FrameSocket } from '../core/ports/frame-socket';
import { DeviceKeyError, type DeviceIdentity } from '../core/ports/device-identity';
import { ChallengeError, ChallengeTimeoutError, challengeUrl, fetchRelayChallenge, noiseSocketFactory } from './noise-socket';
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
