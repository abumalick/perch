import { describe, it, expect, beforeEach } from 'vitest';
import { createConnectionLog, type ConnectionLog } from './connection-log';
import type { ClientLogBatch } from '@perch/contracts';
import { flushConnectionLog } from './connection-log-flush';

function makeLog(): ConnectionLog {
  let state: import('./connection-log').PersistedLogState | null = null;
  const store = { load: () => state, save: (s: import('./connection-log').PersistedLogState) => void (state = structuredClone(s)) };
  const env = { now: () => 1000, readEnv: () => ({ online: true, vis: 'visible' }) };
  return createConnectionLog({ store, env, sess: 'A' });
}

describe('flushConnectionLog', () => {
  let log: ConnectionLog;
  beforeEach(() => {
    log = makeLog();
  });

  it('sends pending events with the meta and marks them flushed once the agent confirms', async () => {
    log.push('dev', 'connect');
    log.push('dev', 'close', { code: 1006 });
    const batches: ClientLogBatch[] = [];
    const flushed = await flushConnectionLog({ log, machineId: 'dev', send: async (b) => (batches.push(b), true), meta: { ua: 'iPhone', shell: 'pwa' } });

    expect(flushed).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ ua: 'iPhone', shell: 'pwa' });
    expect(batches[0]!.events.map((e) => e.kind)).toEqual(['connect', 'close']);
    expect(log.pendingFor('dev')).toEqual([]);
  });

  it('does not send when there is nothing pending', async () => {
    let called = false;
    expect(await flushConnectionLog({ log, machineId: 'dev', send: async () => ((called = true), true) })).toBe(false);
    expect(called).toBe(false);
  });

  it('leaves events buffered when the sender fails', async () => {
    log.push('dev', 'connect');
    expect(await flushConnectionLog({ log, machineId: 'dev', send: async () => false })).toBe(false);
    expect(log.pendingFor('dev')).toHaveLength(1);
  });
});

describe('flushConnectionLog over any sender', () => {
  it('marks events flushed only once the sender confirms, and keeps them otherwise', async () => {
    const log = makeLog();
    log.push('dev', 'connect');
    const batches: unknown[] = [];
    expect(await flushConnectionLog({ log, machineId: 'dev', send: async (b) => (batches.push(b), false) })).toBe(false);
    expect(log.pendingFor('dev')).toHaveLength(1);
    expect(await flushConnectionLog({ log, machineId: 'dev', send: async (b) => (batches.push(b), true), meta: { shell: 'pwa' } })).toBe(true);
    expect(log.pendingFor('dev')).toEqual([]);
    expect(batches[1]).toMatchObject({ shell: 'pwa', events: [{ kind: 'connect' }] });
  });
});
