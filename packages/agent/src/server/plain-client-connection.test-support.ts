import type { WebSocket } from 'ws';
import type { AgentMessage } from '@perch/contracts';
import type { ClientConnection } from '../ports/client-connection';

// Test support only: a client in plaintext JSON, to exercise what WsServer does with a client
// without playing a Noise handshake. Phones never reach the agent this way; they come through
// the relays it dials out to.
export class PlainClientConnection implements ClientConnection {
  constructor(private readonly socket: WebSocket) {}

  send(message: AgentMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }

  onMessage(listener: (raw: unknown) => void): void {
    this.socket.on('message', (data: unknown) => {
      const text = String(data);
      try {
        listener(JSON.parse(text));
      } catch {
        listener(text);
      }
    });
  }

  onClose(listener: () => void): void {
    this.socket.on('close', listener);
  }
}
