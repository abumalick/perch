import { describe, it, expect } from 'vitest';
import { sortByStatus, type Workspace, type WorkspaceStatus } from '@perch/contracts';
import { nestWorkspaces, nestedOrder } from './nest-workspaces';

const ws = (
  id: string,
  status: WorkspaceStatus,
  extra: Partial<Workspace> = {},
): Workspace => ({
  id,
  name: id,
  machineId: 'm',
  projectPath: '/p',
  command: 'bash',
  createdAt: 0,
  lastActivityAt: 0,
  status,
  ...extra,
});

const shape = (groups: ReturnType<typeof nestWorkspaces>) =>
  groups.map((g) => [g.workspace.id, g.children.map((c) => c.id)]);

describe('nestWorkspaces', () => {
  it('lifts a child under its parent on the same machine', () => {
    const list = [ws('p', 'idle'), ws('x', 'idle'), ws('c', 'idle', { parentId: 'p' })];
    expect(shape(nestWorkspaces(list))).toEqual([['p', ['c']], ['x', []]]);
  });

  it('keeps a child top-level when its parent id names a workspace on another machine', () => {
    const list = [ws('p', 'idle', { machineId: 'a' }), ws('c', 'idle', { machineId: 'b', parentId: 'p' })];
    expect(shape(nestWorkspaces(list))).toEqual([['p', []], ['c', []]]);
  });

  it('keeps an orphan top-level', () => {
    const list = [ws('c', 'idle', { parentId: 'gone' }), ws('x', 'idle')];
    expect(shape(nestWorkspaces(list))).toEqual([['c', []], ['x', []]]);
  });

  it('keeps the child of a parked parent top-level', () => {
    const list = sortByStatus([ws('p', 'parked'), ws('c', 'working', { parentId: 'p' })]);
    expect(shape(nestWorkspaces(list))).toEqual([['p', []], ['c', []]]);
  });

  it('leaves a parked child out of its parent, top-level for the Parked group', () => {
    const list = sortByStatus([ws('p', 'working'), ws('c', 'parked', { parentId: 'p' })]);
    expect(shape(nestWorkspaces(list))).toEqual([['c', []], ['p', []]]);
  });

  it('ranks a parent with the most urgent of itself and its children', () => {
    const list = sortByStatus([
      ws('p', 'working'),
      ws('n', 'needs-feedback', { lastActivityAt: 5 }),
      ws('c', 'needs-feedback', { parentId: 'p', lastActivityAt: 1 }),
      ws('i', 'idle'),
    ]);
    expect(shape(nestWorkspaces(list))).toEqual([['p', ['c']], ['n', []], ['i', []]]);
  });

  it('counts an urgent child as lifting its parent within the same status', () => {
    const list = sortByStatus([
      ws('n', 'needs-feedback'),
      ws('p', 'working'),
      ws('c', 'needs-feedback', { parentId: 'p', urgent: true }),
    ]);
    expect(shape(nestWorkspaces(list))).toEqual([['p', ['c']], ['n', []]]);
  });

  it('keeps children in list order', () => {
    const list = sortByStatus([
      ws('p', 'idle'),
      ws('c1', 'working', { parentId: 'p' }),
      ws('c2', 'needs-feedback', { parentId: 'p' }),
    ]);
    expect(shape(nestWorkspaces(list))).toEqual([['p', ['c2', 'c1']]]);
  });

  it('nests one level only: a grandchild stays top-level', () => {
    const list = [ws('a', 'idle'), ws('b', 'idle', { parentId: 'a' }), ws('c', 'idle', { parentId: 'b' })];
    expect(shape(nestWorkspaces(list))).toEqual([['a', ['b']], ['c', []]]);
  });

  it('shows both sides of a parent cycle top-level rather than losing them', () => {
    const list = [ws('a', 'idle', { parentId: 'b' }), ws('b', 'idle', { parentId: 'a' })];
    expect(shape(nestWorkspaces(list))).toEqual([['a', []], ['b', []]]);
  });

  it('does not nest a workspace under itself', () => {
    expect(shape(nestWorkspaces([ws('a', 'idle', { parentId: 'a' })]))).toEqual([['a', []]]);
  });
});

describe('nestedOrder', () => {
  it('walks each parent then its children', () => {
    const list = sortByStatus([
      ws('p', 'working'),
      ws('c', 'needs-feedback', { parentId: 'p' }),
      ws('i', 'idle'),
    ]);
    expect(nestedOrder(list).map((w) => w.id)).toEqual(['p', 'c', 'i']);
  });
});
