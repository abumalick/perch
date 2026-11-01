import { describe, it, expect } from 'vitest';
import { programStatusDecision as decide } from './program-status-decision';

const marks = { deferred: false, messagedLast: false };

describe('programStatusDecision', () => {
  it('maps working to working', () => {
    expect(decide({ state: 'working', currentStatus: 'needs-feedback', ...marks })).toEqual({
      reason: 'osc-working',
      status: 'working',
    });
  });

  it('maps blocked to needs-feedback, whatever the marks say', () => {
    expect(decide({ state: 'blocked', currentStatus: 'working', deferred: true, messagedLast: true })).toEqual({
      reason: 'osc-blocked',
      status: 'needs-feedback',
    });
  });

  it.each(['done', 'error'])('ends a working turn with %s as needs-feedback', (state) => {
    expect(decide({ state, currentStatus: 'working', ...marks })).toEqual({
      reason: 'osc-done',
      status: 'needs-feedback',
    });
  });

  // OSC says `done` while a background shell still runs, and while a child waits on its
  // orchestrator: the hook marks know better.
  it('leaves a turn end alone while a hook mark holds the session working', () => {
    expect(decide({ state: 'done', currentStatus: 'working', deferred: true, messagedLast: false })).toEqual({
      reason: 'osc-deferred',
      status: null,
    });
    expect(decide({ state: 'error', currentStatus: 'working', deferred: false, messagedLast: true })).toEqual({
      reason: 'osc-messaged',
      status: null,
    });
  });

  // The Esc interrupt fires no hook at all; OSC is the only source that sees it.
  it('turns an interrupted working turn into needs-feedback and ends its deferral', () => {
    expect(decide({ state: 'idle', currentStatus: 'working', deferred: true, messagedLast: false })).toEqual({
      reason: 'osc-idle',
      status: 'needs-feedback',
      deferral: 'clear',
    });
  });

  // Codex reports `idle` after a turn; its Stop hook may already have said needs-feedback.
  it('leaves any status but working alone on idle', () => {
    expect(decide({ state: 'idle', currentStatus: 'needs-feedback', ...marks })).toEqual({
      reason: 'osc-idle',
      status: null,
    });
  });

  it.each(['finished', 'parked'] as const)('never moves a workspace off %s', (currentStatus) => {
    for (const state of ['idle', 'working', 'done', 'blocked', 'error']) {
      expect(decide({ state, currentStatus, ...marks })).toEqual({ reason: 'osc-manual', status: null });
    }
  });

  it('ignores a state it does not know', () => {
    expect(decide({ state: 'sleeping', currentStatus: 'working', ...marks })).toEqual({
      reason: 'osc-unknown',
      status: null,
    });
  });
});
