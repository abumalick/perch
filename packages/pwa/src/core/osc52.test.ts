import { describe, it, expect } from 'vitest';
import { parseOsc52 } from './osc52';

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe('parseOsc52', () => {
  it('decodes the text a program asks to copy', () => {
    expect(parseOsc52(`c;${b64('hello perch')}`)).toBe('hello perch');
  });

  it('accepts the empty selection tmux sends', () => {
    expect(parseOsc52(`;${b64('hello perch')}`)).toBe('hello perch');
  });

  it('decodes UTF-8, not latin1', () => {
    expect(parseOsc52(`c;${b64('café ─ مرحبا')}`)).toBe('café ─ مرحبا');
  });

  it('never answers a clipboard read', () => {
    expect(parseOsc52('c;?')).toBeNull();
  });

  it('ignores an empty payload, which asks to clear the clipboard', () => {
    expect(parseOsc52('c;')).toBeNull();
  });

  it('ignores a payload that is not base64', () => {
    expect(parseOsc52('c;not base64!')).toBeNull();
    expect(parseOsc52('no-separator')).toBeNull();
  });
});
