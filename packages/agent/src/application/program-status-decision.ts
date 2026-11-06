import type { WorkspaceStatus } from '@tarfa/contracts';

// Which rule decided, for the hook-event log only: nothing acts on it.
export type ProgramStatusReason =
  | 'osc-working'
  | 'osc-blocked'
  | 'osc-done'
  | 'osc-deferred'
  | 'osc-messaged'
  | 'osc-idle'
  | 'osc-manual'
  | 'osc-unknown';

export interface ProgramStatusDecision {
  reason: ProgramStatusReason;
  // null = leave the current status untouched.
  status: WorkspaceStatus | null;
  deferral?: 'clear';
}

// The second status source beside the hooks: the pane's OSC 7501 state (Program Status
// Protocol), read from a patched tmux. Called only when that state changes. It is authoritative
// for `blocked` and for the Esc interrupt (`working` → `idle`, which fires no hook). A turn end
// (`done`/`error`) yields to the hook marks: OSC says `done` while a background shell still runs
// and while a child waits on its orchestrator. `finished` and `parked` are the user's, never OSC's.
export function programStatusDecision(input: {
  state: string;
  currentStatus?: WorkspaceStatus;
  deferred: boolean;
  messagedLast: boolean;
}): ProgramStatusDecision {
  if (input.currentStatus === 'finished' || input.currentStatus === 'parked') {
    return { reason: 'osc-manual', status: null };
  }
  switch (input.state) {
    case 'working':
      return { reason: 'osc-working', status: 'working' };
    case 'blocked':
      return { reason: 'osc-blocked', status: 'needs-feedback' };
    case 'done':
    case 'error':
      if (input.deferred) return { reason: 'osc-deferred', status: null };
      if (input.messagedLast) return { reason: 'osc-messaged', status: null };
      return { reason: 'osc-done', status: 'needs-feedback' };
    // An Esc interrupt, or Codex's turn end (it says `idle`, not `done`): either way the session
    // waits on the user. Only a session still marked working is moved, so a hook's own
    // needs-feedback is never second-guessed.
    case 'idle':
      return input.currentStatus === 'working'
        ? { reason: 'osc-idle', status: 'needs-feedback', deferral: 'clear' }
        : { reason: 'osc-idle', status: null };
    default:
      return { reason: 'osc-unknown', status: null };
  }
}
