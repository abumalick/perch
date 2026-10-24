import type { WorkspaceStatus } from '@perch/contracts';

// What to do with the session's deferral mark: `set` it, `clear` it, or leave it alone.
type Deferral = 'set' | 'clear' | 'keep';

// Which rule decided, for the hook-event log only: nothing acts on it.
export type AttentionReason =
  | 'stop'
  | 'stop-background'
  | 'stop-messaged'
  | 'stop-failure'
  | 'notification'
  | 'idle-suppressed'
  | 'prompt'
  | 'permission'
  | 'subagent-tool'
  | 'question-pending'
  | 'question'
  | 'blocking-tool'
  | 'tool'
  | 'session-start'
  | 'compact'
  | 'unknown-event';

export interface AttentionDecision {
  reason: AttentionReason;
  // null = leave the current status untouched.
  status: WorkspaceStatus | null;
  deferral: Deferral;
  // Whether the turn's last main-loop tool call was SendMessage; omitted = leave it alone.
  messagedLast?: 'set' | 'clear';
  // Whether a Codex question is waiting on the user; omitted = leave it alone.
  question?: 'set' | 'clear';
}

// The Stop hook payload carries `background_tasks`: every running or pending task the session
// holds. It is undocumented, so read it defensively — anything unexpected means "no running
// task", which lands on `needs-feedback`, i.e. the behaviour Perch had before this feature.
// Only work the session is waiting on counts. The Monitor tool and `until` loops run as `shell`;
// an MCP monitor or task names its `server`. A watched artifact is a `monitor` with no server
// that lasts as long as the session, and Claude's housekeeping (`dream`, `auto-mode scan`,
// `memory import`) is not the session's work, so neither counts, and nor does an unknown kind:
// a wrong "Needs you" is a glance, a wrong `working` hides a waiting session indefinitely.
const WORK_TYPES = new Set(['shell', 'subagent', 'workflow', 'teammate', 'cloud session']);

function isWaitedOnTask(task: unknown): boolean {
  if (typeof task !== 'object' || task === null) return false;
  const { status, type, server } = task as { status?: unknown; type?: unknown; server?: unknown };
  if (status !== 'running' && status !== 'pending') return false;
  return (typeof type === 'string' && WORK_TYPES.has(type)) || typeof server === 'string';
}

function hasRunningBackgroundTask(claude: unknown): boolean {
  if (typeof claude !== 'object' || claude === null) return false;
  const tasks = (claude as { background_tasks?: unknown }).background_tasks;
  return Array.isArray(tasks) && tasks.some(isWaitedOnTask);
}

function isIdlePrompt(claude: unknown): boolean {
  if (typeof claude !== 'object' || claude === null) return false;
  return (claude as { notification_type?: unknown }).notification_type === 'idle_prompt';
}

// `agent_id`/`agent_type` are set on a tool call's payload only when the call belongs to a
// subagent. Subagent tool calls fire in the *parent* session, so treating them as the parent
// working overwrites whatever the parent is actually doing — including a "Needs you" raised
// while it sits blocked on a question.
function isSubagentToolCall(claude: unknown): boolean {
  if (typeof claude !== 'object' || claude === null) return false;
  return typeof (claude as { agent_id?: unknown }).agent_id === 'string';
}

// Claude blocks indefinitely on these waiting for the user to pick an option, and (unlike a
// permission prompt) they carry no reliable notification of their own on every version.
const BLOCKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

function isBlockingTool(claude: unknown): boolean {
  if (typeof claude !== 'object' || claude === null) return false;
  const name = (claude as { tool_name?: unknown }).tool_name;
  return typeof name === 'string' && BLOCKING_TOOLS.has(name);
}

// Codex's question tools. The async one's PostToolUse fires as soon as the question is shown (not
// when it is answered) and the model then sleeps, so its tool events cannot say "working" again;
// the answer arrives as a UserPromptSubmit.
function isCodexQuestion(claude: unknown): boolean {
  if (typeof claude !== 'object' || claude === null) return false;
  const name = (claude as { tool_name?: unknown }).tool_name;
  return typeof name === 'string' && name.startsWith('request_user_input');
}

