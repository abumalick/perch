import { describe, it, expect } from 'vitest';
import { applyProgramStatus } from './apply-program-status';
import { applyHookEvent } from './apply-hook-event';
import type { WorkspaceStatus } from '@tarfa/contracts';
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
    sentDuringTool: new Set<string>(),
    questionPending: new Set<string>(),
    seen: new Map<string, string>(),
    oscTurnEnded: new Set<string>(),
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

// The hook and OSC sources share their marks, as WsServer wires them.
describe('OSC 7501 and the Stop hook together', () => {
  const runningShell = { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] };
  const runningSubagent = { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] };

  function both(initial: WorkspaceStatus) {
    const { deps } = setup({ 'perch-aa': initial });
    const hook = (event: string, claude?: unknown) =>
      applyHookEvent({ ...deps, store: { ...deps.store, setClaudeSessionId: () => undefined } }, {
        sessionName: 'perch-aa',
        event,
        claude,
      });
    const osc = (state: string, changedAt: number) => applyProgramStatus(deps, [pane('perch-aa', state, changedAt)]);
    return { deps, hook, osc, status: () => deps.store.get('perch-aa') };
  }

  it('keeps a background shell working when OSC says done before the Stop lands', () => {
    const { deps, hook, osc, status } = both('working');
    osc('working', 1);
    osc('done', 2);
    expect(status()).toBe('needs-feedback');
    hook('Stop', runningShell);
    expect(status()).toBe('working');
    expect(deps.deferred.has('perch-aa')).toBe(true);
    expect(deps.oscTurnEnded.has('perch-aa')).toBe(false);
  });

  it('keeps a background shell working when the Stop lands first', () => {
    const { hook, osc, status } = both('working');
    osc('working', 1);
    hook('Stop', runningShell);
    osc('done', 2);
    expect(status()).toBe('working');
  });

  // A background subagent's permission prompt: the user is asked, so the main turn's Stop,
  // which lists that subagent as running, must not hide it behind "working".
  it('leaves a permission prompt at needs-feedback through a deferring Stop', () => {
    const { hook, status } = both('working');
    hook('Notification', { notification_type: 'permission_prompt' });
    hook('Stop', runningSubagent);
    expect(status()).toBe('needs-feedback');
  });

  it('leaves an OSC blocked at needs-feedback through a deferring Stop', () => {
    const { hook, osc, status } = both('working');
    osc('working', 1);
    osc('blocked', 2);
    hook('Stop', runningSubagent);
    expect(status()).toBe('needs-feedback');
  });

  it('forgets an OSC turn end once a hook sets the status itself', () => {
    const { deps, hook, osc } = both('working');
    osc('working', 1);
    osc('done', 2);
    hook('UserPromptSubmit');
    expect(deps.oscTurnEnded.has('perch-aa')).toBe(false);
  });
});
