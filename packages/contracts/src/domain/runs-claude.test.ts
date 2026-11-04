import { describe, expect, it } from 'vitest';
import { runsClaude } from './runs-claude';

describe('runsClaude', () => {
  it.each([
    'claude',
    "claude --model 'opus[1m]'",
    "claude --model 'opus[1m]' --resume abc || exec claude --model 'opus[1m]'",
    'CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude --name perch-x',
    '/home/u/.local/bin/claude',
  ])('takes %s for Claude Code', (command) => expect(runsClaude(command)).toBe(true));

  it.each(['codex --no-daemon', 'zsh', 'bash', 'claude-dev', 'vim claude.md'])('takes %s for something else', (command) =>
    expect(runsClaude(command)).toBe(false),
  );
});
