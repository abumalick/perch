import type { AgentCli } from '../application/agent-message.js';

export interface DeliveryTarget {
  id: string;
  // The sender's workspace id.
  from: string;
  cli: AgentCli;
  command: string;
}

export interface MessageDelivery {
  deliver(target: DeliveryTarget, text: string): Promise<{ ok: true } | { ok: false; reason: string }>;
}
