import { describe, it, expect } from 'vitest';
import { CodexAppServerDown, CodexRpcError } from './codex-app-server';
import { CodexDelivery, type CodexThreads } from './codex-delivery';

type State = { status: 'idle' | 'active'; activeTurnId?: string };

function fake(o: { loaded?: string[]; states?: State[]; steer?: Array<Error | null>; start?: Error; loadedThrows?: Error } = {}) {
  const calls: unknown[][] = [];
  const states = [...(o.states ?? [{ status: 'idle' }])];
  const steers = [...(o.steer ?? [])];
  const threads: CodexThreads = {
    loadedThreads: async () => {
      if (o.loadedThrows) throw o.loadedThrows;
      return o.loaded ?? ['t1'];
    },
    threadState: async (id) => {
      calls.push(['read', id]);
      return states.length > 1 ? states.shift()! : states[0]!;
    },
    startTurn: async (id, text) => {
      calls.push(['start', id, text]);
      if (o.start) throw o.start;
    },
    steer: async (id, text, turn) => {
      calls.push(['steer', id, text, turn]);
      const err = steers.shift();
      if (err) throw err;
    },
  };
  return { delivery: new CodexDelivery(threads), calls };
}

const target = { id: 'perch-c', from: 'perch-p', cli: 'codex' as const, command: 'codex resume t1', codexThread: 't1' };

describe('CodexDelivery', () => {
  it('refuses a workspace with no recorded thread', async () => {
    const { delivery } = fake();
    expect(await delivery.deliver({ ...target, codexThread: undefined }, 'hi')).toEqual({
      ok: false,
      reason: 'no Codex thread recorded for perch-c (only tarfa spawn --cli codex workspaces take messages)',
    });
  });

  it('refuses a thread the daemon has not loaded', async () => {
    const { delivery, calls } = fake({ loaded: ['other'] });
    expect(await delivery.deliver(target, 'hi')).toEqual({ ok: false, reason: 'the Codex thread of perch-c is not open' });
    expect(calls).toEqual([]);
  });

  it('starts a turn on an idle thread', async () => {
    const { delivery, calls } = fake();
    expect(await delivery.deliver(target, 'hi')).toEqual({ ok: true });
    expect(calls).toEqual([['read', 't1'], ['start', 't1', 'hi']]);
  });

  it('steers the running turn of an active thread', async () => {
    const { delivery, calls } = fake({ states: [{ status: 'active', activeTurnId: 'u2' }] });
    expect(await delivery.deliver(target, 'hi')).toEqual({ ok: true });
    expect(calls).toEqual([['read', 't1'], ['steer', 't1', 'hi', 'u2']]);
  });

  it('re-reads once and steers the new turn when the turn id moved', async () => {
    const { delivery, calls } = fake({
      states: [{ status: 'active', activeTurnId: 'u2' }, { status: 'active', activeTurnId: 'u3' }],
      steer: [new CodexRpcError('expected active turn id `u2` but found `u3`')],
    });
    expect(await delivery.deliver(target, 'hi')).toEqual({ ok: true });
    expect(calls).toEqual([['read', 't1'], ['steer', 't1', 'hi', 'u2'], ['read', 't1'], ['steer', 't1', 'hi', 'u3']]);
  });

  it('re-reads once and starts a turn when the turn ended before the steer', async () => {
    const { delivery, calls } = fake({
      states: [{ status: 'active', activeTurnId: 'u2' }, { status: 'idle' }],
      steer: [new CodexRpcError('no active turn to steer')],
    });
    expect(await delivery.deliver(target, 'hi')).toEqual({ ok: true });
    expect(calls.at(-1)).toEqual(['start', 't1', 'hi']);
  });

  it('retries the race only once', async () => {
    const { delivery, calls } = fake({
      states: [{ status: 'active', activeTurnId: 'u2' }],
      steer: [new CodexRpcError('expected active turn id `u2` but found `u3`'), new CodexRpcError('expected active turn id `u2` but found `u4`')],
    });
    expect(await delivery.deliver(target, 'hi')).toEqual({
      ok: false,
      reason: 'the Codex app server failed: expected active turn id `u2` but found `u4`',
    });
    expect(calls.filter((c) => c[0] === 'steer')).toHaveLength(2);
  });

  it('re-reads once an active thread that names no running turn, then fails', async () => {
    const { delivery, calls } = fake({ states: [{ status: 'active' }] });
    expect(await delivery.deliver(target, 'hi')).toEqual({
      ok: false,
      reason: 'the Codex app server failed: the thread is busy with no turn to steer',
    });
    expect(calls).toEqual([['read', 't1'], ['read', 't1']]);
  });

  it('reports any other daemon error', async () => {
    const { delivery } = fake({ start: new CodexRpcError('quota') });
    expect(await delivery.deliver(target, 'hi')).toEqual({ ok: false, reason: 'the Codex app server failed: quota' });
  });

  it('reports a daemon that is not running', async () => {
    const { delivery } = fake({ loadedThrows: new CodexAppServerDown() });
    expect(await delivery.deliver(target, 'hi')).toEqual({ ok: false, reason: 'the Codex app server is not running' });
  });
});
