// Soft-keyboard typing for the browser view, through a hidden input.
//
// A phone keyboard does not say what it typed in its key events: Android sends keydown
// "Unidentified" (229) for every letter, and swipe words, predictions, autocorrect and
// accents arrive as edits of the field. So the browser applies every edit to the field, and
// after each one the remote page is sent whatever turns what it already has into the field's
// text (`editMessages`). Only keys that do not edit the field (Enter, Tab, arrows, Escape, a
// Ctrl/Meta shortcut, Backspace with nothing left to delete) are forwarded from keydown.
//
// The field is kept, not emptied after each word: the keyboard reads it back for word
// boundaries, predictions and the space after a swiped word. It starts over whenever the
// remote caret may have moved without it (Enter, Tab, arrows, a tap on the page, a blur).

import type { BrowserClientMessage } from '@perch/contracts';
import { editMessages, keyMessages } from '../core/browser-input';

export interface BrowserTyping {
  /** Start the field over: the remote caret moved without it. */
  reset(): void;
  destroy(): void;
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);
// Keys that carry no character of their own; the text, if any, arrives as an edit.
const COMPOSING_KEYS = new Set(['Unidentified', 'Process', 'Dead']);

export function attachBrowserTyping(
  input: HTMLInputElement,
  send: (m: BrowserClientMessage) => void,
): BrowserTyping {
  // The field's text that the remote page already has. It and the field change together.
  let sent = '';
  // A Backspace on an empty field already sent from its keydown. Cancelling that keydown
  // should cancel the beforeinput too, but an IME-generated key may not honour it.
  let backspaceSent = false;

  const sync = (text: string): void => {
    sent = text;
    input.value = text;
  };
  const sendAll = (msgs: BrowserClientMessage[]): void => msgs.forEach(send);
  const caretAtStart = (): boolean => input.selectionStart === 0 && input.selectionEnd === 0;

  const onKeyDown = (e: KeyboardEvent): void => {
    backspaceSent = false;
    if (e.isComposing || e.keyCode === 229 || COMPOSING_KEYS.has(e.key) || MODIFIER_KEYS.has(e.key)) return;
    const shortcut = e.ctrlKey || e.metaKey;
    if ([...e.key].length === 1 && !shortcut) return; // typed through the field
    if (e.key === 'Backspace' && !shortcut && !caretAtStart()) return; // deletes from the field
    e.preventDefault();
    sendAll(keyMessages(e));
    if (e.key === 'Backspace') backspaceSent = true;
    else if (!shortcut) sync('');
  };

  const onBeforeInput = (e: InputEvent): void => {
    switch (e.inputType) {
      case 'insertLineBreak':
      case 'insertParagraph':
        e.preventDefault();
        sendAll(keyMessages({ key: 'Enter', code: 'Enter' }));
        sync('');
        return;
      case 'deleteContentBackward':
        // Nothing before the caret: the browser fires no input, but the remote field may still
        // hold text from before the field started over.
        if (caretAtStart() && !backspaceSent) sendAll(keyMessages({ key: 'Backspace', code: 'Backspace' }));
        backspaceSent = false;
        return;
    }
  };

  const onInput = (): void => {
    sendAll(editMessages(sent, input.value));
    sent = input.value;
  };

  const onFocusOut = (): void => sync('');

  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('beforeinput', onBeforeInput);
  input.addEventListener('input', onInput);
  input.addEventListener('focusout', onFocusOut);

  return {
    reset: () => sync(''),
    destroy() {
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('beforeinput', onBeforeInput);
      input.removeEventListener('input', onInput);
      input.removeEventListener('focusout', onFocusOut);
    },
  };
}
