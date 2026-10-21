// The agent's outbound link to a relay. The control socket carries the relay's
// `dial` requests and the agent's heartbeat; each dialed socket then carries one client's
// encrypted frames.
export interface RelayControl {
  onOpen(listener: () => void): void;
  onMessage(listener: (text: string) => void): void;
  // The close code the relay sent, or 1006 when the connection just dropped.
  onClose(listener: (code: number) => void): void;
  send(text: string): void;
  close(): void;
}

// A dial-back opened before any client asked for one. The relay pairs it with the next client,
// and it is then handed over as a dialed socket.
export interface RelaySpare<S> {
  onOpen(listener: () => void): void;
  onPaired(listener: (socket: S) => void): void;
  // Closed (or never opened) without being paired. Not called once paired.
  onClose(listener: () => void): void;
  send(text: string): void;
  close(): void;
}

export interface RelayTransport<S> {
  openControl(url: string, headers: Record<string, string>): RelayControl;
  dial(url: string, headers: Record<string, string>): Promise<S>;
  // Without it the agent dials a fresh socket for every client.
  spare?(url: string, headers: Record<string, string>): RelaySpare<S>;
}
