import { describe, it, expect } from 'vitest';
import type { Workspace } from '@perch/contracts';
import { formatAge, formatWorkspaceTable } from './format-workspace-table';

const NOW = 1_000_000_000_000;
const ws = (over: Partial<Workspace>): Workspace => ({
  machineId: 'dev',
  id: 'perch-aaaaaa',
  name: 'Fix login',
  projectPath: '/home/u/workspace/foo',
  command: 'claude',
  createdAt: NOW - 3_600_000,
  lastActivityAt: NOW - 300_000,
  status: 'working',
  ...over,
});

describe('formatAge', () => {
  it('uses the largest whole unit', () => {
    expect(formatAge(45_000)).toBe('45s');
    expect(formatAge(5 * 60_000)).toBe('5m');
    expect(formatAge(3 * 3_600_000 + 59 * 60_000)).toBe('3h');
    expect(formatAge(2 * 86_400_000)).toBe('2d');
    expect(formatAge(-5)).toBe('0s');
  });
});

describe('formatWorkspaceTable', () => {
  it('prints a header and one aligned row per workspace', () => {
    const out = formatWorkspaceTable(
      [
        ws({ agentAddress: 'foo-ab', parentId: 'perch-pppppp' }),
        ws({ id: 'perch-bbbbbb', name: 'Other', status: 'needs-feedback', urgent: true, projectPath: '/srv/x', lastActivityAt: NOW - 2 * 86_400_000 }),
      ],
      { now: NOW, home: '/home/u' },
    );
    expect(out.split('\n')).toEqual([
      'ID            NAME    STATUS                   AGE  PARENT        TITLE      FOLDER',
      'perch-aaaaaa  foo-ab  working                  5m   perch-pppppp  Fix login  ~/workspace/foo',
      'perch-bbbbbb  -       needs-feedback (urgent)  2d   -             Other      /srv/x',
    ]);
  });

  it('abbreviates only the home directory itself, not a sibling sharing its prefix', () => {
    const out = formatWorkspaceTable([ws({ projectPath: '/home/u' }), ws({ projectPath: '/home/user2/x' })], { now: NOW, home: '/home/u' });
    expect(out).toMatch(/ ~\n/);
    expect(out).toContain('/home/user2/x');
  });

  it('shortens a long title', () => {
    const out = formatWorkspaceTable([ws({ name: 'x'.repeat(60) })], { now: NOW, home: '/home/u' });
    expect(out).toContain(`${'x'.repeat(39)}…`);
    expect(out).not.toContain('x'.repeat(41));
  });

  it('says so when there are none', () => {
    expect(formatWorkspaceTable([], { now: NOW, home: '/home/u' })).toBe('no workspaces');
  });

  it('shows a child waiting on its orchestrator as needs-orchestrator', () => {
    const out = formatWorkspaceTable([ws({ parentId: 'perch-pppppp', waitingOn: 'parent' })], { now: NOW, home: '/home/u' });
    expect(out.split('\n')[1]).toMatch(/^perch-aaaaaa +- +needs-orchestrator +5m +perch-pppppp/);
  });
});
