import type { FrameSocketFactory } from '../core/ports/frame-socket';

export const browserFrameSocketFactory: FrameSocketFactory = (url) => {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return {
    send: (frame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    },
    close: () => ws.close(),
    onFrame: (cb) =>
      ws.addEventListener('message', (e: MessageEvent) => {
        // The relay path is binary only; a text frame cannot be part of the session.
        if (e.data instanceof ArrayBuffer) cb(new Uint8Array(e.data));
        else ws.close();
      }),
    onOpen: (cb) => ws.addEventListener('open', () => cb()),
    onClose: (cb) => ws.addEventListener('close', (e: CloseEvent) => cb({ code: e.code, reason: e.reason })),
    onError: (cb) => ws.addEventListener('error', () => cb()),
  };
};
