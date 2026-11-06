import type { TmuxPort } from '../ports/tmux-port';
import type { ParkedStorePort } from '../ports/parked-store-port';

export interface ReconcileParkedDeps {
  parked: Pick<ParkedStorePort, 'list'>;
  tmux: Pick<TmuxPort, 'hasSession' | 'killSession'>;
}

// Resolves the one collision a parked record can have with a live tmux session, at startup.
//
// A new workspace never takes a parked id, so normal use cannot collide with a record. The
// only cause is tmux-continuum, which restores session names (but not the claude process
// inside them) when the tmux server starts — resurrecting a parked id as an empty shell. The
// record wins: letting the shell win would discard the claudeSessionId of exactly the
// long-parked workspaces most likely to survive to a reboot, which is the case parking exists
// for. Killing the orphan leaves one source of truth. Each id is looked up by name: the shell
// carries no `@tarfa_command`, so a listing of Tarfa's sessions would miss a short id.
//
// Done here rather than inside listWorkspaces so that listing stays free of side effects.
export async function reconcileParked(deps: ReconcileParkedDeps): Promise<string[]> {
  const orphans: string[] = [];
  for (const { id } of await deps.parked.list()) {
    if (await deps.tmux.hasSession(id)) {
      await deps.tmux.killSession(id);
      orphans.push(id);
    }
  }
  return orphans;
}
