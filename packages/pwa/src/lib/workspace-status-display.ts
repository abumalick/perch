import { WORKSPACE_STATUSES, type Workspace, type WorkspaceStatus } from '@perch/contracts';

export const STATUS_LABELS: Record<WorkspaceStatus, string> = {
  'needs-feedback': 'Needs you',
  'needs-hands': 'Needs hands',
  idle: 'Idle',
  finished: 'Finished',
  review: 'Review',
  blocked: 'Blocked',
  parked: 'Parked',
  working: 'Working',
};

// A child waiting on its orchestrator stays `working` (it never alarms the user), but
// "Working" would hide that its orchestrator is the one who must act.
export function statusLabel(ws: Pick<Workspace, 'status' | 'waitingOn'>): string {
  return ws.status === 'working' && ws.waitingOn === 'parent'
    ? 'Needs orchestrator'
    : STATUS_LABELS[ws.status];
}

// The picker lists statuses in the same canonical order that drives the list sort.
export const STATUS_ORDER: readonly WorkspaceStatus[] = WORKSPACE_STATUSES;
