const BUILTINS = new Set(['bash', 'claude', 'codex']);

// What a Custom launch is remembered as, or null when there is nothing worth listing: the
// bare built-ins already have a radio of their own. Exact match only, so
// `claude --dangerously-skip-permissions` typed as Custom is kept.
export function normalizeCommand(command: string): string | null {
  const trimmed = command.trim();
  return trimmed === '' || BUILTINS.has(trimmed) ? null : trimmed;
}
