import type { FrameSocketFactory } from '../core/ports/frame-socket';

export const browserFrameSocketFactory: FrameSocketFactory = (url) => {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const send = (data: Uint8Array | string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  return {
    send,
    sendText: send,
    close: () => ws.close(),
    onFrame: (cb) =>
      ws.addEventListener('message', (e: MessageEvent) => {
        if (e.data instanceof ArrayBuffer) cb(new Uint8Array(e.data));
      }),
    onText: (cb) =>
      ws.addEventListener('message', (e: MessageEvent) => {
        if (typeof e.data === 'string') cb(e.data);
      }),
    onOpen: (cb) => ws.addEventListener('open', () => cb()),
    onClose: (cb) => ws.addEventListener('close', (e: CloseEvent) => cb({ code: e.code, reason: e.reason })),
    onError: (cb) => ws.addEventListener('error', () => cb()),
  };
};
