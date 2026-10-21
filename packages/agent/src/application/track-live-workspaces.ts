import type { TmuxPort } from '../ports/tmux-port';
import type { LiveSnapshotPort, LiveWorkspace } from '../ports/live-snapshot-port';
import type { ParkedStorePort } from '../ports/parked-store-port';
import type { StatusStorePort } from '../ports/status-store-port';
import type { WorkspaceLogPort } from '../ports/workspace-log-port';
import type { Clock } from '../ports/clock';
import { deriveWorkspaceName } from './derive-workspace-name';

export interface TrackLiveWorkspacesDeps {
  tmux: Pick<TmuxPort, 'listSessions' | 'serverId'>;
  snapshot: Pick<LiveSnapshotPort, 'read' | 'write'>;
  parked: Pick<ParkedStorePort, 'list' | 'add'>;
  status: Pick<StatusStorePort, 'get' | 'getClaudeSessionId' | 'set'>;
  workspaceLog: WorkspaceLogPort;
  clock: Clock;
  machineId: string;
  sessionPrefix: string;
}

// Keeps a durable snapshot of the live workspaces, and parks the ones lost with their tmux
// server so they can be reopened with their conversation.
//
// Every workspace dies with the tmux server (a `pkill -f` from inside a workspace, a reboot), and
// usually the agent with it, so nothing saw them go. The snapshot's server identity is what tells
// that apart from an ordinary exit: one workspace ending leaves the same server running, so only
// a changed (or absent) server makes the missing ones lost. A session on the new server without
// its `@perch_command` is lost too: tmux-resurrect brings the name back as a bare shell, which
// `reconcileParked` then kills in favour of the record.
//
// Returns the ids it parked. Runs at startup before `reconcileParked` and `status.prune`, and on
// every poll tick.
export async function trackLiveWorkspaces(deps: TrackLiveWorkspacesDeps): Promise<string[]> {
  if (!deps.tmux.serverId) return [];
  const serverId = await deps.tmux.serverId();
  const sessions = await deps.tmux.listSessions(deps.sessionPrefix);
  const parkedIds = new Set((await deps.parked.list()).map((p) => p.id));
  const previous = await deps.snapshot.read();
  const parkedNow: string[] = [];
  if (previous && previous.serverId !== serverId) {
    const survivors = new Set(sessions.filter((s) => s.command.trim().length > 0).map((s) => s.name));
    for (const entry of previous.workspaces) {
      if (survivors.has(entry.id) || parkedIds.has(entry.id)) continue;
      const claudeSessionId = deps.status.getClaudeSessionId(entry.id) ?? entry.claudeSessionId;
      const now = deps.clock.now();
      try {
        await deps.workspaceLog.append({
          id: entry.id,
          name: entry.name,
          projectPath: entry.projectPath,
          machineId: entry.machineId,
          createdAt: entry.createdAt,
          closedAt: now,
          reason: 'server-lost',
          lastStatus: deps.status.get(entry.id),
          claudeSessionId,
        });
      } catch {
        // Best-effort, like every workspace-log write.
      }
      if (!claudeSessionId) continue;
      await deps.parked.add({
        ...entry,
        command: entry.command.trim().length > 0 ? entry.command : 'claude',
        claudeSessionId,
        parkedAt: now,
      });
      parkedIds.add(entry.id);
      parkedNow.push(entry.id);
      deps.status.set(entry.id, 'parked');
    }
  }
  await deps.snapshot.write({
    serverId,
    workspaces: sessions
      .filter((s) => !parkedIds.has(s.name))
      .map((s): LiveWorkspace => {
        const claudeSessionId = deps.status.getClaudeSessionId(s.name);
        return {
          id: s.name,
          name: deriveWorkspaceName(s.title, s.startPath, s.command),
          projectPath: s.startPath,
          command: s.command,
          machineId: deps.machineId,
          createdAt: s.createdAt,
          ...(claudeSessionId ? { claudeSessionId } : {}),
        };
      }),
  });
  return parkedNow;
}
