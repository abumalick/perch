import type { Workspace } from '@perch/contracts';

export type WorkspaceGroup = { workspace: Workspace; children: Workspace[] };

const key = (machineId: string, id: string) => `${machineId}:${id}`;

// Lifts each child under its orchestrator. `sorted` is already in list order, so a group
// takes the place of its first member: a working parent with a child that needs you sorts
// with that child. A child nests only under a listed, unparked parent on the same
// connection that is not itself a child (one level), so a parked or missing parent, or a
// cycle, leaves it top-level rather than hidden.
export function nestWorkspaces(sorted: readonly Workspace[]): WorkspaceGroup[] {
  const byKey = new Map(sorted.map((ws) => [key(ws.machineId, ws.id), ws]));
  const parentOf = (ws: Workspace): Workspace | undefined => {
    if (!ws.parentId || ws.parentId === ws.id || ws.status === 'parked') return undefined;
    const parent = byKey.get(key(ws.machineId, ws.parentId));
    return parent && parent.status !== 'parked' ? parent : undefined;
  };
  const collects = (ws: Workspace) => ws.status !== 'parked' && !parentOf(ws);

  const groups = new Map<Workspace, { lead: number; group: WorkspaceGroup }>();
  const groupFor = (ws: Workspace, index: number) => {
    let entry = groups.get(ws);
    if (!entry) groups.set(ws, (entry = { lead: index, group: { workspace: ws, children: [] } }));
    entry.lead = Math.min(entry.lead, index);
    return entry.group;
  };
  sorted.forEach((ws, index) => {
    const parent = parentOf(ws);
    if (parent && collects(parent)) groupFor(parent, index).children.push(ws);
    else groupFor(ws, index);
  });
  return [...groups.values()].sort((a, b) => a.lead - b.lead).map((e) => e.group);
}

// The order the list reads in once nested: each parent, then its children.
export function nestedOrder(sorted: readonly Workspace[]): Workspace[] {
  return nestWorkspaces(sorted).flatMap((g) => [g.workspace, ...g.children]);
}
