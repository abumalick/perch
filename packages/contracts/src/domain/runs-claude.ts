// Whether a workspace's launch command runs Claude Code, which is what Claude voice needs: its
// held spaces become a recording only at Claude's prompt, and would be typed anywhere else.
// Matches `claude` as a word or a path's last part, behind any env prefix or before flags.
export function runsClaude(command: string): boolean {
  return /(^|[\s/])claude(\s|$)/.test(command);
}
