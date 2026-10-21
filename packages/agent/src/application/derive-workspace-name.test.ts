import { describe, it, expect } from 'vitest';
import { deriveWorkspaceName } from './derive-workspace-name';

describe('deriveWorkspaceName', () => {
  it('strips the leading Claude status glyph from the pane title', () => {
    expect(deriveWorkspaceName('✳ ui improvements', '/home/u/workspace/api')).toBe('ui improvements');
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

  it.each(['claude', 'zsh', 'codex-helper', 'echo codex'])('keeps the plain-title fallback for %s', (command) => {
    expect(deriveWorkspaceName('dev.example.com', '/home/u/workspace/api', command)).toBe('api');
  });
});
