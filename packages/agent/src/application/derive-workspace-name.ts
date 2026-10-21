import { basename } from 'node:path';

// Claude Code sets the terminal title to "<status-glyph> <task title>" (e.g.
// "✳ ui improvements"). Strip that leading glyph to recover the task title.
// Codex removes its spinner when idle, so its recorded launch command also identifies
// task titles. Other plain titles may be shell hostnames and use the directory fallback.
const STATUS_PREFIX = /^[^\p{L}\p{N}]+\s+/u;

export function deriveWorkspaceName(paneTitle: string, startPath: string, command = ''): string {
  if (STATUS_PREFIX.test(paneTitle) || /^(?:\S*\/)?codex(?:\s|$)/u.test(command.trim())) {
    const stripped = paneTitle.replace(STATUS_PREFIX, '').trim();
    if (stripped) return stripped;
  }
  return basename(startPath);
}
