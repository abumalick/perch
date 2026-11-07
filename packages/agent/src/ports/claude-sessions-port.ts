export interface ClaudeInbox {
  socketPath: string;
  peerProtocol: number;
  token?: string;
}

export interface ClaudeSessionsPort {
  // Each live Claude Code session's address, keyed by the tmux session it runs in (which is
  // a Tarfa workspace id). Empty when the registry is absent — the PWA then shows no badge.
  addressesByTmuxSession(): Promise<Record<string, string>>;
  // The messaging socket of the live Claude session running in that tmux session, or null.
  // A `claude -p` or SDK run yields to an interactive session. Several left: the one on
  // `firstPane` (the session's first pane id, `%N`), else 'ambiguous', since a guess could hand
  // the message to the wrong conversation.
  inboxOf(tmuxSession: string, firstPane?: string | null): Promise<ClaudeInbox | null | 'ambiguous'>;
}
