import {
  GATE_PARAM,
  GATE_READY,
  IkInitiator,
  REFUSAL,
  SecureSession,
  b64url,
  encodeGateReply,
  encodeDeviceHello,
  signDeviceHello,
  enrolKey,
  enrolProof,
  handshakeFrame,
  parseGateChallenge,
  readHandshakeFrame,
  signDeviceAuth,
  type DeviceParams,
} from '@perch/secure-channel';
import type { CloseInfo, Socket, SocketFactory } from '../core/ports/socket';
import type { FrameSocketFactory, FrameSocket } from '../core/ports/frame-socket';
import { DeviceKeyError, type DeviceIdentity } from '../core/ports/device-identity';
import { describeError } from '../core/describe-error';
import { parseAgentKey } from '../core/relay-key';

const deviceKeyUnavailable = (err: unknown) => `device key unavailable: ${describeError(err)}`;
// The handshake reports a failing static key as its own error, with the device key's as the cause.
const deviceKeyFailure = (err: unknown): DeviceKeyError | undefined => {
  const cause = (err as { cause?: unknown } | null)?.cause;
  return cause instanceof DeviceKeyError ? cause : undefined;
};

export interface RelayDeviceOptions {
  device: () => Promise<DeviceIdentity>;
  // The machine's bearer token, or the one-time pairing secret of a paired entry: it proves,
  // without ever leaving the phone, that an unknown device key may be enrolled (the relay
  // forwards the proof and only the agent can check it). Empty once a paired phone's secret is
  // spent: its key is enrolled, so there is nothing left to prove.
  token: string;
  // What `token` is. Sent beside the proof so the agent can say in its log which one failed.
  credential?: 'pairing' | 'token' | 'none';
  deviceName: string;
  // The relay's single-use challenge over HTTP, for a relay that predates the in-band gate. It
  // rejects with a ChallengeError when there is none to be had, which fails the attempt so it is
  // retried: without one the relay refuses the upgrade.
  fetchChallenge: (url: string) => Promise<string>;
  // Relay URLs known to predate the in-band gate, shared by every attempt of the app session.
  legacyRelays?: Set<string>;
  // Each phase of a connect with its outcome and the time since the attempt began, for the
  // connection log: `ws-open`, `challenge`, `admitted`, `handshake`, and `challenge-fallback`.
  onPhase?: (phase: string, detail: string) => void;
  now?: () => number;
}

// No challenge could be had: a network error, a refusal (which carries no CORS headers, so the
// browser reports it as a network error too) or a malformed answer. The attempt fails and the
// normal backoff retries it; connecting without device parameters would earn a final refusal.
export class ChallengeError extends Error {
  constructor(readonly detail: string) {
    super(`relay challenge failed: ${detail}`);
    this.name = 'ChallengeError';
  }
}

// The challenge fetch hung and was aborted.
export class ChallengeTimeoutError extends ChallengeError {
  constructor(readonly ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'ChallengeTimeoutError';
  }
}

const challengeFailure = (err: ChallengeError) =>
  err instanceof ChallengeTimeoutError ? 'relay challenge timed out' : err.message;

// Long enough for a slow but healthy fetch; short of the connection's own 10 s deadline so a
// hung one is retried sooner.
const CHALLENGE_TIMEOUT_MS = 5_000;
// A relay that predates the gate, with no device policy yet (moments after it restarted), dials
// a gate socket straight to the agent, which waits for the handshake: nothing ever arrives.
// A gated relay sends its challenge as soon as the socket opens.
export const GATE_WAIT_MS = 3_000;

// ws(s)://host/<account> → http(s)://host/<account>?role=challenge
export function challengeUrl(relayUrl: string): string {
  const url = new URL(relayUrl.replace(/^ws/, 'http'));
  url.search = '';
  url.searchParams.set('role', 'challenge');
  return url.toString();
}

function accountOf(url: string): string {
  return new URL(url).pathname.replace(/^\/+|\/+$/g, '');
}

async function deviceParams(account: string, nonce: string, identity: DeviceIdentity, options: RelayDeviceOptions): Promise<DeviceParams> {
  const claim = { account, nonce, device: identity.ed25519Public };
  const params: DeviceParams = { key: identity.ed25519Public, nonce, sig: await signDeviceAuth(identity.sign, claim) };
  if (!options.token) return params;
  params.proof = enrolProof(enrolKey(options.token, account), claim);
  if (options.credential === 'pairing' || options.credential === 'token') params.cred = options.credential;
  return params;
}

