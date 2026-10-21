// Android IME adapter for xterm's hidden textarea.
//
// xterm's composition handling desyncs from the pty on Android (see
// core/android-terminal-input.ts). On Android we take over the textarea: the browser applies
// every keyboard edit to it, and after each one we send the pty whatever turns the line it
// already has into the field's text. The field is therefore both the keyboard's context (it
// reads it back for word boundaries, predictions and the swipe-typing space) and the record
// of what the pty line holds. xterm's own keyboard/composition/input path is silenced in the
// capture phase so nothing double-sends. iOS keeps xterm's normal path — this adapter never
// attaches there.
//
// A keydown that edits no text — a shortcut, or a named key such as Esc, Tab, an arrow or F5,
// from a hardware keyboard or a soft keyboard's own keys — is let through to xterm, which
// encodes every modifier combination and sends it from the keydown. Text keys stay on the
// field path. Paste bytes are left to xterm's paste listener (it brackets them).

import { diffLine } from '../core/android-terminal-input';
import type { InputLog } from '../core/terminal-input-log';

export function isAndroid(userAgent: string): boolean {
  return /Android/i.test(userAgent);
}

// Make control bytes readable for the diagnostics log.
function printable(s: string): string {
  return s
    .replace(/\x7f/g, '⌫')
    .replace(/\r/g, '⏎')
    .replace(/\x1b/g, '⎋')
    .replace(/\t/g, '⇥');
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn', 'NumLock']);

// Whether xterm should handle this keydown. Soft-keyboard text (229, Unidentified, Process),
// dead keys and AltGr characters edit the field. A bare modifier is no key yet: letting it
// through would start the field over in the middle of a word. Enter and Backspace (HeliBoard
// sends both as real keycodes) edit the field too, through beforeinput. Ctrl+V is the browser's
// paste, which xterm would turn into ^V and cancel.
function forXterm(e: KeyboardEvent): boolean {
  if (e.isComposing || e.keyCode === 229) return false;
  if (MODIFIER_KEYS.has(e.key) || e.key === 'Unidentified' || e.key === 'Process' || e.key === 'Dead') return false;
  if (e.getModifierState('AltGraph')) return false;
  if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'v') return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return true;
  return [...e.key].length > 1 && e.key !== 'Enter' && e.key !== 'Backspace';
}

export interface AndroidInput {
  destroy(): void;
  /** Drop the retained IME context — call when the pty line changes out-of-band. */
  resetContext(): void;
}

