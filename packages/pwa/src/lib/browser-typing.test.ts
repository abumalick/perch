import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BrowserClientMessage } from '@perch/contracts';
import { attachBrowserTyping, type BrowserTyping } from './browser-typing';

let input: HTMLInputElement;
let sent: BrowserClientMessage[];
let typing: BrowserTyping;

beforeEach(() => {
  input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  sent = [];
  typing = attachBrowserTyping(input, (m) => sent.push(m));
});

afterEach(() => {
  typing.destroy();
  input.remove();
});

// The keys that reached the remote page, one per keyDown.
const keys = (): string[] =>
  sent
    .filter((m) => m.type === 'input_keyboard' && m.eventType === 'keyDown')
    .map((m) => (m as { key: string }).key);

function keydown(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
  input.dispatchEvent(ev);
  return ev;
}

// What the browser does after the keyboard edits the field: the value changes, then `input`.
function edit(value: string, inputType = 'insertText', data: string | null = null): void {
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data }));
}

function beforeinput(inputType: string): InputEvent {
  const ev = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType });
  input.dispatchEvent(ev);
  return ev;
}

describe('attachBrowserTyping', () => {
  // The reported bug: Android keyboards send keydown "Unidentified" (229) and put the text in
  // the field, so a keydown-only path never saw a character.
  it('types an Android keyboard letter from the field, not the keydown', () => {
    const ev = keydown({ key: 'Unidentified', keyCode: 229 });
    expect(ev.defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
    edit('a', 'insertText', 'a');
    expect(keys()).toEqual(['a']);
  });

  it('types a growing composition once per character', () => {
    edit('h', 'insertCompositionText', 'h');
    edit('he', 'insertCompositionText', 'he');
    edit('hel', 'insertCompositionText', 'hel');
    expect(keys()).toEqual(['h', 'e', 'l']);
  });

  it('rewrites a word the keyboard replaced (swipe, prediction, autocorrect)', () => {
    edit('helo ');
    sent = [];
    edit('hello ', 'insertReplacementText', 'hello');
    expect(keys()).toEqual(['Backspace', 'Backspace', 'l', 'o', ' ']);
  });

  it('types a pasted password in full', () => {
    edit('s3cr€t!', 'insertFromPaste', null);
    expect(keys()).toEqual(['s', '3', 'c', 'r', '€', 't', '!']);
  });

  // iOS sends a real keydown for each letter; it must not also be sent from the keydown.
  it('lets a printable keydown through and sends it once, from the field', () => {
    const ev = keydown({ key: 'a', keyCode: 65 });
    expect(ev.defaultPrevented).toBe(false);
    edit('a', 'insertText', 'a');
    expect(keys()).toEqual(['a']);
  });

  it('sends a backspace that deleted from the field once', () => {
    edit('ab');
    sent = [];
    const ev = keydown({ key: 'Backspace', keyCode: 8 });
    expect(ev.defaultPrevented).toBe(false);
    edit('a', 'deleteContentBackward');
    expect(keys()).toEqual(['Backspace']);
  });

  // The remote field may hold text typed before the field last started over.
  it('sends a backspace on an empty field from its keydown', () => {
    const ev = keydown({ key: 'Backspace', keyCode: 8 });
    expect(ev.defaultPrevented).toBe(true);
    expect(keys()).toEqual(['Backspace']);
  });

  it('sends a backspace on an empty field once even if beforeinput follows its keydown', () => {
    keydown({ key: 'Backspace', keyCode: 8 });
    beforeinput('deleteContentBackward');
    expect(keys()).toEqual(['Backspace']);
  });

  it('sends a backspace on an empty field from beforeinput when the keydown was unidentified', () => {
    keydown({ key: 'Unidentified', keyCode: 229 });
    beforeinput('deleteContentBackward');
    expect(keys()).toEqual(['Backspace']);
  });

  it('forwards Enter and starts the field over', () => {
    edit('user');
    sent = [];
    const ev = keydown({ key: 'Enter', keyCode: 13 });
    expect(ev.defaultPrevented).toBe(true);
    expect(keys()).toEqual(['Enter']);
    expect(input.value).toBe('');
    edit('x');
    expect(keys()).toEqual(['Enter', 'x']);
  });

  it('forwards an Enter that arrives only as beforeinput', () => {
    const ev = beforeinput('insertLineBreak');
    expect(ev.defaultPrevented).toBe(true);
    expect(keys()).toEqual(['Enter']);
  });

  it('forwards Tab and the arrows, starting the field over', () => {
    edit('abc');
    sent = [];
    for (const key of ['Tab', 'ArrowLeft', 'ArrowDown', 'Escape']) {
      expect(keydown({ key }).defaultPrevented).toBe(true);
    }
    expect(keys()).toEqual(['Tab', 'ArrowLeft', 'ArrowDown', 'Escape']);
    expect(input.value).toBe('');
  });

  it('forwards a Ctrl shortcut with its modifier', () => {
    const ev = keydown({ key: 'a', ctrlKey: true });
    expect(ev.defaultPrevented).toBe(true);
    expect(sent[0]).toMatchObject({ eventType: 'keyDown', key: 'a', modifiers: 2, text: '' });
  });

  it('ignores a modifier key on its own and a key held during a composition', () => {
    keydown({ key: 'Shift' });
    keydown({ key: 'Enter', isComposing: true });
    expect(sent).toEqual([]);
  });

  it('starts the field over on blur, so the next edit does not backspace the old text', () => {
    edit('abc');
    sent = [];
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(input.value).toBe('');
    edit('d');
    expect(keys()).toEqual(['d']);
  });

  it('starts the field over on reset()', () => {
    edit('abc');
    sent = [];
    typing.reset();
    expect(input.value).toBe('');
    edit('d');
    expect(keys()).toEqual(['d']);
  });

  it('stops listening once destroyed', () => {
    typing.destroy();
    edit('a');
    expect(sent).toEqual([]);
  });
});
