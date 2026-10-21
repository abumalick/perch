import { describe, expect, test } from 'vitest';
import { diffLine } from './android-terminal-input';

const DEL = '\x7f';

describe('diffLine', () => {
  test('types an appended suffix', () => {
    expect(diffLine('git', 'git status')).toBe(' status');
  });

  test('backspaces a removed suffix', () => {
    expect(diffLine('hello', 'hel')).toBe(`${DEL}${DEL}`);
  });

  test('backspaces to the common prefix, then retypes', () => {
    expect(diffLine('git', 'gut')).toBe(`${DEL}${DEL}ut`);
  });

  test('an unchanged line sends nothing', () => {
    expect(diffLine('see path/to/file', 'see path/to/file')).toBe('');
  });

  test('an edit before the end retypes the tail, since the pty cursor is at the end', () => {
    expect(diffLine('abc', 'axbc')).toBe(`${DEL}${DEL}xbc`);
  });
});
