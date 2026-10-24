import { describe, it, expect } from 'vitest';
import { applyHookEvent } from './apply-hook-event';
import type { WorkspaceStatus } from '@perch/contracts';
import type { StatusStorePort } from '../ports/status-store-port';
import type { HookEventEntry } from '../ports/hook-event-log-port';

function fakeStore(initial: Record<string, WorkspaceStatus> = {}) {
  const sets: Array<[string, string]> = [];
  const sessionIds: Array<[string, string]> = [];
  const current = new Map(Object.entries(initial));
  const store: Pick<StatusStorePort, 'get' | 'set' | 'setClaudeSessionId'> = {
    get: (id) => current.get(id),
    set: (id, s) => {
      sets.push([id, s]);
      current.set(id, s);
    },
    setClaudeSessionId: (id, sessionId) => sessionIds.push([id, sessionId]),
  };
  return { store, sets, sessionIds };
}

const runningTask = { background_tasks: [{ id: 'b00000001', type: 'shell', status: 'running' }] };
const idlePrompt = { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' };

describe('applyHookEvent', () => {
  it('sets status for a known event and returns the change', () => {
    const f = fakeStore();
    const result = applyHookEvent(
      { store: f.store, deferred: new Set(), messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'Notification' },
    );
    expect(result).toEqual({ workspaceId: 'perch-aa', status: 'needs-feedback' });
    expect(f.sets).toEqual([['perch-aa', 'needs-feedback']]);
  });

  it('ignores an unknown event and writes nothing', () => {
    const f = fakeStore();
    const result = applyHookEvent(
      { store: f.store, deferred: new Set(), messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'Whatever' },
    );
    expect(result).toBeNull();
    expect(f.sets).toEqual([]);
  });

  it('writes nothing and marks the session deferred when a background task is running', () => {
    const f = fakeStore();
    const deferred = new Set<string>();
    const result = applyHookEvent(
      { store: f.store, deferred, messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'Stop', claude: runningTask },
    );
    expect(result).toBeNull();
    expect(f.sets).toEqual([]);
    expect(deferred.has('perch-aa')).toBe(true);
  });

  it('swallows the idle prompt of a deferred session', () => {
    const f = fakeStore();
    const deferred = new Set(['perch-aa']);
    const result = applyHookEvent(
      { store: f.store, deferred, messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'Notification', claude: idlePrompt },
    );
    expect(result).toBeNull();
    expect(f.sets).toEqual([]);
    expect(deferred.has('perch-aa')).toBe(true);
  });

  it('does not swallow the idle prompt of a different, undeferred session', () => {
    const f = fakeStore();
    const deferred = new Set(['perch-aa']);
    const result = applyHookEvent(
      { store: f.store, deferred, messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-bb', event: 'Notification', claude: idlePrompt },
    );
    expect(result).toEqual({ workspaceId: 'perch-bb', status: 'needs-feedback' });
    expect(deferred.has('perch-aa')).toBe(true);
  });

  it('clears the deferral once the background task is gone', () => {
    const f = fakeStore();
    const deferred = new Set(['perch-aa']);
    const result = applyHookEvent(
      { store: f.store, deferred, messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'Stop', claude: { background_tasks: [] } },
    );
    expect(result).toEqual({ workspaceId: 'perch-aa', status: 'needs-feedback' });
    expect(deferred.has('perch-aa')).toBe(false);
  });

  it("keeps the deferral through a background subagent's own tool calls", () => {
    const f = fakeStore();
    const deferred = new Set(['perch-aa']);
    applyHookEvent({ store: f.store, deferred, messagedLast: new Set(), questionPending: new Set<string>() }, { sessionName: 'perch-aa', event: 'PreToolUse' });
    expect(deferred.has('perch-aa')).toBe(true);
    expect(f.sets).toEqual([['perch-aa', 'working']]);
  });

  it('captures a valid session_id from the hook payload', () => {
    const f = fakeStore();
    applyHookEvent(
      { store: f.store, deferred: new Set(), messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'UserPromptSubmit', claude: { session_id: 'abc-123' } },
    );
    expect(f.sessionIds).toEqual([['perch-aa', 'abc-123']]);
  });

  it('does not capture a session id from a payload missing it', () => {
    const f = fakeStore();
    applyHookEvent(
      { store: f.store, deferred: new Set(), messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'UserPromptSubmit', claude: { cwd: '/x' } },
    );
    expect(f.sessionIds).toEqual([]);
  });

  it('does not capture a session id from a malformed payload (wrong type, or no claude object)', () => {
    const f = fakeStore();
    applyHookEvent(
      { store: f.store, deferred: new Set(), messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'UserPromptSubmit', claude: { session_id: 42 } },
    );
    applyHookEvent(
      { store: f.store, deferred: new Set(), messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'UserPromptSubmit' },
    );
    expect(f.sessionIds).toEqual([]);
  });

  it('keeps a session that ended its turn after SendMessage at working, through the idle prompt', () => {
    const f = fakeStore();
    const deps = { store: f.store, deferred: new Set<string>(), messagedLast: new Set<string>(), questionPending: new Set<string>() };
    applyHookEvent(deps, { sessionName: 'perch-aa', event: 'PostToolUse', claude: { tool_name: 'SendMessage' } });
    expect(applyHookEvent(deps, { sessionName: 'perch-aa', event: 'Stop', claude: {} })).toBeNull();
    expect(applyHookEvent(deps, { sessionName: 'perch-aa', event: 'Notification', claude: idlePrompt })).toBeNull();
    expect(f.sets).toEqual([['perch-aa', 'working']]);
  });

  it('a reply then a normal turn end needs feedback again', () => {
    const f = fakeStore();
    const deps = { store: f.store, deferred: new Set<string>(), messagedLast: new Set<string>(), questionPending: new Set<string>() };
    applyHookEvent(deps, { sessionName: 'perch-aa', event: 'PostToolUse', claude: { tool_name: 'SendMessage' } });
    applyHookEvent(deps, { sessionName: 'perch-aa', event: 'Stop', claude: {} });
    applyHookEvent(deps, { sessionName: 'perch-aa', event: 'UserPromptSubmit' });
    expect(deps.messagedLast.has('perch-aa')).toBe(false);
    expect(applyHookEvent(deps, { sessionName: 'perch-aa', event: 'Stop', claude: {} })).toEqual({
      workspaceId: 'perch-aa',
      status: 'needs-feedback',
    });
  });

  // Codex sends a `session_id` too, but parking resumes with `claude --resume`, which a Codex
  // workspace cannot take: recording it would let a Codex workspace be parked and then reopened
  // without its conversation.
  it('does not capture a session id from a Codex hook', () => {
    const f = fakeStore();
    applyHookEvent(
      { store: f.store, deferred: new Set(), messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'UserPromptSubmit', agent: 'codex', claude: { session_id: 'codex-1' } },
    );
    expect(f.sessionIds).toEqual([]);
    expect(f.sets).toEqual([['perch-aa', 'working']]);
  });

  it('a resumed session ends a working the previous process left behind', () => {
    const f = fakeStore({ 'perch-aa': 'working' });
    const deps = { store: f.store, deferred: new Set(['perch-aa']), messagedLast: new Set<string>(), questionPending: new Set<string>() };
    applyHookEvent(deps, { sessionName: 'perch-aa', event: 'SessionStart', claude: { source: 'resume' } });
    expect(f.sets).toEqual([['perch-aa', 'needs-feedback']]);
    expect(deps.deferred.has('perch-aa')).toBe(false);
  });

  it('an unparked session keeps the idle its unpark set', () => {
    const f = fakeStore({ 'perch-aa': 'idle' });
    applyHookEvent(
      { store: f.store, deferred: new Set(), messagedLast: new Set(), questionPending: new Set<string>() },
      { sessionName: 'perch-aa', event: 'SessionStart', claude: { source: 'resume' } },
    );
    expect(f.sets).toEqual([]);
  });

  describe('hook-event log', () => {
    function logged(initial: Record<string, WorkspaceStatus> = {}) {
      const entries: HookEventEntry[] = [];
      const f = fakeStore(initial);
      const deps = {
        store: f.store,
        deferred: new Set<string>(),
        messagedLast: new Set<string>(),
        questionPending: new Set<string>(),
        log: { append: async (e: HookEventEntry) => void entries.push(e) },
      };
      return { entries, deps };
    }

    it('records the event, the rule that decided, and the status and marks around it', () => {
      const { entries, deps } = logged({ 'perch-aa': 'working' });
      applyHookEvent(deps, {
        sessionName: 'perch-aa',
        event: 'Stop',
        claude: { session_id: 'sid-1', ...runningTask, last_assistant_message: 'private' },
      });
      expect(entries).toEqual([
        {
          workspace: 'perch-aa',
          event: 'Stop',
          sessionId: 'sid-1',
          backgroundTasks: runningTask.background_tasks,
          reason: 'stop-background',
          before: { status: 'working', deferred: false, messagedLast: false, questionPending: false },
          after: { status: 'working', deferred: true, messagedLast: false, questionPending: false },
        },
      ]);
    });

    it('keeps the fields that place an event and never the conversation', () => {
      const { entries, deps } = logged();
      applyHookEvent(deps, {
        sessionName: 'perch-aa',
        event: 'PreToolUse',
        agent: 'codex',
        claude: { tool_name: 'Bash', tool_input: { command: 'cat secrets' }, agent_id: 'a1', prompt: 'hi' },
      });
      applyHookEvent(deps, { sessionName: 'perch-aa', event: 'Notification', claude: idlePrompt });
      applyHookEvent(deps, { sessionName: 'perch-aa', event: 'SessionStart', claude: { source: 'compact' } });
      applyHookEvent(deps, {
        sessionName: 'perch-aa',
        event: 'StopFailure',
        claude: { error: 'rate_limit', last_assistant_message: 'private' },
      });
      expect(entries.map(({ before: _b, after: _a, ...rest }) => rest)).toEqual([
        { workspace: 'perch-aa', event: 'PreToolUse', agent: 'codex', tool: 'Bash', subagent: true, reason: 'subagent-tool' },
        { workspace: 'perch-aa', event: 'Notification', notificationType: 'idle_prompt', reason: 'notification' },
        { workspace: 'perch-aa', event: 'SessionStart', source: 'compact', reason: 'compact' },
        { workspace: 'perch-aa', event: 'StopFailure', error: 'rate_limit', reason: 'stop-failure' },
      ]);
    });

    it('records a StopFailure error that is an object', () => {
      const { entries, deps } = logged();
      applyHookEvent(deps, { sessionName: 'perch-aa', event: 'StopFailure', claude: { error: { type: 'overloaded' } } });
      expect(entries[0]!.error).toBe('{"type":"overloaded"}');
    });

    it('trims long background task fields and caps their number', () => {
      const { entries, deps } = logged();
      const tasks = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, type: 'shell', status: 'running', command: 'x'.repeat(500) }));
      applyHookEvent(deps, { sessionName: 'perch-aa', event: 'Stop', claude: { background_tasks: tasks } });
      const logged0 = entries[0]!.backgroundTasks as Array<{ command: string }>;
      expect(logged0).toHaveLength(20);
      expect(logged0[0]!.command.length).toBeLessThanOrEqual(201);
    });

    it('a failing log write neither throws nor changes the decision', () => {
      const f = fakeStore();
      const result = applyHookEvent(
        {
          store: f.store,
          deferred: new Set(),
          messagedLast: new Set(),
          questionPending: new Set<string>(),
          log: { append: () => Promise.reject(new Error('disk full')) },
        },
        { sessionName: 'perch-aa', event: 'Stop' },
      );
      expect(result).toEqual({ workspaceId: 'perch-aa', status: 'needs-feedback' });
    });
  });

  it('holds a Codex question at needs-feedback until it is answered', () => {
    const f = fakeStore();
    const deps = { store: f.store, deferred: new Set<string>(), messagedLast: new Set<string>(), questionPending: new Set<string>() };
    const ask = { tool_name: 'request_user_input_async' };
    const sleep = { tool_name: 'clocksleep' };
    const hook = (event: string, claude?: unknown) =>
      applyHookEvent(deps, { sessionName: 'perch-aa', event, claude, agent: 'codex' });
    hook('PreToolUse', ask);
    hook('PostToolUse', { ...ask, tool_response: '{"accepted":true}' });
    hook('PreToolUse', sleep);
    hook('PostToolUse', sleep);
    expect(f.sets).toEqual([['perch-aa', 'needs-feedback']]);
    hook('UserPromptSubmit');
    expect(deps.questionPending.has('perch-aa')).toBe(false);
    hook('PreToolUse', { tool_name: 'Bash' });
    expect(f.sets).toEqual([
      ['perch-aa', 'needs-feedback'],
      ['perch-aa', 'working'],
      ['perch-aa', 'working'],
    ]);
  });
});
