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

export interface RelayTransport<S> {
  openControl(url: string, headers: Record<string, string>): RelayControl;
  dial(url: string, headers: Record<string, string>): Promise<S>;
}
