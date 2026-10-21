// Both sides of a browser stream: the downstream PWA viewer stream and the upstream
// agent-browser stream socket share this shape, so the handler pipes strings between
// them without knowing about `ws`.
export interface BrowserStreamSocket {
  send(data: string): void;
  // Bytes accepted by send() but not yet flushed to the network. Absent means the
  // socket never backpressures (upstream loopback, fakes).
  bufferedAmount?(): number;
  // Called when bufferedAmount has gone down, so a frame held back can go out without waiting
  // for the next upstream message (a static page may send none for a long time). Absent means
  // the socket never reports it.
  onDrain?(listener: () => void): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export type ConnectUpstream = (port: number) => Promise<BrowserStreamSocket>;
