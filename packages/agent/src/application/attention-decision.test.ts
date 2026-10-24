import { describe, it, expect } from 'vitest';
import { attentionDecision as decide } from './attention-decision';

// The cases below pin what the decision does; `reason` (only for the hook-event log) has its own.
function attentionDecision(input: Parameters<typeof decide>[0]) {
  const { reason: _reason, ...rest } = decide(input);
  return rest;
}

// Payloads shaped like a real `claude` 2.1.210 run's; ids are placeholders.
const runningShell = {
  background_tasks: [
    {
      id: 'b00000001',
      type: 'shell',
      status: 'running',
      description: 'Sleep for 300 seconds',
      command: 'sleep 300',
    },
  ],
};
const runningSubagent = {
  background_tasks: [
    {
      id: 'a0000000000000001',
      type: 'subagent',
      status: 'running',
      description: 'Run sleep 240',
      agent_type: 'general-purpose',
    },
  ],
};
const idlePrompt = {
  notification_type: 'idle_prompt',
  message: 'Claude is waiting for your input',
};
// A subagent's tool call, shaped like a real `claude` 2.1.215 payload. `agent_id` and
// `agent_type` are present only when the call belongs to a subagent, never on the main loop's own.
const subagentToolCall = {
  tool_name: 'WebFetch',
  agent_id: 'a0000000000000002',
  agent_type: 'claude-code-guide',
  session_id: '00000000-0000-4000-8000-000000000001',
};
// A main-loop SendMessage, shaped like a real `claude` 2.1.288 payload.
const ownMessage = { tool_name: 'SendMessage', session_id: '00000000-0000-4000-8000-000000000001' };

