import type { Workspace } from '@tarfa/contracts';

export const WORKSPACE_ROLES = ['orchestrator', 'child', 'normal'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

// Derived from the `--child` links among the listed workspaces. A child that spawned children of
// its own is an orchestrator: its parent is still in its parentId.
export function workspaceRole(w: Workspace, all: readonly Workspace[]): WorkspaceRole {
  if (all.some((other) => other.parentId === w.id)) return 'orchestrator';
  return w.parentId ? 'child' : 'normal';
}

export function isUnderPath(path: string, dir: string): boolean {
  const base = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
}