export function attachAndroidInput(
  root: HTMLElement,
  textarea: HTMLTextAreaElement,
  opts: { send: (data: string) => void; log?: InputLog },
): AndroidInput {
  // The field's text that is already on the pty line. It and the field change together: a
  // field emptied behind its back would make the next diff backspace the whole line.
  let sent = '';

  const sync = (line: string): void => {
    sent = line;
    textarea.value = line;
    textarea.setSelectionRange(line.length, line.length);
  };

  const emit = (kind: string, detail: string, output: string): void => {
    if (output) opts.send(output);
    opts.log?.push({ kind, detail, out: printable(output) });
  };

  // Bring the pty line to the field's text. A keyboard that re-opens a committed word as a
  // composition leaves the field unchanged, so nothing is sent — there is nothing to infer.
  const flush = (kind: string, detail: string): void => {
    const output = diffLine(sent, textarea.value);
    sent = textarea.value;
    emit(kind, detail, output);
  };

  // The pty line changed without the field (keyboard bar, clipboard button, dictation, a
  // cursor move): start the field over. With a word still open this is also what ends it:
  // HeliBoard drops a composition whose text the field no longer holds and starts the next
  // letter afresh. Leaving the open word in place let the bar's bytes land on the pty while
  // the keyboard went on editing that word, so its next backspace hit the wrong character.
  const resetContext = (): void => sync('');

  // xterm empties the field when it loses focus, so `sent` must follow or the next edit would
  // backspace the whole line. Any open composition is finished before the blur.
  const onFocusOut = (e: Event): void => {
    if (forThisTextarea(e)) sync('');
  };

  // xterm registers its own listeners on the textarea during open(), before we attach.
  // At the target node, listeners run in registration order regardless of capture flag,
  // so stopping propagation on the textarea would fire too late — xterm would already have
  // processed (and re-sent) the event. We listen on an ancestor in the capture phase, which
  // runs before the event reaches the textarea, and stopPropagation() shields xterm entirely.
  const forThisTextarea = (e: Event): boolean => e.target === textarea;

  const onCompositionStart = (e: Event): void => {
    if (!forThisTextarea(e)) return;
    e.stopPropagation();
    opts.log?.push({ kind: 'compositionstart', detail: '', out: '' });
  };
  const onCompositionUpdate = (e: Event): void => {
    if (!forThisTextarea(e)) return;
    e.stopPropagation();
    opts.log?.push({ kind: 'compositionupdate', detail: (e as CompositionEvent).data ?? '', out: '' });
  };
  const onCompositionEnd = (e: Event): void => {
    if (!forThisTextarea(e)) return;
    e.stopPropagation();
    flush('compositionend', (e as CompositionEvent).data ?? '');
  };

  const onBeforeInput = (e: Event): void => {
    if (!forThisTextarea(e)) return;
    e.stopPropagation();
    const ev = e as globalThis.InputEvent;
    switch (ev.inputType) {
      case 'insertLineBreak':
      case 'insertParagraph':
        e.preventDefault();
        flush(`beforeinput:${ev.inputType}`, '');
        emit('enter', '', '\r');
        // The pty is back at a fresh prompt; a stale field would make the keyboard prepend a
        // space to the next line.
        sync('');
        return;
      case 'insertFromPaste':
        // xterm already sent the text from its `paste` listener and emptied the field. Claude
        // Code may fold a paste into a placeholder, so the line it lands on is unknown: start
        // the field over rather than let the default action put the text back to be diffed.
        e.preventDefault();
        sync('');
        opts.log?.push({ kind: 'paste', detail: ev.data ?? '', out: '' });
        return;
      case 'deleteContentBackward':
        // Nothing before the caret: the browser changes nothing and fires no input, but the
        // pty line may still hold text from before the field was started over.
        if (textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
          emit('beforeinput:deleteContentBackward', '', '\x7f');
        }
        return;
    }
  };

  const onInput = (e: Event): void => {
    if (!forThisTextarea(e)) return;
    // xterm's input handler would re-send inserted text and empty the field.
    e.stopPropagation();
    const ev = e as globalThis.InputEvent;
    flush(`input:${ev.inputType}`, ev.data ?? '');
  };

  const onKeyDown = (e: Event): void => {
    if (!forThisTextarea(e)) return;
    const ke = e as KeyboardEvent;
    const toXterm = forXterm(ke);
    if (toXterm) {
      // xterm sends the key and cancels the event; the pty line changed without the field, so
      // start the field over, as a keyboard-bar key does.
      resetContext();
    } else {
      e.stopPropagation();
    }
    opts.log?.push({ kind: 'keydown', detail: `${ke.key} (${ke.keyCode})`, out: toXterm ? 'xterm' : '' });
  };

  // xterm sends a key from `keypress` whenever it did not handle the matching keydown, which is
  // always the case for a keydown stopped above. For Enter it duplicated the '\r' the
  // beforeinput path sends, submitting the line twice. A keydown let through is sent from the
  // keydown itself, so its keypress has nothing to add. No preventDefault: cancelling the
  // keypress would also cancel the beforeinput that carries the Enter.
  const onKeyPress = (e: Event): void => {
    if (forThisTextarea(e)) e.stopPropagation();
  };

  root.addEventListener('compositionstart', onCompositionStart, true);
  root.addEventListener('compositionupdate', onCompositionUpdate, true);
  root.addEventListener('compositionend', onCompositionEnd, true);
  root.addEventListener('beforeinput', onBeforeInput, true);
  root.addEventListener('input', onInput, true);
  root.addEventListener('keydown', onKeyDown, true);
  root.addEventListener('keypress', onKeyPress, true);
  root.addEventListener('focusout', onFocusOut);

  return {
    resetContext,
    destroy() {
      root.removeEventListener('compositionstart', onCompositionStart, true);
      root.removeEventListener('compositionupdate', onCompositionUpdate, true);
      root.removeEventListener('compositionend', onCompositionEnd, true);
      root.removeEventListener('beforeinput', onBeforeInput, true);
      root.removeEventListener('input', onInput, true);
      root.removeEventListener('keydown', onKeyDown, true);
      root.removeEventListener('keypress', onKeyPress, true);
      root.removeEventListener('focusout', onFocusOut);
    },
  };
}
