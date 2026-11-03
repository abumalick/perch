import type { AgentCli } from '../application/agent-message';
import type { MessageDelivery } from '../ports/message-delivery-port';

// Picks the delivery for the recipient's CLI. A throw becomes a failed delivery, so sendMessage
// logs every outcome.
export class CompositeDelivery implements MessageDelivery {
  constructor(private readonly byCli: Partial<Record<AgentCli, MessageDelivery>>) {}

  async deliver(target: { id: string; cli: AgentCli; command: string }, text: string) {
    const delivery = this.byCli[target.cli];
    if (!delivery) return { ok: false as const, reason: `no delivery for ${target.cli} on this agent yet` };
    try {
      return await delivery.deliver(target, text);
    } catch (err) {
      return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}
