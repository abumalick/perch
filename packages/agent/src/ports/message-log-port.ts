import type { AgentCli, Relation } from '../application/agent-message.js';

// Never carries the message body, only its size.
export interface MessageLogEntry {
  at: number;
  from: string;
  to: string;
  relation: Relation;
  cli: AgentCli | null;
  outcome: 'delivered' | 'refused';
  reason?: string;
  bytes: number;
}

export interface MessageLog {
  append(entry: MessageLogEntry): Promise<void>;
}
