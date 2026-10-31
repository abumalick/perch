import { describe, it, expect } from 'vitest';
import type { WorkspaceStatus } from '@perch/contracts';
import { trackLiveWorkspaces, type TrackLiveWorkspacesDeps } from './track-live-workspaces';
import type { LiveSnapshot, LiveWorkspace } from '../ports/live-snapshot-port';
import type { ParkedWorkspace } from '../ports/parked-store-port';
import type { TmuxSessionInfo } from '../ports/tmux-port';
import type { WorkspaceLogEntry } from '../ports/workspace-log-port';

const session = (name: string, command = "claude --model 'opus[1m]'"): TmuxSessionInfo => ({
  name,
  startPath: '/home/u/workspace/foo',
  command,
  createdAt: 1000,
  title: '✳ Portal work',
});

const live = (id: string, extra: Partial<LiveWorkspace> = {}): LiveWorkspace => ({
  id,
  name: 'Portal work',
  projectPath: '/home/u/workspace/foo',
  command: "claude --model 'opus[1m]'",
  machineId: 'dev',
  createdAt: 1000,
  claudeSessionId: `sess-${id}`,
  ...extra,
});

function harness(opts: {
  serverId: string | null;
  sessions?: TmuxSessionInfo[];
  snapshot?: LiveSnapshot;
  parked?: ParkedWorkspace[];
  sessionIds?: Record<string, string>;
  statuses?: Record<string, WorkspaceStatus>;
}) {
  let snapshot = opts.snapshot;
  const parked = [...(opts.parked ?? [])];
  const statuses: Record<string, WorkspaceStatus> = { ...(opts.statuses ?? {}) };
  const logged: WorkspaceLogEntry[] = [];
  const deps: TrackLiveWorkspacesDeps = {
    tmux: {
      serverId: async () => opts.serverId,
      listSessions: async () => opts.sessions ?? [],
    },
    snapshot: {
      read: async () => snapshot,
      write: async (s) => {
        snapshot = s;
      },
    },
    parked: {
      list: async () => parked,
      add: async (p) => {
        parked.push(p);
      },
    },
    status: {
      get: (id) => statuses[id],
      getClaudeSessionId: (id) => opts.sessionIds?.[id],
      set: (id, s) => {
        statuses[id] = s;
      },
    },
    workspaceLog: {
      append: async (e) => {
        logged.push(e);
      },
    },
    clock: { now: () => 5000 },
    machineId: 'dev',
    sessionPrefix: 'perch-',
  };
  return { deps, parked, statuses, logged, snapshot: () => snapshot };
}

