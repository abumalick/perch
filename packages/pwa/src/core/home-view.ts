export type HomeView = 'add-machine' | 'list' | 'create' | 'connecting' | 'reconnecting' | 'unreachable';

// Picks which home screen to show. `connecting` vs `unreachable` is decided purely by
// `graceElapsed` (a time-based grace), not the per-machine connecting/offline status, so
// backoff retries flipping connecting<->offline never flicker the screen.
//
// `reconnecting` is distinct from `unreachable`: a machine that has connected before is known
// reachable and auto-retries forever, so we show a calm "Reconnecting…" indefinitely rather
// than the alarming "Can't reach your machines" (which is reserved for a machine that has
// never connected this session). `anyReconnecting` is sticky per session, so it doesn't
// flicker with the backoff connecting<->offline cycle.
//
// An online machine means nothing about workspaces until its reply to `list` arrives:
// while any online machine's reply is pending (`listsPending`) the loader stays up, so
// "No workspaces yet" is shown only once every online machine has answered with none.
export function deriveHomeView(input: {
  enabledMachineCount: number;
  anyOnline: boolean;
  workspaceCount: number;
  graceElapsed: boolean;
  listsPending: boolean;
  anyReconnecting?: boolean;
  // A machine the relay or agent refused with no retry due: its reason is shown at once.
  anyRefusedForGood?: boolean;
}): HomeView {
  if (input.enabledMachineCount === 0) return 'add-machine';
  if (input.workspaceCount > 0) return 'list';
  if (input.anyOnline) return input.listsPending ? 'connecting' : 'create';
  if (input.anyReconnecting) return 'reconnecting';
  if (input.anyRefusedForGood) return 'unreachable';
  if (!input.graceElapsed) return 'connecting';
  return 'unreachable';
}
