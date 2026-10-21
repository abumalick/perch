// A socket carrying binary frames, as the relay delivers them to the agent.
export interface FrameSocket {
  send(frame: Uint8Array): void;
  onFrame(listener: (frame: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  close(code?: number, reason?: string): void;
}
