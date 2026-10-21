import { describe, it, expect } from 'vitest';
import { parseKeyterms, MAX_KEYTERMS } from './parse-keyterms';

describe('parseKeyterms', () => {
  it('reads one term per line, in file order', () => {
    expect(parseKeyterms('Claude Code\nworktree\nHeliBoard\n')).toEqual([
      'Claude Code',
      'worktree',
      'HeliBoard',
    ]);
  });

  it('ignores blank lines, comments and surrounding whitespace', () => {
    expect(parseKeyterms('# my vocabulary\n\n  Perch  \n\n# per project\ntmux\n')).toEqual([
      'Perch',
      'tmux',
    ]);
  });

  it('drops terms the API rejects: over 50 characters, over 5 words, or with forbidden characters', () => {
    const tooLong = 'x'.repeat(51);
    const raw = ['Perch', tooLong, 'one two three four five six', 'brackets [here]', 'a<b'].join('\n');
    expect(parseKeyterms(raw)).toEqual(['Perch']);
  });

  it('keeps a term of exactly 50 characters and exactly 5 words', () => {
    const fifty = 'x'.repeat(50);
    expect(parseKeyterms(`${fifty}\none two three four five`)).toEqual([fifty, 'one two three four five']);
  });

  it('drops case-insensitive duplicates, keeping the first spelling', () => {
    expect(parseKeyterms('Perch\nperch\nPERCH\ntmux')).toEqual(['Perch', 'tmux']);
  });

  // Over 100 terms, ElevenLabs bills every clip as at least 20 seconds — a bad trade for
  // dictation that is usually shorter than that.
  it('caps the list at MAX_KEYTERMS, keeping the first terms', () => {
    const raw = Array.from({ length: MAX_KEYTERMS + 5 }, (_, i) => `term${i}`).join('\n');
    const terms = parseKeyterms(raw);
    expect(terms).toHaveLength(MAX_KEYTERMS);
    expect(terms[0]).toBe('term0');
    expect(terms.at(-1)).toBe(`term${MAX_KEYTERMS - 1}`);
  });

  it('returns an empty list for an empty file', () => {
    expect(parseKeyterms('')).toEqual([]);
  });
});
