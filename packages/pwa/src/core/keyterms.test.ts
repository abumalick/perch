import { describe, it, expect } from 'vitest';
import { mergeKeyterms, MAX_KEYTERMS } from './keyterms';

describe('mergeKeyterms', () => {
  it('returns an empty list when no machine has sent one', () => {
    expect(mergeKeyterms({})).toEqual([]);
  });

  it('unions the machines, in machine order', () => {
    expect(mergeKeyterms({ mini: ['Perch', 'tmux'], mac: ['Xcode'] })).toEqual([
      'Perch',
      'tmux',
      'Xcode',
    ]);
  });

  // Every machine links the same dotfiles list, so most terms arrive twice.
  it('drops case-insensitive duplicates across machines, keeping the first spelling', () => {
    expect(mergeKeyterms({ mini: ['Perch', 'worktree'], mac: ['perch', 'HeliBoard'] })).toEqual([
      'Perch',
      'worktree',
      'HeliBoard',
    ]);
  });

  it('caps the union at MAX_KEYTERMS', () => {
    const mini = Array.from({ length: MAX_KEYTERMS }, (_, i) => `mini${i}`);
    expect(mergeKeyterms({ mini, mac: ['extra'] })).toHaveLength(MAX_KEYTERMS);
  });
});