describe('attentionDecision', () => {
  describe('Stop', () => {
    it('defers while a backgrounded shell is still running', () => {
      expect(attentionDecision({ event: 'Stop', claude: runningShell, wasDeferred: false })).toEqual({
        status: null,
        deferral: 'set',
      });
    });

    it('defers while a background subagent is still running', () => {
      expect(attentionDecision({ event: 'Stop', claude: runningSubagent, wasDeferred: false })).toEqual({
        status: null,
        deferral: 'set',
      });
    });

    // Shapes from the claude 2.1.310 Stop payload builder. The Monitor tool and `until` loops
    // run as `shell` tasks; an MCP monitor or task names its `server`.
    it.each([
      ['a workflow', { id: 'w1', type: 'workflow', status: 'running', name: 'review' }],
      ['a teammate', { id: 't1', type: 'teammate', status: 'running' }],
      ['a cloud session', { id: 'r1', type: 'cloud session', status: 'running' }],
      ['an MCP monitor', { id: 'm1', type: 'monitor', status: 'running', server: 'slack', tool: 'watch' }],
      ['an MCP task', { id: 'm2', type: 'MCP task', status: 'pending', server: 'jobs', tool: 'run' }],
    ])('defers while %s is running', (_label, task) => {
      expect(attentionDecision({ event: 'Stop', claude: { background_tasks: [task] }, wasDeferred: false })).toEqual({
        status: null,
        deferral: 'set',
      });
    });

    // A watched artifact is a `monitor` task with no server, running for the session's whole
    // life: counting it kept the workspace `working` until it was closed. Nor does Claude's own
    // housekeeping, or a kind this code has never seen, say the session is busy.
    it.each([
      ['an artifact watch', { id: 'a1', type: 'monitor', status: 'running', description: 'Watching artifact' }],
      ['a dream', { id: 'd1', type: 'dream', status: 'running' }],
      ['an auto-mode scan', { id: 's1', type: 'auto-mode scan', status: 'running' }],
      ['an unknown kind', { id: 'u1', type: 'something-new', status: 'running' }],
    ])('needs feedback when only %s is running', (_label, task) => {
      expect(attentionDecision({ event: 'Stop', claude: { background_tasks: [task] }, wasDeferred: true })).toEqual({
        status: 'needs-feedback',
        deferral: 'clear',
      });
    });

    it('defers when real work runs beside an artifact watch', () => {
      const tasks = [
        { id: 'a1', type: 'monitor', status: 'running' },
        { id: 'b1', type: 'shell', status: 'running', command: 'sleep 300' },
      ];
      expect(attentionDecision({ event: 'Stop', claude: { background_tasks: tasks }, wasDeferred: false }).deferral).toBe(
        'set',
      );
    });

    it('needs feedback when no background task is running', () => {
      expect(
        attentionDecision({ event: 'Stop', claude: { background_tasks: [] }, wasDeferred: true }),
      ).toEqual({ status: 'needs-feedback', deferral: 'clear' });
    });

    it('needs feedback when a background task has finished rather than running', () => {
      const done = { background_tasks: [{ id: 'x', type: 'shell', status: 'completed' }] };
      expect(attentionDecision({ event: 'Stop', claude: done, wasDeferred: false })).toEqual({
        status: 'needs-feedback',
        deferral: 'clear',
      });
    });

    // background_tasks is undocumented; if it ever disappears or an old hook script sends
    // nothing, fall back to today's behaviour rather than to silence.
    it.each([
      ['absent', undefined],
      ['null', null],
      ['malformed', { background_tasks: 'nope' }],
    ])('needs feedback when the payload is %s', (_label, claude) => {
      expect(attentionDecision({ event: 'Stop', claude, wasDeferred: false })).toEqual({
        status: 'needs-feedback',
        deferral: 'clear',
      });
    });
  });

  describe('Notification', () => {
    it('ignores the 60s idle prompt on a deferred session', () => {
      expect(attentionDecision({ event: 'Notification', claude: idlePrompt, wasDeferred: true })).toEqual({
        status: null,
        deferral: 'keep',
      });
    });

    it('needs feedback for an idle prompt when the session is not deferred', () => {
      expect(attentionDecision({ event: 'Notification', claude: idlePrompt, wasDeferred: false })).toEqual({
        status: 'needs-feedback',
        deferral: 'clear',
      });
    });

    // A permission prompt is the highest-value alert Perch has — it must never be swallowed,
    // even while background work is pending.
    it('needs feedback for a permission prompt even on a deferred session', () => {
      const permission = {
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
      };
      expect(attentionDecision({ event: 'Notification', claude: permission, wasDeferred: true })).toEqual({
        status: 'needs-feedback',
        deferral: 'clear',
      });
    });

    it('needs feedback for a notification with no payload', () => {
      expect(attentionDecision({ event: 'Notification', claude: undefined, wasDeferred: true })).toEqual({
        status: 'needs-feedback',
        deferral: 'clear',
      });
    });
  });

  describe('other events', () => {
    it('clears the deferral when the user submits a new prompt', () => {
      expect(attentionDecision({ event: 'UserPromptSubmit', claude: undefined, wasDeferred: true })).toEqual({
        status: 'working',
        deferral: 'clear',
        messagedLast: 'clear',
      });
    });

    // A background subagent's own tool calls fire these in the parent session after its Stop.
    // Clearing here would let the 60s idle_prompt through and defeat the feature.
    it('keeps the deferral on PreToolUse', () => {
      expect(attentionDecision({ event: 'PreToolUse', claude: undefined, wasDeferred: true })).toEqual({
        status: 'working',
        deferral: 'keep',
      });
    });

    it('keeps the deferral on PostToolUse', () => {
      expect(attentionDecision({ event: 'PostToolUse', claude: undefined, wasDeferred: true })).toEqual({
        status: 'working',
        deferral: 'keep',
        messagedLast: 'clear',
      });
    });

    // A subagent's tool calls fire in the parent session while the main loop may be blocked on
    // a question. Stamping `working` there silently overwrites the `needs-feedback` the block
    // just raised, which is what left workspaces stuck on `working` with a prompt on screen.
    it.each(['PreToolUse', 'PostToolUse'])(
      'leaves the status alone on %s from a subagent',
      (event) => {
        expect(attentionDecision({ event, claude: subagentToolCall, wasDeferred: false })).toEqual({
          status: null,
          deferral: 'keep',
        });
      },
    );

    it('still reports working on PreToolUse from the main loop', () => {
      const ownToolCall = { tool_name: 'Bash', session_id: 'abc' };
      expect(attentionDecision({ event: 'PreToolUse', claude: ownToolCall, wasDeferred: false })).toEqual({
        status: 'working',
        deferral: 'keep',
      });
    });

    it('still reports working on PostToolUse from the main loop', () => {
      const ownToolCall = { tool_name: 'Bash', session_id: 'abc' };
      expect(attentionDecision({ event: 'PostToolUse', claude: ownToolCall, wasDeferred: false })).toEqual({
        status: 'working',
        deferral: 'keep',
        messagedLast: 'clear',
      });
    });
  });

  // Claude blocks indefinitely on these two tools waiting for the user to pick an option, and
  // never auto-times-out. Reading the tool name makes the block visible immediately rather than
  // depending on the `permission_prompt` Notification that trails it by a few seconds.
  describe('blocked on a user decision', () => {
    it.each(['AskUserQuestion', 'ExitPlanMode'])('needs feedback when %s is called', (tool) => {
      expect(
        attentionDecision({ event: 'PreToolUse', claude: { tool_name: tool }, wasDeferred: true }),
      ).toEqual({ status: 'needs-feedback', deferral: 'clear' });
    });

    it('reports working again once the user has answered', () => {
      expect(
        attentionDecision({
          event: 'PostToolUse',
          claude: { tool_name: 'AskUserQuestion' },
          wasDeferred: false,
        }),
      ).toEqual({ status: 'working', deferral: 'keep', messagedLast: 'clear' });
    });

    // A subagent asking its own question must not speak for the parent session.
    it('ignores AskUserQuestion raised inside a subagent', () => {
      expect(
        attentionDecision({
          event: 'PreToolUse',
          claude: { tool_name: 'AskUserQuestion', agent_id: 'a1b3', agent_type: 'explorer' },
          wasDeferred: false,
        }),
      ).toEqual({ status: null, deferral: 'keep' });
    });

    it('leaves everything untouched for an unmapped event', () => {
      expect(attentionDecision({ event: 'SomethingElse', claude: undefined, wasDeferred: true })).toEqual({
        status: null,
        deferral: 'keep',
      });
    });
  });

  // A child that sent its question to its orchestrator, or an orchestrator that answered a
  // child, ends its turn waiting on that session's reply, not on the user.
  describe('waiting on a peer session', () => {
    it('marks the session when the main loop sends a message', () => {
      expect(attentionDecision({ event: 'PostToolUse', claude: ownMessage, wasDeferred: false })).toEqual({
        status: 'working',
        deferral: 'keep',
        messagedLast: 'set',
      });
    });

    it('defers a Stop whose last tool was SendMessage', () => {
      expect(
        attentionDecision({ event: 'Stop', claude: { background_tasks: [] }, wasDeferred: false, messagedLast: true }),
      ).toEqual({ status: null, deferral: 'set' });
    });

    it('a tool call after SendMessage ends the wait', () => {
      expect(
        attentionDecision({ event: 'PostToolUse', claude: { tool_name: 'Write' }, wasDeferred: false }).messagedLast,
      ).toBe('clear');
      expect(
        attentionDecision({ event: 'Stop', claude: { background_tasks: [] }, wasDeferred: false, messagedLast: false }),
      ).toEqual({ status: 'needs-feedback', deferral: 'clear' });
    });

    it("leaves the mark alone on a subagent's SendMessage", () => {
      expect(
        attentionDecision({
          event: 'PostToolUse',
          claude: { ...ownMessage, agent_id: 'a0000000000000003', agent_type: 'general-purpose' },
          wasDeferred: false,
        }),
      ).toEqual({ status: null, deferral: 'keep' });
    });

    it('swallows the idle prompt after a Stop deferred on a peer', () => {
      expect(attentionDecision({ event: 'Notification', claude: idlePrompt, wasDeferred: true })).toEqual({
        status: null,
        deferral: 'keep',
      });
    });

    it('a permission prompt still gets through after SendMessage', () => {
      expect(
        attentionDecision({
          event: 'Notification',
          claude: { notification_type: 'permission_prompt' },
          wasDeferred: true,
          messagedLast: true,
        }),
      ).toEqual({ status: 'needs-feedback', deferral: 'clear' });
    });

    // The peer's reply arrives as a UserPromptSubmit (`<cross-session-message …>`).
    it('the reply resets the mark', () => {
      expect(
        attentionDecision({ event: 'UserPromptSubmit', claude: undefined, wasDeferred: true, messagedLast: true }),
      ).toEqual({ status: 'working', deferral: 'clear', messagedLast: 'clear' });
    });
  });

  // Payloads shaped like a real Codex 0.162 run's; ids are placeholders. Codex asks its questions
  // asynchronously: the question tool's PostToolUse fires at once (`accepted`), the model then
  // sleeps on `clocksleep`, and the answer arrives as a UserPromptSubmit.
  describe('Codex', () => {
    const askQuestion = {
      tool_name: 'request_user_input_async',
      tool_input: { questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }] },
    };
    const questionAccepted = { ...askQuestion, tool_response: '{"accepted":true}' };
    const sleep = { tool_name: 'clocksleep', tool_input: { duration_ms: 60000 } };
    const approval = { tool_name: 'Bash', tool_input: { command: 'touch /x', description: 'Allow?' } };

    it('an approval request needs the user', () => {
      expect(attentionDecision({ event: 'PermissionRequest', claude: approval, wasDeferred: false })).toEqual({
        status: 'needs-feedback',
        deferral: 'keep',
      });
    });

    // The human is asked even when it is a subagent's call that needs approving.
    it("a subagent's approval request needs the user too", () => {
      expect(
        attentionDecision({
          event: 'PermissionRequest',
          claude: { ...approval, agent_id: 'a1', agent_type: 'default' },
          wasDeferred: false,
        }),
      ).toEqual({ status: 'needs-feedback', deferral: 'keep' });
    });

    it('asking a question needs the user and marks the question pending', () => {
      expect(attentionDecision({ event: 'PreToolUse', claude: askQuestion, wasDeferred: false })).toEqual({
        status: 'needs-feedback',
        deferral: 'keep',
        question: 'set',
      });
    });

    it('the synchronous question tool counts too', () => {
      expect(
        attentionDecision({ event: 'PreToolUse', claude: { tool_name: 'request_user_input' }, wasDeferred: false })
          .question,
      ).toBe('set');
    });

    it("a subagent's question does not speak for the parent", () => {
      expect(
        attentionDecision({ event: 'PreToolUse', claude: { ...askQuestion, agent_id: 'a1' }, wasDeferred: false }),
      ).toEqual({ status: null, deferral: 'keep' });
    });

    it('tool calls while the question is pending leave the status alone', () => {
      for (const [event, claude] of [
        ['PostToolUse', questionAccepted],
        ['PreToolUse', sleep],
        ['PostToolUse', sleep],
      ] as const) {
        expect(attentionDecision({ event, claude, wasDeferred: false, questionPending: true })).toEqual({
          status: null,
          deferral: 'keep',
        });
      }
    });

    it('the answer clears the question and resumes work', () => {
      expect(
        attentionDecision({ event: 'UserPromptSubmit', claude: undefined, wasDeferred: false, questionPending: true }),
      ).toEqual({ status: 'working', deferral: 'clear', messagedLast: 'clear', question: 'clear' });
    });

    it('a turn end clears the question', () => {
      expect(attentionDecision({ event: 'Stop', claude: {}, wasDeferred: false, questionPending: true })).toEqual({
        status: 'needs-feedback',
        deferral: 'clear',
        question: 'clear',
      });
    });
  });

  // Claude Code fires StopFailure instead of Stop when an API error (usage limit, overload, a
  // dropped connection) ends the turn: the turn is over, whatever it was waiting on.
  describe('StopFailure', () => {
    it('needs feedback and drops every mark', () => {
      expect(
        attentionDecision({
          event: 'StopFailure',
          claude: runningShell,
          wasDeferred: true,
          messagedLast: true,
          questionPending: true,
        }),
      ).toEqual({ status: 'needs-feedback', deferral: 'clear', messagedLast: 'clear', question: 'clear' });
    });
  });

  // A new `claude` process in the workspace (started, resumed, or `/clear`ed) has no turn in
  // flight and none of the background tasks the old one was parked on.
  describe('SessionStart', () => {
    it.each(['startup', 'resume', 'clear', 'fork'])('a %s drops every mark and ends a stale working', (source) => {
      expect(
        attentionDecision({
          event: 'SessionStart',
          claude: { source },
          wasDeferred: true,
          messagedLast: true,
          questionPending: true,
          currentStatus: 'working',
        }),
      ).toEqual({ status: 'needs-feedback', deferral: 'clear', messagedLast: 'clear', question: 'clear' });
    });

    // An unpark sets `idle` and its resume fires SessionStart; a status the user or a hook set
    // is not this event's to overwrite.
    it.each(['idle', 'needs-feedback', 'finished', undefined] as const)('leaves a %s status alone', (currentStatus) => {
      expect(
        attentionDecision({ event: 'SessionStart', claude: { source: 'resume' }, wasDeferred: false, currentStatus }),
      ).toEqual({ status: null, deferral: 'clear', messagedLast: 'clear', question: 'clear' });
    });

    // Auto-compaction fires SessionStart in the middle of a turn.
    it.each([{ source: 'compact' }, {}, undefined])('ignores a compaction or an unknown source (%o)', (claude) => {
      expect(
        attentionDecision({ event: 'SessionStart', claude, wasDeferred: true, messagedLast: true, currentStatus: 'working' }),
      ).toEqual({ status: null, deferral: 'keep' });
    });
  });

  describe('reason', () => {
    it.each([
      [{ event: 'Stop', claude: runningShell, wasDeferred: false }, 'stop-background'],
      [{ event: 'Stop', claude: {}, wasDeferred: false, messagedLast: true }, 'stop-messaged'],
      [{ event: 'Stop', claude: {}, wasDeferred: false }, 'stop'],
      [{ event: 'StopFailure', claude: {}, wasDeferred: false }, 'stop-failure'],
      [{ event: 'Notification', claude: idlePrompt, wasDeferred: true }, 'idle-suppressed'],
      [{ event: 'Notification', claude: idlePrompt, wasDeferred: false }, 'notification'],
      [{ event: 'UserPromptSubmit', wasDeferred: false }, 'prompt'],
      [{ event: 'PermissionRequest', wasDeferred: false }, 'permission'],
      [{ event: 'PreToolUse', claude: subagentToolCall, wasDeferred: false }, 'subagent-tool'],
      [{ event: 'PreToolUse', claude: { tool_name: 'Bash' }, wasDeferred: false, questionPending: true }, 'question-pending'],
      [{ event: 'PreToolUse', claude: { tool_name: 'request_user_input' }, wasDeferred: false }, 'question'],
      [{ event: 'PreToolUse', claude: { tool_name: 'AskUserQuestion' }, wasDeferred: false }, 'blocking-tool'],
      [{ event: 'PostToolUse', claude: ownMessage, wasDeferred: false }, 'tool'],
      [{ event: 'SessionStart', claude: { source: 'clear' }, wasDeferred: false, currentStatus: 'working' }, 'session-start'],
      [{ event: 'SessionStart', claude: { source: 'compact' }, wasDeferred: false }, 'compact'],
      [{ event: 'Whatever', wasDeferred: false }, 'unknown-event'],
    ] as const)('%o → %s', (input, reason) => {
      expect(decide(input).reason).toBe(reason);
    });
  });

  // The whole point of the feature: a session parked on a background subagent must survive
  // both the subagent's own tool chatter and the 60s idle prompt without shouting "Needs you".
  it('stays quiet across Stop -> subagent tool calls -> idle prompt', () => {
    expect(attentionDecision({ event: 'Stop', claude: runningSubagent, wasDeferred: false }).deferral).toBe('set');
    expect(attentionDecision({ event: 'PreToolUse', claude: undefined, wasDeferred: true }).deferral).toBe('keep');
    expect(attentionDecision({ event: 'Notification', claude: idlePrompt, wasDeferred: true })).toEqual({
      status: null,
      deferral: 'keep',
    });
  });
});
