import type { AgentMessage } from '@perch/contracts';

export interface ClientConnection {
  // Set once the transport itself has proven who the client is: `device`, a relay client whose
  // device key was enrolled at the handshake; `pairing`, one whose pairing secret was just
  // redeemed. `auth` then needs no token.
  readonly keyCredential?: 'device' | 'pairing';
  send(message: AgentMessage): void;
  close(): void;
  // Closes with a refusal the phone can read.
  refuse?(reason: string): void;
  onMessage(listener: (raw: unknown) => void): void;
  // Fired when the transport authenticated the client by its enrolled key at the handshake and
  // the client asked to be served at once: the handler answers `authResult` and the opening
  // replies without waiting for its `auth`.
  onKeyAuthenticated?(listener: () => void): void;
  onClose(listener: () => void): void;
}
