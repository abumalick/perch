import type { WebSocket } from 'ws';
import type { FrameSocket } from '../ports/frame-socket';

const CLOSE_GRACE_MS = 1000;

// `binaryOnly` drops text frames: every frame of a session is binary.
export function wsFrameSocket(socket: WebSocket, binaryOnly = false): FrameSocket {
  return {
    send: (frame) => socket.send(frame, { binary: true }),
    onFrame: (listener) =>
      socket.on('message', (data: Buffer, isBinary) => {
        if (isBinary || !binaryOnly) listener(new Uint8Array(data));
      }),
    onClose: (listener) => socket.on('close', () => listener()),
    close: (code, reason) => {
      socket.close(code, reason);
      // ws waits 30 s for the peer's close frame before it lets go of the socket, and a peer
      // need not send one. The frame (and the refusal it carries) is on its way by now.
      setTimeout(() => socket.terminate(), CLOSE_GRACE_MS).unref();
    },
  };
}
