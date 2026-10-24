import type { WorkspaceStatus } from '@perch/contracts';

export interface HookMarks {
  deferred: boolean;
  messagedLast: boolean;
  questionPending: boolean;
}

// One hook event as the agent received and decided it: enough to tell, for any workspace, which
// event left its status where it is and why.
export interface HookEventEntry {
  workspace: string;
  event: string;
  agent?: string;
  sessionId?: string;
  tool?: string;
  notificationType?: string;
  source?: string;
  subagent?: true;
  // Stop and StopFailure only, trimmed: what the deferral rule read, and the API error.
  backgroundTasks?: unknown[];
  error?: string;
  // The rule that decided (`AttentionReason`).
  reason: string;
  before: { status?: WorkspaceStatus } & HookMarks;
  after: { status?: WorkspaceStatus } & HookMarks;
}

export interface HookEventLogPort {
  append(entry: HookEventEntry): Promise<void>;
}
