import type { CloseInfo } from './socket';

// A socket carrying binary frames: the relay transport under the encrypted session. Text frames
// carry only the relay's device gate, before the session starts.
export interface FrameSocket {
  send(frame: Uint8Array): void;
  sendText(text: string): void;
  close(): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
  onText(cb: (text: string) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: (info?: CloseInfo) => void): void;
  onError?(cb: () => void): void;
}

export type FrameSocketFactory = (url: string) => FrameSocket;
