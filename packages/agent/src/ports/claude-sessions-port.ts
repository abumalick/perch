export interface ClaudeInbox {
  socketPath: string;
  peerProtocol: number;
  token?: string;
}

export interface ClaudeSessionsPort {
  // Each live Claude Code session's address, keyed by the tmux session it runs in (which is
  // a Perch workspace id). Empty when the registry is absent — the PWA then shows no badge.
  addressesByTmuxSession(): Promise<Record<string, string>>;
  // The messaging socket of the live Claude session running in that tmux session, or null.
  inboxOf(tmuxSession: string): Promise<ClaudeInbox | null>;
}
