import { describe, expect, it } from 'vitest';
import { reconcileAtStartup, type StartupReconcileDeps } from './startup-reconcile';
import type { LiveSnapshot } from '../ports/live-snapshot-port';
import type { ParkedWorkspace } from '../ports/parked-store-port';
import type { TmuxSessionInfo } from '../ports/tmux-port';
import type { WorkspaceStatus } from '@tarfa/contracts';

// A tmux whose sessions an agent from before the rename tagged `@perch_command` only. Like a
// listing that reads the new marker alone, it lists a short-id session only once it is re-tagged,
// so a startup that re-tags too late loses it.
function harness(opts: { retag?: boolean } = {}) {
  const calls: string[] = [];
  const tags: Record<string, { tarfa?: string; perch?: string; parent?: string }> = {
    'repo-1': { perch: 'claude', parent: 'orch-1' },
    'orch-1': { perch: 'claude' },
  };
  const statuses: Record<string, WorkspaceStatus> = { 'repo-1': 'working', 'orch-1': 'needs-feedback' };
  const sessionIds: Record<string, string> = { 'repo-1': 'sess-1', 'orch-1': 'sess-2' };
  const snapshot: LiveSnapshot = {
    serverId: 'srv-1',
    workspaces: ['repo-1', 'orch-1'].map((id) => ({ id, name: id, projectPath: '/w/repo', command: 'claude', machineId: 'dev', createdAt: 1, claudeSessionId: sessionIds[id] })),
  };
  const parked: ParkedWorkspace[] = [];
  const killed: string[] = [];
  const log: string[] = [];
  const deps: StartupReconcileDeps = {
    tmux: {
      serverId: async () => 'srv-1',
      listSessions: async () => {
        calls.push('listSessions');
        return Object.entries(tags)
          .filter(([, t]) => t.tarfa !== undefined)
          .map(([name, t]): TmuxSessionInfo => ({ name, startPath: '/w/repo', command: t.tarfa!, createdAt: 1, title: '', ...(t.parent ? { parent: t.parent } : {}) }));
      },
      hasSession: async (name) => name in tags,
      killSession: async (name) => {
        killed.push(name);
      },
      ...(opts.retag === false
        ? {}
        : {
            retagLegacyOptions: async () => {
              calls.push('retag');
              let n = 0;
              for (const t of Object.values(tags)) {
                if (t.perch !== undefined && t.tarfa === undefined) {
                  t.tarfa = t.perch;
                  n++;
                }
              }
              return n;
            },
          }),
    },
    snapshot: { read: async () => snapshot, write: async () => undefined },
    parked: { list: async () => parked, add: async (p) => void parked.push(p) },
    status: {
      get: (id) => statuses[id],
      getClaudeSessionId: (id) => sessionIds[id],
      set: (id, s) => {
        statuses[id] = s;
      },
      prune: (live) => {
        calls.push('prune');
        const keep = new Set(live);
        for (const id of Object.keys(statuses)) if (!keep.has(id)) delete statuses[id];
      },
    },
    workspaceLog: { append: async () => undefined },
    clock: { now: () => 5 },
    machineId: 'dev',
    sessionPrefix: 'perch-',
    log: (line) => log.push(line),
  };
  return { deps, calls, statuses, parked, killed, log };
}

describe('reconcileAtStartup', () => {
  it('re-tags before anything lists the sessions, so live workspaces keep their status', async () => {
    const h = harness();
    await reconcileAtStartup(h.deps);
    expect(h.calls[0]).toBe('retag');
    expect(h.calls.at(-1)).toBe('prune');
    expect(h.statuses).toEqual({ 'repo-1': 'working', 'orch-1': 'needs-feedback' });
    expect(h.parked).toEqual([]);
    expect(h.killed).toEqual([]);
    expect(h.log).toContain('tarfa agent: re-tagged 2 @perch_ tmux option(s) as @tarfa_');
  });

  // The failure the order prevents: without a re-tag, the prune drops what it cannot list.
  it('would prune the untagged workspaces without the re-tag', async () => {
    const h = harness({ retag: false });
    await reconcileAtStartup(h.deps);
    expect(h.statuses).toEqual({});
  });
});
