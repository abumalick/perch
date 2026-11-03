import { basename } from 'node:path';

// Claude Code sets the terminal title to "<status-glyph> <task title>" (e.g.
// "✳ ui improvements"). Strip that leading glyph to recover the task title.
// Codex removes its spinner when idle, and Claude's `/rename` writes a title with no glyph, so
// the recorded launch command also identifies task titles. Other plain titles may be shell
// hostnames and use the directory fallback.
const STATUS_PREFIX = /^[^\p{L}\p{N}]+\s+/u;
const NAMES_ITS_TITLES = /^(?:\S*\/)?(?:codex|claude)(?:\s|$)/u;
// Claude's title before it has summarised anything.
const PLACEHOLDER = 'Claude Code';

export function deriveWorkspaceName(paneTitle: string, startPath: string, command = '', id = ''): string {
  if (STATUS_PREFIX.test(paneTitle) || NAMES_ITS_TITLES.test(command.trim())) {
    const stripped = paneTitle.replace(STATUS_PREFIX, '').trim();
    // A `--name <id>` session writes its id as its title.
    if (stripped && stripped !== PLACEHOLDER && stripped !== id) return stripped;
  }
  return basename(startPath);
}
