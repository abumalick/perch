export interface JoinRequest {
  account: string;
  // The agent's Ed25519 public key, which the relay registers for the account.
  key: string;
  authorization: string;
  join: string;
}

export interface RelayJoinPort {
  join(relayUrl: string, request: JoinRequest): Promise<{ status: number; body: string }>;
}
