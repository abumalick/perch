import { describe, it, expect } from 'vitest';
import { normalizeCommand } from './remember-launcher';

describe('normalizeCommand', () => {
  it('trims', () => expect(normalizeCommand('  pi  ')).toBe('pi'));
  it('drops empty and whitespace-only', () => {
    expect(normalizeCommand('')).toBeNull();
    expect(normalizeCommand('   ')).toBeNull();
  });
  it('drops the bare built-ins', () => {
    for (const c of ['bash', 'claude', 'codex', ' bash ']) expect(normalizeCommand(c)).toBeNull();
  });
  it('keeps a built-in with flags', () => {
    expect(normalizeCommand('claude --dangerously-skip-permissions')).toBe('claude --dangerously-skip-permissions');
  });
});
