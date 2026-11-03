import { describe, it, expect } from 'vitest';
import { deriveWorkspaceName } from './derive-workspace-name';

describe('deriveWorkspaceName', () => {
  it('strips the leading Claude status glyph from the pane title', () => {
    expect(deriveWorkspaceName('✳ ui improvements', '/home/u/workspace/api')).toBe('ui improvements');
  });

  // unpark sets `✳ <parked name>`, which must read back as exactly that name.
  it.each(['audit claude workflows #1077', '#1077 audit', 'story foo 9'])('round-trips a restored title (%s)', (name) => {
    expect(deriveWorkspaceName(`✳ ${name}`, '/home/u/workspace/api')).toBe(name);
  });

  it('handles braille spinner glyphs', () => {
    expect(deriveWorkspaceName('⠂ session-title', '/home/u/workspace/api')).toBe('session-title');
  });

  it('handles a glyph with an emoji variation selector', () => {
    expect(deriveWorkspaceName('✳️ vs title', '/home/u/workspace/api')).toBe('vs title');
  });

  it('falls back to the directory basename when the title is the bare hostname', () => {
    expect(deriveWorkspaceName('dev', '/home/u/workspace/api')).toBe('api');
  });

  it('falls back to basename for a dotted hostname', () => {
    expect(deriveWorkspaceName('dev.example.com', '/home/u/workspace/api')).toBe('api');
  });

  it('does not treat an accented leading letter as a glyph', () => {
    expect(deriveWorkspaceName('élan plan', '/home/u/workspace/api')).toBe('api');
  });

  it('falls back to basename when the title is empty', () => {
    expect(deriveWorkspaceName('', '/home/u/workspace/api')).toBe('api');
  });

  it('falls back to basename when the title is only a glyph', () => {
    expect(deriveWorkspaceName('✳ ', '/home/u/workspace/api')).toBe('api');
  });

  it.each(['codex', 'codex --no-daemon --model model-name', '/usr/local/bin/codex --no-daemon'])(
    'keeps the Codex task name when its spinner disappears (%s)',
    (command) => {
      for (const title of ['⠂ Fix parser | api', 'Fix parser | api']) {
        expect(deriveWorkspaceName(title, '/home/u/workspace/api', command)).toBe('Fix parser | api');
      }
    },
  );

  it.each(['', '   ', '⠂ '])('falls back for an empty Codex title (%j)', (title) => {
    expect(deriveWorkspaceName(title, '/home/u/workspace/api', 'codex --no-daemon')).toBe('api');
  });

  it.each(['zsh', 'codex-helper', 'echo codex', 'claude-helper'])('keeps the plain-title fallback for %s', (command) => {
    expect(deriveWorkspaceName('dev.example.com', '/home/u/workspace/api', command)).toBe('api');
  });

  // `/rename` (Claude Code 2.1.316) writes the new name with no status glyph.
  it.each([
    "claude --model 'opus[1m]'",
    "claude --model 'opus[1m]' --resume abc || exec claude --model 'opus[1m]'",
    '/home/u/.local/bin/claude',
  ])('takes a plain title Claude set (%s)', (command) => {
    expect(deriveWorkspaceName('multi perch server per machine', '/home/u/workspace/api', command, 'api-3')).toBe(
      'multi perch server per machine',
    );
  });

  // Claude's title before any summary, and the bare `--name` a named session writes, say nothing.
  it.each(['Claude Code', '✳ Claude Code', 'api-3', '✳ api-3'])('falls back for an uninformative Claude title (%s)', (title) => {
    expect(deriveWorkspaceName(title, '/home/u/workspace/api', 'claude --name api-3', 'api-3')).toBe('api');
  });
});
