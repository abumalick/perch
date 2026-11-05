import {
  IkInitiator,
  SecureSession,
  b64url,
  encodeDeviceHello,
  signDeviceHello,
  handshakeFrame,
  readHandshakeFrame,
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

export interface DeviceOptions {
  device: () => Promise<DeviceIdentity>;
  // The machine's bearer token, or the one-time pairing secret of a paired entry; empty once a
  // paired phone's secret is spent. Only whether there is one matters here: the credential itself
  // travels inside the session, in `auth`.
  token: string;
  deviceName: string;
  // Each phase of a connect with the time since the attempt began, for the connection log:
  // `device-key`, `ws-open` and `handshake`.
  onPhase?: (phase: string, detail: string) => void;
  now?: () => number;
}

// A machine's socket. Everything the connection sends, `auth` first, travels inside a Noise IK
// session pinned to the agent's public key and carrying the phone's own static key, so whatever
// fronts the agent (`tailscale serve`, Funnel, a proxy) only ever carries ciphertext and the
// agent knows which device it serves. The handshake starts as soon as the socket opens. `open`
// is reported only once the handshake has proven the far end holds the agent's key; until then
// sends are dropped, exactly as on a socket that is still connecting.
export function noiseSocketFactory(inner: FrameSocketFactory, agentKey: string, options: DeviceOptions): SocketFactory {
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
      try {
        identity = await options.device();
        options.onPhase?.('device-key', since());
      } catch (err) {
        fail(deviceKeyUnavailable(err));
        return;
      }
      if (closed || failure) return;
      connect(inner(url), identity);
    })();

    function connect(frames: FrameSocket, identity: DeviceIdentity): void {
      socket = frames;
      const initiator = new IkInitiator(identity.x25519, agentPublic);
      // Handshake steps are asynchronous (the device key's DH is WebCrypto), so frames are
      // handled one at a time, in order.
      let queue = Promise.resolve();
      frames.onOpen(() => {
        options.onPhase?.('ws-open', since());
        handshake();
      });
      frames.onFrame((frame) => {
        queue = queue.then(() => receive(frame, initiator));
      });
      frames.onClose((info) => reportClose(info));
      frames.onError?.(() => errorListeners.forEach((l) => l()));

      function handshake(): void {
        queue = queue.then(async () => {
          try {
            // The hello proves the device's Ed25519 key is this phone's own, over this handshake.
            const hello = async (hash: Uint8Array) =>
              encodeDeviceHello({
                sig: identity.ed25519Public,
                name: options.deviceName,
                proof: await signDeviceHello(identity.sign, b64url.decode(identity.x25519Public), hash),
                // Only with no credential to present: the agent must see a token or pairing code
                // (to refuse or burn it) before telling the phone it may forget it.
                ...(options.token === '' ? { push: true as const } : {}),
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
