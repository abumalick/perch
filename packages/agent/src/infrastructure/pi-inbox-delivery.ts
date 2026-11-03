import { connect } from 'node:net';
import { join } from 'node:path';
import type { DeliveryTarget, MessageDelivery } from '../ports/message-delivery-port';

const TIMEOUT_MS = 5_000;

type Result = { ok: true } | { ok: false; reason: string };

// Writes a message into the inbox socket the Perch extension for Pi binds per workspace
// (contract: docs/MESSAGING.md, "Pi inbox contract"). Unlike Claude's, this inbox answers, so
// "ok" means the extension handed the message to Pi.
export class PiInboxDelivery implements MessageDelivery {
  constructor(private readonly inboxDir: string) {}

  async deliver(target: DeliveryTarget, text: string): Promise<Result> {
    if (target.id.includes('/') || target.id.startsWith('.')) {
      return { ok: false, reason: `the Pi inbox of ${target.id} failed: not a workspace id` };
    }
    return exchange(join(this.inboxDir, `${target.id}.sock`), `${JSON.stringify({ v: 1, text })}\n`, target.id);
  }
}

function exchange(socketPath: string, line: string, id: string): Promise<Result> {
  return new Promise((resolve) => {
    let answer = '';
    let settled = false;
    const socket = connect(socketPath, () => socket.write(line));
    const settle = (result: Result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const failed = (message: string) => settle({ ok: false, reason: `the Pi inbox of ${id} failed: ${message}` });
    const timer = setTimeout(() => settle({ ok: false, reason: 'the Pi inbox did not answer in 5 s' }), TIMEOUT_MS);
    socket.on('data', (d) => {
      answer += String(d);
      const end = answer.indexOf('\n');
      if (end < 0) return;
      let reply: unknown;
      try {
        reply = JSON.parse(answer.slice(0, end));
      } catch {
        return failed('unexpected answer');
      }
      const r = reply as { ok?: unknown; error?: unknown } | null;
      if (r?.ok === true) return settle({ ok: true });
      if (r?.ok === false) return settle({ ok: false, reason: `the Pi inbox refused: ${String(r.error ?? 'no reason')}` });
      failed('unexpected answer');
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') return settle({ ok: false, reason: 'Pi without the Perch inbox' });
      failed(err.message);
    });
    socket.on('close', () => failed('closed without answering'));
  });
}
