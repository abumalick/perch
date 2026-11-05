import type { TmuxPort } from '../ports/tmux-port';
import type { StatusStorePort } from '../ports/status-store-port';
import { trackLiveWorkspaces, type TrackLiveWorkspacesDeps } from './track-live-workspaces';
import { reconcileParked } from './reconcile-parked';

export interface StartupReconcileDeps extends Omit<TrackLiveWorkspacesDeps, 'tmux' | 'status'> {
  tmux: Pick<TmuxPort, 'listSessions' | 'serverId' | 'hasSession' | 'killSession' | 'retagLegacyOptions'>;
  status: Pick<StatusStorePort, 'get' | 'getClaudeSessionId' | 'set'> & { prune(liveIds: Iterable<string>): void };
  log: (line: string) => void;
}

// What the agent settles about its workspaces before serving, in this order:
// 1. Re-tag sessions an older agent marked `@perch_*` with `@tarfa_*`. First, so every step after
//    it sees them as Tarfa's own: a session missing its marker reads as a resurrected bare shell,
//    which the steps below park, kill or prune.
// 2. Park the workspaces lost with the tmux server (a reboot, a stray `pkill`) while their status
//    entries, and so their session ids, still exist. Best-effort: failing to recover must never
//    keep the agent from starting.
// 3. Kill any session tmux-continuum resurrected under a parked id, so the record stays the one
//    source of truth.
// 4. Prune status entries of sessions that no longer exist, keeping the parked ones'.
export async function reconcileAtStartup(deps: StartupReconcileDeps): Promise<void> {
  try {
    const retagged = (await deps.tmux.retagLegacyOptions?.()) ?? 0;
    deps.log(`tarfa agent: re-tagged ${retagged} @perch_ tmux option(s) as @tarfa_`);
  } catch (err) {
    deps.log(`tarfa agent: could not re-tag @perch_ tmux options: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const recovered = await trackLiveWorkspaces(deps);
    if (recovered.length > 0) deps.log(`tarfa agent: parked ${recovered.length} workspace(s) lost with the tmux server`);
  } catch (err) {
    deps.log(`tarfa agent: could not check for lost workspaces: ${err instanceof Error ? err.message : String(err)}`);
  }
  await reconcileParked(deps);
  const sessions = await deps.tmux.listSessions(deps.sessionPrefix);
  const parkedIds = (await deps.parked.list()).map((p) => p.id);
  deps.status.prune([...sessions.map((s) => s.name), ...parkedIds]);
}
