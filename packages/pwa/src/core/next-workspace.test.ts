import { describe, it, expect } from 'vitest';
import type { Workspace, WorkspaceStatus } from '@perch/contracts';
import { nextWorkspace } from './next-workspace';

const ws = (id: string, status: WorkspaceStatus, machineId = 'm'): Workspace => ({
  id,
  name: id,
  machineId,
  projectPath: '/p',
  command: 'bash',
  createdAt: 0,
  lastActivityAt: 0,
  status,
});

describe('nextWorkspace', () => {
  it('takes the one after the active one when the active one still needs you', () => {
    const list = [ws('a', 'needs-feedback'), ws('b', 'needs-feedback'), ws('c', 'idle')];
    expect(nextWorkspace(list, list[0]!)?.id).toBe('b');
  });

  it('wraps to the top once the active one has gone to work', () => {
    const list = [ws('n1', 'needs-feedback'), ws('n2', 'idle'), ws('w1', 'working'), ws('a', 'working'), ws('w2', 'working')];
    expect(nextWorkspace(list, list[3]!)?.id).toBe('n1');
  });

  it('cycles past a skipped one instead of bouncing back to it', () => {
    const list = [ws('a', 'needs-feedback'), ws('b', 'needs-feedback'), ws('c', 'needs-hands')];
    expect(nextWorkspace(list, list[1]!)?.id).toBe('c');
    expect(nextWorkspace(list, list[2]!)?.id).toBe('a');
  });

  it('never picks a working or parked workspace', () => {
    const list = [ws('a', 'needs-feedback'), ws('p', 'parked'), ws('w', 'working')];
    expect(nextWorkspace(list, list[0]!)).toBeNull();
  });

  it('has nothing to offer when the active one is the only candidate', () => {
    expect(nextWorkspace([ws('a', 'idle')], ws('a', 'idle'))).toBeNull();
  });

  it('tells apart workspaces with the same id on different machines', () => {
    const list = [ws('x', 'needs-feedback', 'm1'), ws('x', 'needs-feedback', 'm2')];
    expect(nextWorkspace(list, list[0]!)?.machineId).toBe('m2');
  });

  it('starts from the top when the active one is no longer listed', () => {
    const list = [ws('a', 'needs-feedback'), ws('b', 'idle')];
    expect(nextWorkspace(list, ws('gone', 'working'))?.id).toBe('a');
  });

  it('walks parents then their children, so a child that needs you follows its working parent', () => {
    const list = [
      { ...ws('c', 'needs-feedback'), parentId: 'p' },
      ws('n', 'needs-feedback'),
      ws('p', 'working'),
      ws('i', 'idle'),
    ];
    expect(nextWorkspace(list, list[2]!)?.id).toBe('c');
    expect(nextWorkspace(list, list[0]!)?.id).toBe('n');
  });

  it('skips a child waiting on its orchestrator, which stays working', () => {
    const list = [ws('p', 'needs-feedback'), { ...ws('c', 'working'), parentId: 'p', waitingOn: 'parent' as const }];
    expect(nextWorkspace(list, list[0]!)).toBeNull();
  });
});
