import { describe, it, expect, vi } from 'vitest';
import { unparkWorkspace } from './unpark-workspace';
import type { ParkedWorkspace } from '../ports/parked-store-port';

const record: ParkedWorkspace = {
  id: 'perch-a',
  name: 'Fix login redirect',
  projectPath: '/home/u/workspace/foo',
  command: 'claude --model opus',
  machineId: 'dev',
  createdAt: 100,
  parkedAt: 500,
  claudeSessionId: 'sess-1',
};

function makeDeps(entryArg?: ParkedWorkspace, isDirectory = true, titleLock = true) {
  // A default parameter (`entry = record`) would also fire on an *explicit* `undefined`
  // argument, silently defeating the "no record" test case. `arguments.length` is the only
  // way to tell "omitted" from "passed undefined" apart.
  const entry = arguments.length > 0 ? entryArg : record;
  const removed: string[] = [];
  const calls: string[] = [];
  return {
    removed,
    calls,
    deps: {
      parked: {
        get: async (id: string) => (entry && entry.id === id ? entry : undefined),
        remove: async (id: string) => {
          removed.push(id);
        },
      },
      tmux: {
        createSession: vi.fn(async (_opts: { name: string }) => {
          calls.push('create');
        }),
        supportsTitleLock: vi.fn(async () => titleLock),
        lockPaneTitle: vi.fn(async (_name: string) => {
          calls.push('lock');
        }),
        setPaneTitle: vi.fn(async (_name: string, _title: string) => {
          calls.push('title');
        }),
      },
      isDirectory: async () => isDirectory,
      status: { set: vi.fn() },
    },
  };
}

describe('unparkWorkspace', () => {
  it('reports not-parked for an id with no record, touching nothing', async () => {
    const { deps } = makeDeps(undefined);
    expect(await unparkWorkspace(deps, 'perch-a')).toBe('not-parked');
    expect(deps.tmux.createSession).not.toHaveBeenCalled();
  });

  it('recreates the session with the original id, cwd, and a resume-injected command', async () => {
    const { deps } = makeDeps();
    expect(await unparkWorkspace(deps, 'perch-a')).toBe('unparked');
    expect(deps.tmux.createSession).toHaveBeenCalledWith({
      name: 'perch-a',
      cwd: '/home/u/workspace/foo',
      command: 'claude --model opus --resume sess-1 || exec claude --model opus',
      storedCommand: 'claude --model opus',
    });
  });

  // Without this the child would come back with no `@perch_parent`, and lose its orchestrator.
  it('recreates the session with its parent link', async () => {
    const { deps } = makeDeps({ ...record, parent: 'perch-p' });
    await unparkWorkspace(deps, 'perch-a');
    expect(deps.tmux.createSession).toHaveBeenCalledWith(expect.objectContaining({ parent: 'perch-p' }));
  });

  // The name comes from the pane title, which the resumed Claude would otherwise rewrite: to the
  // bare id for a `--name perch-…` spawn, or to a fresh summary.
  it('restores the parked name as a glyph-prefixed pane title, locked before it is set', async () => {
    const { deps, calls } = makeDeps({ ...record, name: 'audit claude workflows #1077' });
    await unparkWorkspace(deps, 'perch-a');
    expect(deps.tmux.lockPaneTitle).toHaveBeenCalledWith('perch-a');
    expect(deps.tmux.setPaneTitle).toHaveBeenCalledWith('perch-a', '✳ audit claude workflows #1077');
    expect(calls).toEqual(['create', 'lock', 'title']);
  });

  it('still sets the title where tmux cannot lock it', async () => {
    const { deps } = makeDeps(record, true, false);
    await unparkWorkspace(deps, 'perch-a');
    expect(deps.tmux.lockPaneTitle).not.toHaveBeenCalled();
    expect(deps.tmux.setPaneTitle).toHaveBeenCalledWith('perch-a', '✳ Fix login redirect');
  });

  it('still unparks when the title cannot be set', async () => {
    const { deps, removed } = makeDeps();
    deps.tmux.setPaneTitle.mockRejectedValueOnce(new Error('no pane'));
    expect(await unparkWorkspace(deps, 'perch-a')).toBe('unparked');
    expect(removed).toEqual(['perch-a']);
  });

  it('runs the original command verbatim when there is no session id', async () => {
    const { claudeSessionId: _drop, ...noSession } = record;
    const { deps } = makeDeps(noSession);
    await unparkWorkspace(deps, 'perch-a');
    expect(deps.tmux.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'claude --model opus' }),
    );
  });

  it('clears the record and resets the status to idle', async () => {
    const { removed, deps } = makeDeps();
    await unparkWorkspace(deps, 'perch-a');
    expect(removed).toEqual(['perch-a']);
    expect(deps.status.set).toHaveBeenCalledWith('perch-a', 'idle');
  });

  it('refuses when the project directory is gone, keeping the record intact', async () => {
    // tmux new-session -c silently runs in $HOME when the cwd is missing, and resume is
    // scoped to the project directory — so a missing directory must not create a session.
    const { removed, deps } = makeDeps(record, false);
    expect(await unparkWorkspace(deps, 'perch-a')).toBe('missing-directory');
    expect(deps.tmux.createSession).not.toHaveBeenCalled();
    expect(deps.tmux.setPaneTitle).not.toHaveBeenCalled();
    expect(removed).toEqual([]);
  });
});
