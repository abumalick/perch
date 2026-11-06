import { WORKSPACE_STATUSES, type Workspace, type WorkspaceStatus } from '@tarfa/contracts';
import { msg } from '../i18n.svelte';

// Getters, so each read at a call site takes the current language.
export const STATUS_LABELS: Record<WorkspaceStatus, string> = {
  get 'needs-feedback'() { return msg().status.labels['needs-feedback']; },
  get 'needs-hands'() { return msg().status.labels['needs-hands']; },
  get idle() { return msg().status.labels.idle; },
  get finished() { return msg().status.labels.finished; },
  get review() { return msg().status.labels.review; },
  get blocked() { return msg().status.labels.blocked; },
  get parked() { return msg().status.labels.parked; },
  get working() { return msg().status.labels.working; },
};

// A child waiting on its orchestrator stays `working` (it never alarms the user), but
// "Working" would hide that its orchestrator is the one who must act.
export function statusLabel(ws: Pick<Workspace, 'status' | 'waitingOn'>): string {
  return ws.status === 'working' && ws.waitingOn === 'parent'
    ? msg().status.needsOrchestrator
    : STATUS_LABELS[ws.status];
}

// The picker lists statuses in the same canonical order that drives the list sort.
export const STATUS_ORDER: readonly WorkspaceStatus[] = WORKSPACE_STATUSES;
