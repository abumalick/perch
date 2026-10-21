import { describe, it, expect } from 'vitest';
import { dedentCopied, snapshotBuffer, type SnapshotBuffer } from './terminal-snapshot';

// Rows as xterm stores them: fixed width (padded with spaces), plus whether the row is the
// soft-wrapped continuation of the one above.
function buffer(rows: Array<string | [string, 'wrapped']>, viewportY = 0, cols = 10): SnapshotBuffer & { cols: number } {
  const lines = rows.map((r) => {
    const [text, isWrapped] = typeof r === 'string' ? [r, false] : [r[0], true];
    const padded = text.padEnd(cols, ' ');
    return {
      isWrapped,
      translateToString: (trimRight?: boolean) => (trimRight ? padded.replace(/\s+$/, '') : padded),
    };
  });
  return { length: lines.length, viewportY, cols, getLine: (i) => lines[i] };
}

const run = (b: SnapshotBuffer & { cols: number }) => snapshotBuffer(b, b.cols);
const texts0 = (b: SnapshotBuffer & { cols: number }) => run(b).lines.map((l) => l.text);

describe('snapshotBuffer', () => {
  it('returns one line per row with trailing padding trimmed', () => {
    expect(texts0(buffer(['$ ls', 'a  b']))).toEqual(['$ ls', 'a  b']);
  });

  it('joins soft-wrapped rows into one logical line, keeping a space at the wrap point', () => {
    expect(texts0(buffer(['https://ex', ['ample.com ', 'wrapped'], ['next', 'wrapped'], 'after']))).toEqual(['https://example.com next', 'after']);
  });

  it('drops blank rows at the end of the buffer', () => {
    expect(texts0(buffer(['one', '', 'two', '', '']))).toEqual(['one', '', 'two']);
  });

  it('maps the viewport top row to its logical line', () => {
    const rows: Array<string | [string, 'wrapped']> = ['a', 'bbbbbbbbbb', ['b', 'wrapped'], 'c', 'd'];
    expect(run(buffer(rows, 0)).viewportLine).toBe(0);
    expect(run(buffer(rows, 2)).viewportLine).toBe(1);
    expect(run(buffer(rows, 3)).viewportLine).toBe(2);
  });

  it('keeps the viewport line in range when it points into trimmed blank rows', () => {
    expect(run(buffer(['one', '', ''], 2)).viewportLine).toBe(0);
  });

  it('handles an empty buffer', () => {
    expect(run(buffer([]))).toEqual({ lines: [], viewportLine: 0 });
  });
});

// Claude Code wraps its own text: each row arrives as a separate line, the indent repeated
// and the space at the break dropped. Shapes below are taken from real panes.
describe('snapshotBuffer: rebuilding paragraphs an app wrapped itself', () => {
  const W = 40;
  const texts = (rows: string[]) => run(buffer(rows, 0, W)).lines.map((l) => l.text);

  it('joins prose the app broke because the next word did not fit, dropping the repeated indent', () => {
    const rows = [
      '  The bank is declining the charge, and',
      '  the error says so.',
    ];
    expect(texts(rows)).toEqual(['  The bank is declining the charge, and the error says so.']);
  });

  it('keeps a line break when the next word would have fitted (a real newline)', () => {
    expect(texts(['  Short line.', '  Another line.'])).toEqual(['  Short line.', '  Another line.']);
  });

  it('joins over several rows into one paragraph', () => {
    const rows = [
      '  one two three four five six seven eig',
      '  nine ten eleven twelve thirteen fourt',
      '  end',
    ];
    expect(texts(rows)).toEqual([
      '  one two three four five six seven eig nine ten eleven twelve thirteen fourt end',
    ]);
  });

  it('continues a "-" bullet under its text and a "•" bullet under the bullet itself', () => {
    expect(texts([
      '  - Submitted the ticket for the account',
      '    asking them to retry.',
      '  • Tell them why the charges were the',
      '  declined ones.',
    ])).toEqual([
      '  - Submitted the ticket for the account asking them to retry.',
      '  • Tell them why the charges were the declined ones.',
    ]);
  });

  it('never joins the start of a new item, even when it would not have fitted', () => {
    expect(texts([
      '  - First item fills the whole row here',
      '  - Second item',
      '  1. Numbered item fills the whole row',
      '  2. Next',
    ])).toEqual([
      '  - First item fills the whole row here',
      '  - Second item',
      '  1. Numbered item fills the whole row',
      '  2. Next',
    ]);
  });

  it('joins a token cut at the edge of the row without a space', () => {
    expect(texts([
      '● Bash(curl https://example.com/a/very/l',
      '  ong/path/that/goes/on/and/on/and/on/zz',
      '  /end)',
    ])).toEqual(['● Bash(curl https://example.com/a/very/long/path/that/goes/on/and/on/and/on/zz/end)']);
  });

  it('does not join a short line to a token too long for any row', () => {
    expect(texts(['  $ cat notes', '  https://example.com/a/path/longer/than/a/row'])).toEqual([
      '  $ cat notes',
      '  https://example.com/a/path/longer/than/a/row',
    ]);
  });

  it('puts a space back when a full row simply ended on a word', () => {
    expect(texts([
      '  aaaa bbbb cccc dddd eeee ffff gggg hhh',
      '  iiii',
    ])).toEqual(['  aaaa bbbb cccc dddd eeee ffff gggg hhh iiii']);
  });

  it('keeps an indent change, a table and the prompt apart', () => {
    const rows = [
      '  A paragraph that runs to the very end',
      '      indented differently',
      '  │ cell one that is wide enough here │',
      '  │ cell two                           │',
      '❯ a prompt typed by the user that wraps',
      '  onto a second row',
    ];
    expect(texts(rows)).toEqual(rows);
  });

  it('gives a joined paragraph the hanging indent of its continuation rows', () => {
    const lines = run(buffer([
      '  - Submitted the ticket for the account',
      '    asking them to retry.',
      '  plain',
    ], 0, W)).lines;
    expect(lines.map((l) => l.hang)).toEqual([4, 0]);
  });

  it('maps the viewport row into a rebuilt paragraph', () => {
    const rows = ['  The bank is declining the charge, and', '  the error says so.', '  next'];
    expect(run(buffer(rows, 1, W)).viewportLine).toBe(0);
    expect(run(buffer(rows, 2, W)).viewportLine).toBe(1);
  });
});

describe('dedentCopied', () => {
  it('trims the indent of a single copied line', () => {
    expect(dedentCopied('  ls -la')).toBe('ls -la');
  });

  it('removes the indent every line shares, keeping relative indentation', () => {
    expect(dedentCopied('  - item\n    continued\n  - next')).toBe('- item\n  continued\n- next');
  });

  it('dedents a selection that starts mid-line by the indent of the lines after it', () => {
    expect(dedentCopied('word and more\n  second line\n    nested')).toBe('word and more\nsecond line\n  nested');
  });

  it('ignores blank lines when measuring the shared indent', () => {
    expect(dedentCopied('  one\n\n  two')).toBe('one\n\ntwo');
  });

  it('leaves text unchanged when a line after the first has no indent', () => {
    expect(dedentCopied('  a\n  b\nc')).toBe('  a\n  b\nc');
  });
});
