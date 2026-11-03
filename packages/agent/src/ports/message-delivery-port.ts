import type { AgentCli } from '../application/agent-message.js';

export interface MessageDelivery {
  deliver(
    target: { id: string; cli: AgentCli; command: string },
    text: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
}
