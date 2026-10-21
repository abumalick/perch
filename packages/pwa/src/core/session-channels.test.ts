import { describe, it, expect } from 'vitest';
import type { ClientMessage } from '@perch/contracts';
import { SessionChannels } from './session-channels';

const batch = { events: [{ sess: 's', seq: 1, t: 1, kind: 'online', online: true, vis: 'visible' }] };

function setup(online = true) {
  const sent: ClientMessage[] = [];
  const timers: Array<() => void> = [];
  const channels = new SessionChannels({
    send: (m) => sent.push(m),
    isOnline: () => online,
    startTimer: (fn) => {
      timers.push(fn);
      return () => timers.splice(timers.indexOf(fn), 1);
    },
  });
  return { sent, channels, fire: () => [...timers].forEach((t) => t()) };
}

describe('SessionChannels log sender', () => {
  it('sends the batch and resolves with the agent acknowledgement', async () => {
    const { sent, channels } = setup();
    const done = channels.sendLog(batch);
    expect(sent).toEqual([{ type: 'clientLog', id: 'c1', batch }]);
    expect(channels.handle({ type: 'clientLogAck', id: 'c1', ok: true })).toBe(true);
    expect(await done).toBe(true);
  });

  it('resolves false on a refusal, a timeout, going offline, or while offline', async () => {
    const refused = setup();
    const r = refused.channels.sendLog(batch);
    refused.channels.handle({ type: 'clientLogAck', id: 'c1', ok: false });
    expect(await r).toBe(false);

    const slow = setup();
    const s = slow.channels.sendLog(batch);
    slow.fire();
    expect(await s).toBe(false);
    slow.channels.handle({ type: 'clientLogAck', id: 'c1', ok: true });

    const dropped = setup();
    const d = dropped.channels.sendLog(batch);
    dropped.channels.offline();
    expect(await d).toBe(false);

    const offline = setup(false);
    expect(await offline.channels.sendLog(batch)).toBe(false);
    expect(offline.sent).toEqual([]);
  });

  it('routes media and browser messages to their channel and leaves the rest', () => {
    const { channels } = setup();
    expect(channels.handle({ type: 'mediaChunk', id: 'x', seq: 0, data: '' })).toBe(true);
    expect(channels.handle({ type: 'browserClosed', stream: 'x' })).toBe(true);
    expect(channels.handle({ type: 'pong' })).toBe(false);
  });
});
