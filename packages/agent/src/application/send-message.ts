import type { MessageDelivery } from '../ports/message-delivery-port.js';
import type { MessageLog } from '../ports/message-log-port.js';
import type { ParkedStorePort } from '../ports/parked-store-port.js';
import type { ProcessAncestry } from '../ports/process-ancestry-port.js';
import type { TmuxPort, TmuxSessionInfo } from '../ports/tmux-port.js';
import {
  cliOfCommand,
  formatAgentMessage,
  isNoDaemonCodex,
  relationOf,
  type AgentCli,
  type Relation,
} from './agent-message.js';
import { deriveWorkspaceName } from './derive-workspace-name.js';

export type SendRefusal =
  | 'not run from a Perch workspace'
  | 'empty message'
  | 'cannot message yourself'
  | `no workspace ${string} on this machine`
  | `${string} is parked; run perch unpark ${string} first`
  | `${string} runs no claude, codex or pi`
  | `${string} was started with --no-daemon`
  | `delivery failed: ${string}`;

export interface SendMessageDeps {
  tmux: TmuxPort;
  parked: ParkedStorePort;
  ancestry: ProcessAncestry;
  delivery: MessageDelivery;
  log: MessageLog;
  machineId: string;
  sessionPrefix: string;
  now: () => number;
  onSent: (senderId: string) => void;
}

export type SendResult = { result: 'delivered' } | { result: 'refused'; reason: SendRefusal };

// The name goes inside a one-line header: a newline or quote in it could forge header fields.
function headerSafe(name: string): string {
  return name.replace(/[\p{Cc}"]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export async function sendMessage(
  deps: SendMessageDeps,
  req: { pane: string; pid: number; to: string; body: string },
): Promise<SendResult> {
  const bytes = Buffer.byteLength(req.body, 'utf8');
  let from = '';
  let relation: Relation = 'peer';
  let cli: AgentCli | null = null;

  const refuse = async (reason: SendRefusal): Promise<SendResult> => {
    await record('refused', reason);
    return { result: 'refused', reason };
  };
  const record = async (outcome: 'delivered' | 'refused', reason?: string): Promise<void> => {
    try {
      await deps.log.append({
        at: deps.now(),
        from,
        to: req.to,
        relation,
        cli,
        outcome,
        ...(reason !== undefined ? { reason } : {}),
        bytes,
      });
    } catch {
      // Logging is best-effort: it never changes the outcome.
    }
  };

  if (req.body.trim() === '') return refuse('empty message');

  const sender = await resolveSender(deps, req.pane, req.pid);
  if (!sender) return refuse('not run from a Perch workspace');
  from = sender.name;

  if (req.to === sender.name) return refuse('cannot message yourself');

  const sessions = await deps.tmux.listSessions(deps.sessionPrefix);
  const recipient = sessions.find((s) => s.name === req.to);
  if (!recipient) {
    if (await deps.parked.get(req.to)) return refuse(`${req.to} is parked; run perch unpark ${req.to} first`);
    return refuse(`no workspace ${req.to} on this machine`);
  }

  relation = relationOf(
    { id: sender.name, parentId: sender.parent },
    { id: recipient.name, parentId: recipient.parent },
  );
  cli = cliOfCommand(recipient.command);
  if (!cli) return refuse(`${req.to} runs no claude, codex or pi`);
  if (isNoDaemonCodex(recipient.command)) return refuse(`${req.to} was started with --no-daemon`);

  const text = formatAgentMessage({
    from: {
      id: sender.name,
      name: headerSafe(deriveWorkspaceName(sender.title, sender.startPath, sender.command, sender.name)),
      cli: cliOfCommand(sender.command) ?? 'claude',
    },
    relation,
    machineId: deps.machineId,
    body: req.body,
  });
  const delivered = await deps.delivery.deliver(
    { id: recipient.name, from: sender.name, cli, command: recipient.command },
    text,
  );
  if (!delivered.ok) return refuse(`delivery failed: ${delivered.reason}`);

  await record('delivered');
  deps.onSent(sender.name);
  return { result: 'delivered' };
}

async function resolveSender(deps: SendMessageDeps, pane: string, pid: number): Promise<TmuxSessionInfo | null> {
  if (!deps.tmux.sessionOfPane || !deps.tmux.panePid) return null;
  const name = await deps.tmux.sessionOfPane(pane);
  if (!name) return null;
  const session = (await deps.tmux.listSessions(deps.sessionPrefix)).find((s) => s.name === name);
  if (!session) return null;
  const panePid = await deps.tmux.panePid(name);
  if (panePid === null || !(await deps.ancestry.isAncestor(panePid, pid))) return null;
  return session;
}
