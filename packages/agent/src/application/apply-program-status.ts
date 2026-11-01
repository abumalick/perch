import type { WorkspaceStatus } from '@perch/contracts';
import type { StatusStorePort } from '../ports/status-store-port';
import type { HookEventLogPort, HookMarks } from '../ports/hook-event-log-port';
import type { MarkSet } from './apply-hook-event';
import { programStatusDecision } from './program-status-decision';

export interface ProgramStatusPane {
  name: string;
  // The pane's OSC 7501 root record and when tmux saw it change; absent with a stock tmux.
  program?: { state: string; changedAt: number };
}

export interface ApplyProgramStatusDeps {
  store: Pick<StatusStorePort, 'get' | 'set'>;
  deferred: Set<string>;
  messagedLast: MarkSet;
  questionPending: Set<string>;
  // The last record seen per workspace (state and change time), so only a change is applied.
  seen: Map<string, string>;
  log?: HookEventLogPort;
}

function marks(deps: ApplyProgramStatusDeps, status: WorkspaceStatus | undefined, id: string) {
  return {
    ...(status ? { status } : {}),
    deferred: deps.deferred.has(id),
    messagedLast: deps.messagedLast.has(id),
    questionPending: deps.questionPending.has(id),
  } satisfies { status?: WorkspaceStatus } & HookMarks;
}

// Applies each pane's program status when it changes. The first sighting only records it: the
// record has no heartbeat, so after an agent restart it may be hours old. Returns the ids whose
// status it set.
export function applyProgramStatus(deps: ApplyProgramStatusDeps, panes: ProgramStatusPane[]): string[] {
  const changed: string[] = [];
  const present = new Set<string>();
  for (const { name, program } of panes) {
    if (!program) continue;
    present.add(name);
    const key = `${program.state}@${program.changedAt}`;
    const previous = deps.seen.get(name);
    deps.seen.set(name, key);
    if (previous === undefined || previous === key) continue;

    const currentStatus = deps.store.get(name);
    const before = marks(deps, currentStatus, name);
    const decision = programStatusDecision({
      state: program.state,
      currentStatus,
      deferred: before.deferred,
      messagedLast: before.messagedLast,
    });
    if (decision.deferral === 'clear') deps.deferred.delete(name);
    if (decision.status && decision.status !== currentStatus) {
      deps.store.set(name, decision.status);
      changed.push(name);
    }
    deps.log
      ?.append({
        workspace: name,
        event: 'OSC7501',
        programState: program.state,
        reason: decision.reason,
        before,
        after: marks(deps, decision.status ?? currentStatus, name),
      })
      .catch(() => undefined);
  }
  for (const name of deps.seen.keys()) {
    if (!present.has(name)) deps.seen.delete(name);
  }
  return changed;
}
