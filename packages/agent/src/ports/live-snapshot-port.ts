import type { ParkedWorkspace } from './parked-store-port';

// What reviving a workspace needs, kept for every live one so a workspace lost with its tmux
// server can be turned into a parked record. The same shape as a parked record on purpose:
// recovering one is moving it from this file to that one.
export type LiveWorkspace = Omit<ParkedWorkspace, 'parkedAt'>;

export interface LiveSnapshot {
  // Identifies the tmux server the workspaces were seen on (null: no server was running).
  // A different value next time means the server died, so whatever it held is lost.
  serverId: string | null;
  workspaces: LiveWorkspace[];
}

export interface LiveSnapshotPort {
  read(): Promise<LiveSnapshot | undefined>;
  write(snapshot: LiveSnapshot): Promise<void>;
  remove(id: string): Promise<void>;
}
