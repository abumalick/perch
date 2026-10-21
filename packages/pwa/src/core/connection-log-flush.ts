import type { ClientLogBatch } from '@perch/contracts';
import type { ConnectionLog } from './connection-log';

// Delivers one batch to the agent; resolves true only once the agent has stored it. Never
// rejects: any failure is `false`, and the events stay buffered.
export type LogSender = (batch: ClientLogBatch) => Promise<boolean>;

// Flushes a machine's pending connection-log events to its agent. A no-op (returns false) when
// nothing is pending. Once the agent confirms, the sent events are marked flushed so they are
// never re-sent; on any failure they stay buffered and drain on the next reconnect.
export async function flushConnectionLog(deps: {
  log: ConnectionLog;
  machineId: string;
  send: LogSender;
  meta?: { ua?: string; shell?: string };
}): Promise<boolean> {
  const { log, machineId, send, meta } = deps;
  const events = log.pendingFor(machineId);
  if (events.length === 0) return false;
  if (!(await send({ ...meta, events }))) return false;
  log.markFlushed(machineId, Math.max(...events.map((e) => e.seq)));
  return true;
}
