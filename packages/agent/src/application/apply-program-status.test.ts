import { describe, it, expect } from 'vitest';
import { applyProgramStatus } from './apply-program-status';
import type { WorkspaceStatus } from '@perch/contracts';
import type { HookEventEntry } from '../ports/hook-event-log-port';

function setup(initial: Record<string, WorkspaceStatus> = {}) {
  const current = new Map(Object.entries(initial));
  const sets: Array<[string, WorkspaceStatus]> = [];
  const entries: HookEventEntry[] = [];
  const deps = {
    store: {
      get: (id: string) => current.get(id),
      set: (id: string, s: WorkspaceStatus) => {
        sets.push([id, s]);
        current.set(id, s);
      },
    },
    deferred: new Set<string>(),
    messagedLast: new Set<string>(),
    questionPending: new Set<string>(),
    seen: new Map<string, string>(),
    log: { append: async (e: HookEventEntry) => void entries.push(e) },
  };
  return { deps, sets, entries };
}

const pane = (name: string, state?: string, changedAt = 1) => ({
  name,
  ...(state ? { program: { state, changedAt } } : {}),
});

describe('applyProgramStatus', () => {
  // The record persists with no heartbeat: an hours-old `done` must not overwrite what
  // status.json held when the agent restarts.
  it('only records a pane the first time it sees it', () => {
    const { deps, sets } = setup({ 'perch-aa': 'working' });
    applyProgramStatus(deps, [pane('perch-aa', 'done')]);
    expect(sets).toEqual([]);
  });

  it('applies a change of state', () => {
    const { deps, sets } = setup({ 'perch-aa': 'working' });
    applyProgramStatus(deps, [pane('perch-aa', 'working', 1)]);
    applyProgramStatus(deps, [pane('perch-aa', 'idle', 2)]);
    expect(sets).toEqual([['perch-aa', 'needs-feedback']]);
  });

  it('applies nothing while the state is unchanged', () => {
    const { deps, sets } = setup({ 'perch-aa': 'working' });
    applyProgramStatus(deps, [pane('perch-aa', 'done', 1)]);
    deps.store.set('perch-aa', 'finished');
    sets.length = 0;
    applyProgramStatus(deps, [pane('perch-aa', 'done', 1)]);
    expect(sets).toEqual([]);
  });

  // A whole turn can fit between two polls; tmux's change time still moves.
  it('applies the same state again when it was reported anew', () => {
    const { deps, sets } = setup({ 'perch-aa': 'idle' });
    applyProgramStatus(deps, [pane('perch-aa', 'idle', 1)]);
    deps.store.set('perch-aa', 'working');
    sets.length = 0;
    applyProgramStatus(deps, [pane('perch-aa', 'idle', 5)]);
    expect(sets).toEqual([['perch-aa', 'needs-feedback']]);
  });

  it('honours the hook marks and clears the deferral on an interrupt', () => {
    const { deps, sets } = setup({ 'perch-aa': 'working', 'perch-bb': 'working' });
    deps.deferred.add('perch-aa').add('perch-bb');
    applyProgramStatus(deps, [pane('perch-aa', 'working', 1), pane('perch-bb', 'working', 1)]);
    applyProgramStatus(deps, [pane('perch-aa', 'done', 2), pane('perch-bb', 'idle', 2)]);
    expect(sets).toEqual([['perch-bb', 'needs-feedback']]);
    expect(deps.deferred.has('perch-aa')).toBe(true);
    expect(deps.deferred.has('perch-bb')).toBe(false);
  });

  // Stock tmux expands the unknown format to nothing: hooks alone then decide.
  it('does nothing for a pane with no reported state', () => {
    const { deps, sets, entries } = setup({ 'perch-aa': 'working' });
    applyProgramStatus(deps, [pane('perch-aa')]);
    applyProgramStatus(deps, [pane('perch-aa')]);
    expect(sets).toEqual([]);
    expect(entries).toEqual([]);
  });

  it('forgets a pane that is gone, so its return counts as a first sighting', () => {
    const { deps, sets } = setup({ 'perch-aa': 'working' });
    applyProgramStatus(deps, [pane('perch-aa', 'working', 1)]);
    applyProgramStatus(deps, []);
    expect(deps.seen.size).toBe(0);
    applyProgramStatus(deps, [pane('perch-aa', 'done', 2)]);
    expect(sets).toEqual([]);
  });

  it('logs each applied change with the rule that decided it', () => {
    const { deps, entries } = setup({ 'perch-aa': 'working' });
    deps.messagedLast.add('perch-aa');
    applyProgramStatus(deps, [pane('perch-aa', 'working', 1)]);
    applyProgramStatus(deps, [pane('perch-aa', 'done', 2)]);
    expect(entries).toEqual([
      {
        workspace: 'perch-aa',
        event: 'OSC7501',
        programState: 'done',
        reason: 'osc-messaged',
        before: { status: 'working', deferred: false, messagedLast: true, questionPending: false },
        after: { status: 'working', deferred: false, messagedLast: true, questionPending: false },
      },
    ]);
  });

  it('returns the workspaces whose status it changed', () => {
    const { deps } = setup({ 'perch-aa': 'working' });
    applyProgramStatus(deps, [pane('perch-aa', 'working', 1)]);
    expect(applyProgramStatus(deps, [pane('perch-aa', 'blocked', 2)])).toEqual(['perch-aa']);
  });
});
