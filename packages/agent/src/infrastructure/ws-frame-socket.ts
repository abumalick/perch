import type { WebSocket } from 'ws';
import type { FrameSocket } from '../ports/frame-socket';
import type { RelayTransport } from '../ports/relay-port';

const CLOSE_GRACE_MS = 1000;

export function wsFrameSocket(socket: WebSocket): FrameSocket {
  return {
    send: (frame) => socket.send(frame, { binary: true }),
    onFrame: (listener) => socket.on('message', (data: Buffer) => listener(new Uint8Array(data))),
    onClose: (listener) => socket.on('close', () => listener()),
    close: (code, reason) => {
      socket.close(code, reason);
      // ws waits 30 s for the peer's close frame before it lets go of the socket, and a relay
      // need not send one. The frame (and the refusal it carries) is on its way by now.
      setTimeout(() => socket.terminate(), CLOSE_GRACE_MS).unref();
    },
  };
}

// A ws relay transport whose dialed sockets come out as FrameSockets.
export function frameSocketTransport(inner: RelayTransport<WebSocket>): RelayTransport<FrameSocket> {
  return {
    openControl: (url, headers) => inner.openControl(url, headers),
    dial: async (url, headers) => wsFrameSocket(await inner.dial(url, headers)),
  };
}
