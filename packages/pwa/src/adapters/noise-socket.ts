import {
  IkInitiator,
  SecureSession,
  b64url,
  encodeDeviceHello,
  signDeviceHello,
  enrolKey,
  enrolProof,
  handshakeFrame,
  readHandshakeFrame,
  signDeviceAuth,
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
  // The relay's single-use challenge. It rejects with a ChallengeError when there is none to be
  // had, which fails the attempt so it is retried: without one the relay refuses the upgrade.
  fetchChallenge: (url: string) => Promise<string>;
  // Each phase of a connect with its outcome and the time since the attempt began, for the
  // connection log: `challenge`, `ws-open`, `handshake`.
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

// ws(s)://host/<account> → http(s)://host/<account>?role=challenge
export function challengeUrl(relayUrl: string): string {
  const url = new URL(relayUrl.replace(/^ws/, 'http'));
  url.search = '';
  url.searchParams.set('role', 'challenge');
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
  const account = target.pathname.replace(/^\/+|\/+$/g, '');
  const claim = { account, nonce, device: identity.ed25519Public };
  target.searchParams.set('device', identity.ed25519Public);
  target.searchParams.set('nonce', nonce);
  target.searchParams.set('sig', await signDeviceAuth(identity.sign, claim));
  if (options.token) {
    target.searchParams.set('proof', enrolProof(enrolKey(options.token, account), claim));
    if (options.credential === 'pairing' || options.credential === 'token') target.searchParams.set('cred', options.credential);
  }
  return target.toString();
}

// A relay machine's socket. The phone signs the relay's challenge with its device key, then
// everything the connection sends, `auth` first, travels inside a Noise IK session pinned to
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

    void (async () => {
      let identity: DeviceIdentity;
      let target: string;
      try {
        identity = await options.device();
        target = await deviceUrl(url, identity, options, since);
      } catch (err) {
        fail(err instanceof ChallengeError ? challengeFailure(err) : deviceKeyUnavailable(err));
        return;
      }
      if (closed || failure) return;
      connect(inner(target), identity);
    })();

    function connect(frames: FrameSocket, identity: DeviceIdentity): void {
      socket = frames;
      const initiator = new IkInitiator(identity.x25519, agentPublic);
      // Handshake steps are asynchronous (the device key's DH is WebCrypto), so frames are
      // handled one at a time, in order.
      let queue = Promise.resolve();
      frames.onOpen(() => {
        options.onPhase?.('ws-open', since());
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
      });
      frames.onFrame((frame) => {
        queue = queue.then(() => receive(frame, initiator));
      });
      frames.onClose((info) => reportClose(info));
      frames.onError?.(() => errorListeners.forEach((l) => l()));
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
