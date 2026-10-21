import type { WorkspaceStatus } from '@perch/contracts';
import type { StatusStorePort } from '../ports/status-store-port';
import { attentionDecision } from './attention-decision';

// Claude Code sends `session_id` on every hook event's payload. Read it defensively (the
// payload is `unknown`) — a missing or malformed field means "leave the last known value
// alone," never "clear it."
function extractSessionId(claude: unknown): string | undefined {
  if (typeof claude !== 'object' || claude === null) return undefined;
  const id = (claude as { session_id?: unknown }).session_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

// `deferred` holds the sessions parked on background work or on a peer session's reply, so the
// idle notification that follows their Stop can be told apart from a genuine one.
// `messagedLast` holds the sessions whose last main-loop tool call was SendMessage. Both are
// deliberately in-memory: losing them on restart costs at most one extra "Needs you", never a
// missed one. `questionPending` holds the Codex sessions with a question waiting on the user.
export function applyHookEvent(
  deps: {
    store: Pick<StatusStorePort, 'set' | 'setClaudeSessionId'>;
    deferred: Set<string>;
    messagedLast: Set<string>;
    questionPending: Set<string>;
  },
  // `agent` names the CLI that ran the hook; absent means Claude Code. `claude` is that CLI's payload.
  input: { sessionName: string; event: string; claude?: unknown; agent?: string },
): { workspaceId: string; status: WorkspaceStatus } | null {
  // Parking resumes with `claude --resume`, so only a Claude Code session id makes a workspace
  // restorable; a Codex one would let it be parked and reopened without its conversation.
  const sessionId = input.agent === 'codex' ? undefined : extractSessionId(input.claude);
  if (sessionId) {
    deps.store.setClaudeSessionId(input.sessionName, sessionId);
  }

  const decision = attentionDecision({
    event: input.event,
    claude: input.claude,
    wasDeferred: deps.deferred.has(input.sessionName),
    messagedLast: deps.messagedLast.has(input.sessionName),
    questionPending: deps.questionPending.has(input.sessionName),
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

  if (!decision.status) {
    return null;
  }
  deps.store.set(input.sessionName, decision.status);
  return { workspaceId: input.sessionName, status: decision.status };
}
