import { WebSocket } from 'ws';
import { MAX_FRAME_BYTES } from '@perch/secure-channel';
import type { RelayControl, RelayTransport } from '../ports/relay-port';

// The link sends a heartbeat every 20 s and the relay answers it (and some relay hosts ping as
// well). A control socket that hears nothing for longer than a couple of those is half-open (the
// relay host vanished without a FIN): drop it so the link redials instead of waiting forever on
// a socket nobody will ever write to.
const CONTROL_SILENCE_MS = 50_000;
// The silence timer only runs once a socket is open, so a handshake that stalls (a host that
// accepts the TCP connection and never answers) needs its own limit, or the link never redials.
const HANDSHAKE_TIMEOUT_MS = 10_000;
// ws accepts up to 100 MiB per message by default. Nothing on a relay socket is legitimately
// larger than one Noise frame, so a bigger one is refused before it is buffered.
const maxPayload = MAX_FRAME_BYTES;
// No compression: every frame is ciphertext, which does not compress, and each socket's zlib
// context is memory a relay could make the agent hold.
const perMessageDeflate = false;

export function createWsRelayTransport(
  options: { handshakeTimeoutMs?: number } = {},
): RelayTransport<WebSocket> {
  const handshakeTimeout = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  return {
    openControl(url: string, headers: Record<string, string>): RelayControl {
      const socket = new WebSocket(url, { handshakeTimeout, headers, maxPayload, perMessageDeflate });
      socket.on('error', () => undefined);
      let silence: ReturnType<typeof setTimeout> | undefined;
      const armSilence = () => {
        clearTimeout(silence);
        silence = setTimeout(() => socket.terminate(), CONTROL_SILENCE_MS);
      };
      socket.on('open', armSilence);
      socket.on('ping', armSilence);
      socket.on('message', armSilence);
      socket.on('close', () => clearTimeout(silence));
      return {
        onOpen: (listener) => socket.on('open', listener),
        onMessage: (listener) => socket.on('message', (data) => listener(String(data))),
        onClose: (listener) => socket.on('close', (code) => listener(code)),
        send: (text) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(text);
        },
        close: () => socket.terminate(),
      };
    },

    dial(url: string, headers: Record<string, string>): Promise<WebSocket> {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { handshakeTimeout, headers, maxPayload, perMessageDeflate });
        socket.once('error', reject);
        socket.once('unexpected-response', (_req, res) => {
          socket.terminate();
          reject(new Error(`relay answered ${res.statusCode}`));
        });
        socket.once('open', () => {
          socket.removeListener('error', reject);
          // Post-open errors also emit 'close', which the connection handles.
          socket.on('error', () => undefined);
          resolve(socket);
        });
      });
    },
  };
}

export const wsRelayTransport = createWsRelayTransport();
