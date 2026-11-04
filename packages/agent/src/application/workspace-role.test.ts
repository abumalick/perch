import { describe, it, expect } from 'vitest';
import type { Workspace } from '@perch/contracts';
import { isUnderPath, workspaceRole } from './workspace-role';

const ws = (id: string, parentId?: string): Workspace => ({
  machineId: 'dev',
  id,
  name: id,
  projectPath: '/w',
  command: 'claude',
  createdAt: 0,
  lastActivityAt: 0,
  status: 'working',
  ...(parentId ? { parentId } : {}),
});

describe('workspaceRole', () => {
  const all = [ws('top'), ws('mid', 'top'), ws('leaf', 'mid'), ws('solo'), ws('orphan', 'gone')];

  it('names a workspace with listed children an orchestrator, even when it is a child too', () => {
    expect(workspaceRole(all[0]!, all)).toBe('orchestrator');
    expect(workspaceRole(all[1]!, all)).toBe('orchestrator');
  });

  it('names a workspace with a parent a child, whether or not the parent is still listed', () => {
    expect(workspaceRole(all[2]!, all)).toBe('child');
    expect(workspaceRole(all[4]!, all)).toBe('child');
  });

  it('names any other workspace normal', () => {
    expect(workspaceRole(all[3]!, all)).toBe('normal');
  });
});

describe('isUnderPath', () => {
  it('matches the directory itself and anything below it', () => {
    expect(isUnderPath('/w/foo', '/w/foo')).toBe(true);
    expect(isUnderPath('/w/foo/.worktrees/x', '/w/foo')).toBe(true);
    expect(isUnderPath('/w/foo', '/w/foo/')).toBe(true);
    expect(isUnderPath('/w/foo', '/')).toBe(true);
  });

  it('does not match a sibling sharing its prefix, or a parent', () => {
    expect(isUnderPath('/w/foobar', '/w/foo')).toBe(false);
    expect(isUnderPath('/w', '/w/foo')).toBe(false);
  });
});
