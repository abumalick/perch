import type { WorkspaceStatus } from '@perch/contracts';

export interface StatusStorePort {
  get(workspaceId: string): WorkspaceStatus | undefined;
  // Epoch ms of the last actual status transition, or undefined if never set.
  getChangedAt(workspaceId: string): number | undefined;
  set(workspaceId: string, status: WorkspaceStatus): void;
  // Manual "pin to top of its status group" flag, orthogonal to status: it persists across
  // status changes until cleared. `getUrgent` defaults to false for an unknown id.
  getUrgent(workspaceId: string): boolean;
  setUrgent(workspaceId: string, urgent: boolean): void;
  // The last known Claude Code session id for this workspace, or undefined if no hook
  // event has carried one yet. Setting it never fires onChange — a session id is not an
  // attention-status event.
  getClaudeSessionId(workspaceId: string): string | undefined;
  setClaudeSessionId(workspaceId: string, sessionId: string): void;
  // Whether the session's last main-loop tool call was SendMessage (see applyHookEvent).
  // False for an unknown id; setting it never fires onChange.
  getMessagedLast(workspaceId: string): boolean;
  setMessagedLast(workspaceId: string, value: boolean): void;
  // Every id with an entry. Ids are reused once a workspace is gone, so a new one must not
  // take an id still listed here, and the entry of a workspace that stopped is forgotten.
  ids(): string[];
  // Drops the entry whole, never firing onChange.
  forget(workspaceId: string): void;
  onChange(listener:(workspaceId: string, status: WorkspaceStatus) => void): void;
}