export function gateUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.searchParams.set(GATE_PARAM, '1');
  return url.toString();
}

async function deviceUrl(url: string, identity: DeviceIdentity, options: RelayDeviceOptions, since: () => string): Promise<string> {
  let nonce: string;
  try {
    nonce = await options.fetchChallenge(challengeUrl(url));
  } catch (err) {
    if (err instanceof ChallengeTimeoutError) options.onPhase?.('challenge', `timeout ${since()}`);
    else if (err instanceof ChallengeError) options.onPhase?.('challenge', `failed: ${err.detail} ${since()}`);
    throw err;
  }
  options.onPhase?.('challenge', `ok ${since()}`);
  const target = new URL(url);
  const { key, nonce: signed, sig, proof, cred } = await deviceParams(accountOf(url), nonce, identity, options);
  target.searchParams.set('device', key);
  target.searchParams.set('nonce', signed);
  target.searchParams.set('sig', sig);
  if (proof) target.searchParams.set('proof', proof);
  if (cred) target.searchParams.set('cred', cred);
  return target.toString();
}

// A relay machine's socket. The phone signs the relay's challenge with its device key: one sent
// on the socket itself (the relay's gate), or, for a relay that predates the gate, one fetched
// over HTTP and signed into the upgrade's query. Then everything the connection sends, `auth` first, travels inside a Noise IK session pinned to
// the agent's public key and carrying the phone's own static key, so the relay only ever
// carries ciphertext and the agent knows which device it serves. `open` is reported only once
// the handshake has proven the far end holds the agent's key; until then sends are dropped,
// exactly as on a socket that is still connecting.
export function noiseSocketFactory(inner: FrameSocketFactory, agentKey: string, options: RelayDeviceOptions): SocketFactory {
  return (url: string): Socket => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let socket: FrameSocket | null = null;
    let session: SecureSession | null = null;
    let failure: string | null = null;
    let closed = false;
    const openListeners: Array<() => void> = [];
    const messageListeners: Array<(data: string) => void> = [];
    const closeListeners: Array<(info?: CloseInfo) => void> = [];
    const errorListeners: Array<() => void> = [];
    const now = options.now ?? (() => Date.now());
    const started = now();
    const since = () => `${now() - started}ms`;
    const reportClose = (info?: CloseInfo) =>
      closeListeners.forEach((l) => l(failure ? { code: info?.code, reason: failure } : info));

    const fail = (reason: string) => {
      if (failure || (closed && !socket)) return;
      failure = reason;
      if (socket) socket.close();
      else reportClose();
    };

    const parsedKey = parseAgentKey(agentKey);
    if (!parsedKey) {
      queueMicrotask(() => fail('invalid agent key'));
      return handle();
    }
    const agentPublic: Uint8Array = parsedKey;

    const legacy = options.legacyRelays ?? new Set<string>();

    void (async () => {
      let identity: DeviceIdentity;
      try {
        identity = await options.device();
      } catch (err) {
        fail(deviceKeyUnavailable(err));
        return;
      }
      if (closed || failure) return;
      if (legacy.has(url)) await connectFetched(identity);
      else connect(inner(gateUrl(url)), identity, true);
    })();

    async function connectFetched(identity: DeviceIdentity): Promise<void> {
      let target: string;
      try {
        target = await deviceUrl(url, identity, options, since);
      } catch (err) {
        fail(err instanceof ChallengeError ? challengeFailure(err) : deviceKeyUnavailable(err));
        return;
      }
      if (closed || failure) return;
      connect(inner(target), identity, false);
    }

    // The gate failed in a way only a relay from before it fails: this attempt goes on over the
    // fetched challenge, on a new socket.
    function fallBack(frames: FrameSocket, identity: DeviceIdentity, why: string): void {
      if (socket !== frames || failure || closed) return;
      options.onPhase?.('challenge-fallback', `${why} ${since()}`);
      socket = null;
      frames.close();
      void connectFetched(identity);
    }

    function connect(frames: FrameSocket, identity: DeviceIdentity, gated: boolean): void {
      socket = frames;
      const initiator = new IkInitiator(identity.x25519, agentPublic);
      // Handshake steps are asynchronous (the device key's DH is WebCrypto), so frames are
      // handled one at a time, in order.
      let queue = Promise.resolve();
      let challenged = false;
      let admitted = !gated;
      let wait: ReturnType<typeof setTimeout> | undefined;
      const current = () => socket === frames;
      frames.onOpen(() => {
        if (!current()) return;
        options.onPhase?.('ws-open', since());
        if (admitted) handshake();
        else wait = setTimeout(() => !challenged && fallBack(frames, identity, 'no challenge'), GATE_WAIT_MS);
      });
      frames.onText((text) => {
        if (!current() || failure) return;
        if (!challenged) {
          const nonce = parseGateChallenge(text);
          if (!nonce) return fail('relay challenge failed: invalid challenge');
          challenged = true;
          clearTimeout(wait);
          options.onPhase?.('challenge', `ok ${since()}`);
          queue = queue.then(async () => {
            try {
              frames.sendText(encodeGateReply(await deviceParams(accountOf(url), nonce, identity, options)));
            } catch (err) {
              fail(deviceKeyUnavailable(err));
            }
          });
        } else if (!admitted && text === GATE_READY) {
          admitted = true;
          options.onPhase?.('admitted', since());
          handshake();
        } else {
          fail('secure channel failed');
        }
      });
      frames.onFrame((frame) => {
        if (!current()) return;
        if (!admitted) return fail('secure channel failed');
        queue = queue.then(() => receive(frame, initiator));
      });
      frames.onClose((info) => {
        if (!current()) return;
        clearTimeout(wait);
        // Only a relay from before the gate refuses a phone for having no device parameters.
        if (gated && !challenged && info?.reason === REFUSAL.deviceKeyRequired) {
          legacy.add(url);
          fallBack(frames, identity, 'legacy relay');
          return;
        }
        reportClose(info);
      });
      frames.onError?.(() => current() && errorListeners.forEach((l) => l()));

      function handshake(): void {
        queue = queue.then(async () => {
          try {
            // The hello proves the relay key is this phone's own, over this handshake.
            const hello = async (hash: Uint8Array) =>
              encodeDeviceHello({
                sig: identity.ed25519Public,
                name: options.deviceName,
                proof: await signDeviceHello(identity.sign, b64url.decode(identity.x25519Public), hash),
              });
            frames.send(handshakeFrame(await initiator.writeMessage1(hello), 'ik'));
          } catch (err) {
            const keyError = deviceKeyFailure(err);
            fail(keyError ? deviceKeyUnavailable(keyError) : 'secure channel failed');
          }
        });
      }
    }

    async function receive(frame: Uint8Array, initiator: IkInitiator): Promise<void> {
      if (failure) return;
      if (!session) {
        try {
          await initiator.readMessage2(readHandshakeFrame(frame, 'ik'));
        } catch (err) {
          const keyError = deviceKeyFailure(err);
          fail(keyError ? deviceKeyUnavailable(keyError) : 'agent key mismatch');
          return;
        }
        const { send, recv } = initiator.split();
        session = new SecureSession(send, recv);
        options.onPhase?.('handshake', since());
        openListeners.forEach((l) => l());
        return;
      }
      let message: Uint8Array | null;
      try {
        message = session.open(frame);
      } catch {
        fail('secure channel failed');
        return;
      }
      if (message) {
        const text = decoder.decode(message);
        messageListeners.forEach((l) => l(text));
      }
    }

    function handle(): Socket {
      return {
        send: (data) => {
          if (!session || failure || !socket) return;
          for (const frame of session.seal(encoder.encode(data))) socket.send(frame);
        },
        close: () => {
          if (closed) return;
          closed = true;
          if (socket) socket.close();
          else if (!failure) reportClose({ code: 1000 });
        },
        onMessage: (cb) => void messageListeners.push(cb),
        onOpen: (cb) => void openListeners.push(cb),
        onClose: (cb) => void closeListeners.push(cb),
        onError: (cb) => void errorListeners.push(cb),
      };
    }

    return handle();
  };
}

// The relay's challenge over plain HTTP. Rejects with a ChallengeError when there is no nonce,
// and with ChallengeTimeoutError when the fetch hangs.
export async function fetchRelayChallenge(url: string, timeoutMs = CHALLENGE_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new ChallengeError(`HTTP ${res.status}`);
    const { nonce } = (await res.json().catch(() => ({}))) as { nonce?: unknown };
    if (typeof nonce !== 'string' || !nonce) throw new ChallengeError('no nonce');
    return nonce;
  } catch (err) {
    if (controller.signal.aborted) throw new ChallengeTimeoutError(timeoutMs);
    throw err instanceof ChallengeError ? err : new ChallengeError('network error');
  } finally {
    clearTimeout(timer);
  }
}