describe('trackLiveWorkspaces', () => {
  it('records the live workspaces and the server they run on', async () => {
    const h = harness({
      serverId: 'srv-1',
      sessions: [session('perch-a')],
      sessionIds: { 'perch-a': 'sess-perch-a' },
    });
    expect(await trackLiveWorkspaces(h.deps)).toEqual([]);
    expect(h.snapshot()).toEqual({ serverId: 'srv-1', workspaces: [live('perch-a')] });
  });

  it('records the parent link of a child workspace', async () => {
    const h = harness({
      serverId: 'srv-1',
      sessions: [{ ...session('perch-a'), parent: 'perch-p' }],
      sessionIds: { 'perch-a': 'sess-perch-a' },
    });
    await trackLiveWorkspaces(h.deps);
    expect(h.snapshot()?.workspaces).toEqual([live('perch-a', { parent: 'perch-p' })]);
  });

  it('keeps the parent link when a workspace lost with its server is parked', async () => {
    const h = harness({
      serverId: 'srv-2',
      snapshot: { serverId: 'srv-1', workspaces: [live('perch-a', { parent: 'perch-p' })] },
    });
    await trackLiveWorkspaces(h.deps);
    expect(h.parked).toEqual([{ ...live('perch-a', { parent: 'perch-p' }), parkedAt: 5000 }]);
  });

  it('keeps an idle Codex task title in the durable snapshot', async () => {
    const h = harness({
      serverId: 'srv-1',
      sessions: [{ ...session('perch-a', 'codex --no-daemon'), title: 'Portal work | foo' }],
    });
    await trackLiveWorkspaces(h.deps);
    expect(h.snapshot()?.workspaces[0]?.name).toBe('Portal work | foo');
  });

  it('parks nothing while the same server is running (an agent restart, a workspace exiting)', async () => {
    const h = harness({
      serverId: 'srv-1',
      sessions: [],
      snapshot: { serverId: 'srv-1', workspaces: [live('perch-a')] },
    });
    expect(await trackLiveWorkspaces(h.deps)).toEqual([]);
    expect(h.parked).toEqual([]);
    expect(h.logged).toEqual([]);
    expect(h.snapshot()).toEqual({ serverId: 'srv-1', workspaces: [] });
  });

  it('parks the workspaces lost with their tmux server and logs them as server-lost', async () => {
    const h = harness({
      serverId: 'srv-2',
      snapshot: { serverId: 'srv-1', workspaces: [live('perch-a')] },
      statuses: { 'perch-a': 'working' },
    });
    expect(await trackLiveWorkspaces(h.deps)).toEqual(['perch-a']);
    expect(h.parked).toEqual([{ ...live('perch-a'), parkedAt: 5000 }]);
    expect(h.statuses['perch-a']).toBe('parked');
    expect(h.logged).toEqual([
      {
        id: 'perch-a',
        name: 'Portal work',
        projectPath: '/home/u/workspace/foo',
        machineId: 'dev',
        createdAt: 1000,
        closedAt: 5000,
        reason: 'server-lost',
        lastStatus: 'working',
        claudeSessionId: 'sess-perch-a',
      },
    ]);
    expect(h.snapshot()).toEqual({ serverId: 'srv-2', workspaces: [] });
  });

  it('treats no running server as a lost one', async () => {
    const h = harness({ serverId: null, snapshot: { serverId: 'srv-1', workspaces: [live('perch-a')] } });
    expect(await trackLiveWorkspaces(h.deps)).toEqual(['perch-a']);
  });

  it('prefers the session id the status store holds now over the snapshot copy', async () => {
    const h = harness({
      serverId: 'srv-2',
      snapshot: { serverId: 'srv-1', workspaces: [live('perch-a', { claudeSessionId: 'old' })] },
      sessionIds: { 'perch-a': 'new' },
    });
    await trackLiveWorkspaces(h.deps);
    expect(h.parked[0]?.claudeSessionId).toBe('new');
  });

  it('only logs a lost workspace with no Claude session id, since it could not be resumed', async () => {
    const { claudeSessionId: _, ...noId } = live('perch-a');
    const h = harness({ serverId: 'srv-2', snapshot: { serverId: 'srv-1', workspaces: [noId] } });
    expect(await trackLiveWorkspaces(h.deps)).toEqual([]);
    expect(h.parked).toEqual([]);
    expect(h.logged.map((e) => e.reason)).toEqual(['server-lost']);
  });

  it('parks a session resurrected as a bare shell (no @perch_command) on a new server', async () => {
    // tmux-resurrect brings the name back but not the claude inside it; reconcileParked then
    // kills the shell, so the conversation comes back through the parked record instead.
    const h = harness({
      serverId: 'srv-2',
      sessions: [session('perch-a', '')],
      snapshot: { serverId: 'srv-1', workspaces: [live('perch-a')] },
    });
    expect(await trackLiveWorkspaces(h.deps)).toEqual(['perch-a']);
    expect(h.snapshot()?.workspaces).toEqual([]);
  });

  it('keeps a workspace whose session is still running with its command on a new server', async () => {
    const h = harness({
      serverId: 'srv-2',
      sessions: [session('perch-a')],
      snapshot: { serverId: 'srv-1', workspaces: [live('perch-a')] },
    });
    expect(await trackLiveWorkspaces(h.deps)).toEqual([]);
  });

  it('falls back to plain claude for a workspace whose command was never recorded', async () => {
    const h = harness({
      serverId: 'srv-2',
      snapshot: { serverId: 'srv-1', workspaces: [live('perch-a', { command: '' })] },
    });
    await trackLiveWorkspaces(h.deps);
    expect(h.parked[0]?.command).toBe('claude');
  });

  it('leaves an already parked workspace alone and out of the snapshot', async () => {
    const parkedRecord: ParkedWorkspace = { ...live('perch-a'), parkedAt: 1 };
    const h = harness({
      serverId: 'srv-2',
      sessions: [session('perch-b')],
      snapshot: { serverId: 'srv-1', workspaces: [live('perch-a')] },
      parked: [parkedRecord],
    });
    expect(await trackLiveWorkspaces(h.deps)).toEqual([]);
    expect(h.parked).toEqual([parkedRecord]);
    expect(h.logged).toEqual([]);
    expect(h.snapshot()?.workspaces.map((w) => w.id)).toEqual(['perch-b']);
  });

  it('parks nothing on a first run with no snapshot', async () => {
    const h = harness({ serverId: 'srv-1', sessions: [session('perch-a')] });
    expect(await trackLiveWorkspaces(h.deps)).toEqual([]);
  });

  it('ignores sessions without the Perch prefix', async () => {
    const h = harness({ serverId: 'srv-1', sessions: [session('main')] });
    h.deps.tmux.listSessions = async (prefix) => [session('main')].filter((s) => s.name.startsWith(prefix));
    await trackLiveWorkspaces(h.deps);
    expect(h.snapshot()?.workspaces).toEqual([]);
  });
});
