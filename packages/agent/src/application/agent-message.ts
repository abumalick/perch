export type AgentCli = 'claude' | 'codex' | 'pi';
export type Relation = 'orchestrator' | 'child' | 'peer';

type Linked = { id: string; parentId?: string };

const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

function commandWords(command: string): string[] {
  const words = command.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && ENV_PREFIX.test(words[0]!)) words.shift();
  return words;
}

export function cliOfCommand(command: string): AgentCli | null {
  const first = commandWords(command)[0];
  if (!first) return null;
  const name = first.split('/').pop();
  if (name === 'claude') return 'claude';
  if (name === 'codex') return 'codex';
  if (name === 'pi' || name === 'pi-reviewed') return 'pi';
  return null;
}

// The Codex session bound to a daemon thread. A thread two sessions claim names neither.
export function sessionOfCodexThread<S extends { command: string; codexThread?: string }>(sessions: S[], thread: string): S | null {
  const matches = sessions.filter((s) => s.codexThread === thread && cliOfCommand(s.command) === 'codex');
  return matches.length === 1 ? matches[0]! : null;
}

export function isNoDaemonCodex(command: string): boolean {
  return cliOfCommand(command) === 'codex' && commandWords(command).includes('--no-daemon');
}

export function relationOf(sender: Linked, recipient: Linked): Relation {
  if (recipient.parentId === sender.id) return 'orchestrator';
  if (sender.parentId === recipient.id) return 'child';
  return 'peer';
}

const RELATION_LABEL: Record<Relation, string> = {
  orchestrator: 'your ORCHESTRATOR',
  child: 'your CHILD',
  peer: 'a PEER',
};

// Receivers take authority only from the message's first line; a body line that starts like a
// header is quoted so no reader can take it for one. A reader may well ignore case, Unicode
// spaces and a fullwidth bracket, so the match does too; `[^\S\r\n]` keeps it from reaching back
// across a blank line.
function quoteHeaderLines(body: string): string {
  return body.replace(/^([^\S\r\n]*[\[［]perch message)/gimu, '> $1');
}

export function formatAgentMessage(m: {
  // 'shell': a sender workspace running none of the agent CLIs.
  from: { id: string; name: string; cli: AgentCli | 'shell' };
  relation: Relation;
  machineId: string;
  // Unique per send: Claude drops a body equal to one the same sender sent in the last 30 s.
  msgId: string;
  body: string;
}): string {
  return [
    `[Perch message — from ${RELATION_LABEL[m.relation]}]`,
    `from: ${m.from.id} "${m.from.name}" (${m.from.cli}) · relation: ${m.relation} · machine: ${m.machineId} · msg ${m.msgId}`,
    `reply with: perch send ${m.from.id} "<your reply>"`,
    '---',
    quoteHeaderLines(m.body),
  ].join('\n');
}
