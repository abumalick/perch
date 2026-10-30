import type { Workspace } from '@perch/contracts';
import { nestedOrder } from './nest-workspaces';

// The workspace a "Next" tap opens: the first one after `active` in list order that
// could want the user (not working, and not parked, since opening a parked one revives
// it), wrapping to the top. Taking the one *after* the active rather than the first one
// lets the user pass over a session that still needs them; wrapping means one that just
// went to work hands over to the top of the queue. List order is the nested one (each
// orchestrator, then its children), folded or not.
export function nextWorkspace(
  sorted: readonly Workspace[],
  active: Pick<Workspace, 'id' | 'machineId'>,
): Workspace | null {
  const order = nestedOrder(sorted);
  const isActive = (ws: Workspace) => ws.id === active.id && ws.machineId === active.machineId;
  const at = order.findIndex(isActive);
  const candidate = (ws: Workspace) =>
    !isActive(ws) && ws.status !== 'working' && ws.status !== 'parked';
  return order.slice(at + 1).find(candidate) ?? order.slice(0, at + 1).find(candidate) ?? null;
}
