import { describe, it, expect } from 'vitest';
import { CompositeDelivery } from './composite-delivery';
import type { MessageDelivery } from '../ports/message-delivery-port';

describe('CompositeDelivery', () => {
  it('hands the message to the adapter for the recipient CLI', async () => {
    const seen: string[] = [];
    const claude: MessageDelivery = {
      deliver: async (target, text) => {
        seen.push(`${target.id} ${text}`);
        return { ok: true };
      },
    };
    const delivery = new CompositeDelivery({ claude });
    expect(await delivery.deliver({ id: 'perch-a-1', cli: 'claude', command: 'claude' }, 'hi')).toEqual({ ok: true });
    expect(seen).toEqual(['perch-a-1 hi']);
  });

  it('refuses a CLI it has no adapter for', async () => {
    const delivery = new CompositeDelivery({});
    expect(await delivery.deliver({ id: 'perch-a-1', cli: 'pi', command: 'pi' }, 'hi')).toEqual({
      ok: false,
      reason: 'no delivery for pi on this agent yet',
    });
  });

  it('turns a throwing adapter into a failed delivery', async () => {
    const delivery = new CompositeDelivery({
      codex: { deliver: async () => { throw new Error('socket closed'); } },
    });
    expect(await delivery.deliver({ id: 'perch-a-1', cli: 'codex', command: 'codex' }, 'hi')).toEqual({
      ok: false,
      reason: 'socket closed',
    });
  });
});