// A turn that ends right after messaging another Claude session is waiting on that session's
// reply (a child on its orchestrator, an orchestrator on its children), not on the user.
function isPeerMessage(claude: unknown): boolean {
  if (typeof claude !== 'object' || claude === null) return false;
  return (claude as { tool_name?: unknown }).tool_name === 'SendMessage';
}

// SessionStart's `source`: `startup`, `resume`, `clear` and `fork` start a fresh `claude`
// process or conversation; `compact` fires in the middle of a turn, on auto-compaction.
const NEW_SESSION_SOURCES = new Set(['startup', 'resume', 'clear', 'fork']);

function startsNewSession(claude: unknown): boolean {
  if (typeof claude !== 'object' || claude === null) return false;
  const source = (claude as { source?: unknown }).source;
  return typeof source === 'string' && NEW_SESSION_SOURCES.has(source);
}

const DROP_MARKS = { deferral: 'clear', messagedLast: 'clear', question: 'clear' } as const;

export function attentionDecision(input: {
  event: string;
  claude?: unknown;
  wasDeferred: boolean;
  messagedLast?: boolean;
  questionPending?: boolean;
  currentStatus?: WorkspaceStatus;
}): AttentionDecision {
  const endsQuestion = input.questionPending ? ({ question: 'clear' } as const) : {};
  switch (input.event) {
    case 'Stop':
      if (hasRunningBackgroundTask(input.claude)) {
        return { reason: 'stop-background', status: null, deferral: 'set', ...endsQuestion };
      }
      return input.messagedLast
        ? { reason: 'stop-messaged', status: null, deferral: 'set', ...endsQuestion }
        : { reason: 'stop', status: 'needs-feedback', deferral: 'clear', ...endsQuestion };
    // Fired instead of Stop when an API error ends the turn.
    case 'StopFailure':
      return { reason: 'stop-failure', status: 'needs-feedback', ...DROP_MARKS };
    case 'SessionStart':
      if (!startsNewSession(input.claude)) return { reason: 'compact', status: null, deferral: 'keep' };
      // A `working` left behind by the previous process can never be ended by it. Any other
      // status was set on purpose (an unpark sets `idle` just before its resume fires this).
      return {
        reason: 'session-start',
        status: input.currentStatus === 'working' ? 'needs-feedback' : null,
        ...DROP_MARKS,
      };
    case 'Notification':
      // Claude Code emits an idle_prompt 60s after every Stop — even while a background task
      // is still running. Letting it through would undo the deferral a minute later and
      // defeat the feature. Every other notification (a permission prompt) still gets through.
      return isIdlePrompt(input.claude) && input.wasDeferred
        ? { reason: 'idle-suppressed', status: null, deferral: 'keep' }
        : { reason: 'notification', status: 'needs-feedback', deferral: 'clear' };
    case 'UserPromptSubmit':
      return { reason: 'prompt', status: 'working', deferral: 'clear', messagedLast: 'clear', ...endsQuestion };
    // Codex asks before showing an approval prompt. A subagent's request still asks the user.
    // With an automatic reviewer it fires too, and PostToolUse puts the status back a moment later.
    case 'PermissionRequest':
      return { reason: 'permission', status: 'needs-feedback', deferral: 'keep' };
    // A background subagent's own tool calls fire these in the parent session after its Stop,
    // so they must not clear the deferral — and must not speak for the parent's status at all.
    case 'PreToolUse':
    case 'PostToolUse':
      if (isSubagentToolCall(input.claude)) return { reason: 'subagent-tool', status: null, deferral: 'keep' };
      if (input.questionPending) return { reason: 'question-pending', status: null, deferral: 'keep' };
      if (input.event === 'PreToolUse' && isCodexQuestion(input.claude)) {
        return { reason: 'question', status: 'needs-feedback', deferral: 'keep', question: 'set' };
      }
      if (input.event === 'PreToolUse' && isBlockingTool(input.claude)) {
        return { reason: 'blocking-tool', status: 'needs-feedback', deferral: 'clear' };
      }
      if (input.event === 'PostToolUse') {
        return {
          reason: 'tool',
          status: 'working',
          deferral: 'keep',
          messagedLast: isPeerMessage(input.claude) ? 'set' : 'clear',
        };
      }
      return { reason: 'tool', status: 'working', deferral: 'keep' };
    default:
      return { reason: 'unknown-event', status: null, deferral: 'keep' };
  }
}
