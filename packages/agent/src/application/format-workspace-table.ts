import type { Workspace } from '@perch/contracts';

const TITLE_MAX = 40;

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

function tildePath(path: string, home: string): string {
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function shorten(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

// A child waiting on its orchestrator stays `working`; the table names what it waits for.
function statusCell(w: Workspace): string {
  const status = w.waitingOn === 'parent' ? 'needs-orchestrator' : w.status;
  return w.urgent ? `${status} (urgent)` : status;
}

// `perch ls`'s human table. NAME is the Claude session's messaging name (what SendMessage
// takes), TITLE the workspace's display name, AGE the time in its current status.
export function formatWorkspaceTable(workspaces: Workspace[], opts: { now: number; home: string }): string {
  if (workspaces.length === 0) return 'no workspaces';
  const rows = [
    ['ID', 'NAME', 'STATUS', 'AGE', 'PARENT', 'TITLE', 'FOLDER'],
    ...workspaces.map((w) => [
      w.id,
      w.agentAddress ?? '-',
      statusCell(w),
      formatAge(opts.now - w.lastActivityAt),
      w.parentId ?? '-',
      shorten(w.name),
      tildePath(w.projectPath, opts.home),
    ]),
  ];
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)));
  return rows
    .map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]!))).join('  '))
    .join('\n');
}
