import type { WorkspaceStatus } from '@perch/contracts';
import type { StatusStorePort } from '../ports/status-store-port';
import type { HookEventEntry, HookEventLogPort, HookMarks } from '../ports/hook-event-log-port';
import { attentionDecision, type AttentionDecision } from './attention-decision';

function field(claude: unknown, key: string): string | undefined {
  if (typeof claude !== 'object' || claude === null) return undefined;
  const value = (claude as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Claude Code sends `session_id` on every hook event's payload. Read it defensively (the
// payload is `unknown`) — a missing or malformed field means "leave the last known value
// alone," never "clear it."
function extractSessionId(claude: unknown): string | undefined {
  return field(claude, 'session_id');
}

const MAX_LOGGED_TASKS = 20;
const MAX_LOGGED_CHARS = 200;

function trim(value: string): string {
  return value.length > MAX_LOGGED_CHARS ? `${value.slice(0, MAX_LOGGED_CHARS)}…` : value;
}

// StopFailure's `error` is a string or an object; either way it is what explains the event.
function errorField(claude: unknown): string | undefined {
  if (typeof claude !== 'object' || claude === null) return undefined;
  const value = (claude as { error?: unknown }).error;
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function loggedTasks(claude: unknown): unknown[] | undefined {
  if (typeof claude !== 'object' || claude === null) return undefined;
  const tasks = (claude as { background_tasks?: unknown }).background_tasks;
  if (!Array.isArray(tasks)) return undefined;
  return tasks.slice(0, MAX_LOGGED_TASKS).map((task) =>
    typeof task === 'object' && task !== null
      ? Object.fromEntries(Object.entries(task).map(([k, v]) => [k, typeof v === 'string' ? trim(v) : v]))
      : task,
  );
}

// Only the fields that place an event: never the prompt, a tool's input or output, or the
// assistant's last message.
function logEntry(
  input: { sessionName: string; event: string; claude?: unknown; agent?: string },
  decision: AttentionDecision,
  before: HookEntryState,
  after: HookEntryState,
): HookEventEntry {
  const { claude } = input;
  const error = errorField(claude);
  const entry: HookEventEntry = {
    workspace: input.sessionName,
    event: input.event,
    agent: input.agent,
    sessionId: field(claude, 'session_id'),
    tool: field(claude, 'tool_name'),
    notificationType: field(claude, 'notification_type'),
    source: field(claude, 'source'),
    subagent: field(claude, 'agent_id') ? true : undefined,
    backgroundTasks: loggedTasks(claude),
    error: error && trim(error),
    reason: decision.reason,
    before,
    after,
  };
  return Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined)) as HookEventEntry;
}

type HookEntryState = { status?: WorkspaceStatus } & HookMarks;

interface Marks {
  deferred: Set<string>;
  messagedLast: Set<string>;
  questionPending: Set<string>;
}

function state(marks: Marks, status: WorkspaceStatus | undefined, id: string): HookEntryState {
  return {
    ...(status ? { status } : {}),
    deferred: marks.deferred.has(id),
    messagedLast: marks.messagedLast.has(id),
    questionPending: marks.questionPending.has(id),
  };
}

// `deferred` holds the sessions parked on background work or on a peer session's reply, so the
// idle notification that follows their Stop can be told apart from a genuine one.
// `messagedLast` holds the sessions whose last main-loop tool call was SendMessage. Both are
// deliberately in-memory: losing them on restart costs at most one extra "Needs you", never a
// missed one. `questionPending` holds the Codex sessions with a question waiting on the user.
// `log` records every event and its decision; a failed write never affects the decision.
export function applyHookEvent(
  deps: {
    store: Pick<StatusStorePort, 'get' | 'set' | 'setClaudeSessionId'>;
    log?: HookEventLogPort;
  } & Marks,
  // `agent` names the CLI that ran the hook; absent means Claude Code. `claude` is that CLI's payload.
  input: { sessionName: string; event: string; claude?: unknown; agent?: string },
): { workspaceId: string; status: WorkspaceStatus } | null {
  // Parking resumes with `claude --resume`, so only a Claude Code session id makes a workspace
  // restorable; a Codex one would let it be parked and reopened without its conversation.
  const sessionId = input.agent === 'codex' ? undefined : extractSessionId(input.claude);
  if (sessionId) {
    deps.store.setClaudeSessionId(input.sessionName, sessionId);
  }

  const currentStatus = deps.store.get(input.sessionName);
  const before = state(deps, currentStatus, input.sessionName);
  const decision = attentionDecision({
    event: input.event,
    claude: input.claude,
    wasDeferred: before.deferred,
    messagedLast: before.messagedLast,
    questionPending: before.questionPending,
    currentStatus,
  });

  if (decision.deferral === 'set') {
    deps.deferred.add(input.sessionName);
  } else if (decision.deferral === 'clear') {
    deps.deferred.delete(input.sessionName);
  }
  if (decision.messagedLast === 'set') {
    deps.messagedLast.add(input.sessionName);
  } else if (decision.messagedLast === 'clear') {
    deps.messagedLast.delete(input.sessionName);
  }

  if (decision.question === 'set') {
    deps.questionPending.add(input.sessionName);
  } else if (decision.question === 'clear') {
    deps.questionPending.delete(input.sessionName);
  }

  if (decision.status) {
    deps.store.set(input.sessionName, decision.status);
  }
  if (deps.log) {
    const after = state(deps, decision.status ?? currentStatus, input.sessionName);
    deps.log.append(logEntry(input, decision, before, after)).catch(() => undefined);
  }
  return decision.status ? { workspaceId: input.sessionName, status: decision.status } : null;
}
