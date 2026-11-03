export interface TmuxSessionInfo {
  name: string;
  startPath: string;
  command: string;
  createdAt: number;
  // The orchestrator workspace this one was spawned for (`@perch_parent`); absent when none.
  parent?: string;
  // The pane's OSC 7501 status (Program Status Protocol) and when tmux saw it change. Only a
  // tmux patched to keep it reports one; absent otherwise, and while the program reports nothing.
  program?: { state: string; changedAt: number };
  title: string;
}

// createSession's refusal of a name some session already has.
export class DuplicateSessionError extends Error {
  constructor(name: string) {
    super(`duplicate session: ${name}`);
  }
}

export interface TmuxPort {
  // Perch's sessions: every one it started (it sets `@perch_command` on each), and any whose
  // name has the old id prefix, which a tmux-resurrect bare shell keeps without the marker.
  listSessions(prefix: string): Promise<TmuxSessionInfo[]>;
  // `storedCommand` is what `@perch_command` records when it differs from the command launched
  // (a spawn launches with its brief, but unpark must resume without it).
  createSession(input: { name: string; cwd: string; command: string; parent?: string; storedCommand?: string }): Promise<void>;
  killSession(name: string): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  // The pid of the session's first pane, or null when the session is gone. Optional for the
  // same reason as `ensureHyperlinks`: it is additive, and an adapter that omits it simply
  // yields no scope to reap on close.
  panePid?(name: string): Promise<number | null>;
  // Identifies the running tmux server (its pid and start time), or null when none is
  // running. A different value than last seen means the server was replaced and took every
  // session with it. Optional and additive: without it, lost workspaces are not recovered.
  serverId?(): Promise<string | null>;
  // Best-effort: enable OSC 8 hyperlink passthrough for clients tmux renders to. Without
  // it tmux strips hyperlinks (its default terminal-features for xterm* omits `hyperlinks`),
  // so Claude Code's file/doc links reach the PWA as dead plain text. Optional because it
  // is an additive capability — an adapter that omits it just yields non-clickable links.
  ensureHyperlinks?(): Promise<void>;
  // The CLI's additions (`perch spawn` / `peek` / `--child`), optional for the same reason.
  setPaneTitle?(name: string, title: string): Promise<void>;
  // Whether the server can stop a pane's program from setting its title (`allow-set-title`,
  // tmux 3.5+), and doing so for one session's pane. Optional for the same reason.
  supportsTitleLock?(): Promise<boolean>;
  lockPaneTitle?(name: string): Promise<void>;
  // The pane's text from `historyLines` lines of scrollback to the bottom, wrapped lines joined.
  capturePane?(name: string, historyLines: number): Promise<string>;
  // The session holding a pane (e.g. `$TMUX_PANE`), or null when tmux cannot find it.
  sessionOfPane?(paneId: string): Promise<string | null>;
}
