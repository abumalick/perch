import { beforeEach, describe, expect, test } from 'vitest';
import { attachAndroidInput, isAndroid } from './android-input';
import { createInputLog } from '../core/terminal-input-log';

const DEL = '\x7f';

describe('isAndroid', () => {
  test('detects Android user agents', () => {
    expect(isAndroid('Mozilla/5.0 (Linux; Android 14; SM-S911B) Chrome/120')).toBe(true);
  });
  test('rejects iOS user agents', () => {
    expect(isAndroid('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari')).toBe(false);
  });
});

describe('attachAndroidInput', () => {
  let root: HTMLDivElement;
  let textarea: HTMLTextAreaElement;
  let sent: string[];
  let xtermSaw: string[]; // events a pre-registered xterm-like listener received
  let adapter: ReturnType<typeof attachAndroidInput>;

  beforeEach(() => {
    // Mirror the real DOM: xterm's textarea nested in a container, and xterm's own
    // listeners registered on the textarea BEFORE our adapter attaches.
    root = document.createElement('div');
    textarea = document.createElement('textarea');
    root.appendChild(textarea);
    document.body.appendChild(root);
    xtermSaw = [];
    for (const type of [
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'input',
      'keydown',
      'keypress',
      'beforeinput',
    ]) {
      textarea.addEventListener(type, (e) => xtermSaw.push(e.type));
    }
    sent = [];
    adapter = attachAndroidInput(root, textarea, { send: (d) => sent.push(d) });
  });

  // jsdom has no IME and no default actions: these stand in for the browser.
  const field = () => textarea.value;

  // One edit: beforeinput, then — unless cancelled — the field changes and input fires.
  function edit(next: string, inputType: string, opts: { data?: string | null; composing?: boolean; caret?: number } = {}) {
    const { data = null, composing = false } = opts;
    const before = new InputEvent('beforeinput', { inputType, data, isComposing: composing, cancelable: true, bubbles: true });
    textarea.dispatchEvent(before);
    if (before.defaultPrevented) return before;
    if (next !== field()) {
      textarea.value = next;
      const caret = opts.caret ?? next.length;
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new InputEvent('input', { inputType, data, isComposing: composing, bubbles: true }));
    }
    return before;
  }
  const compose = (type: string, data: string) =>
    textarea.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));

  // A composition that replaces `from` (the field's tail) with each of `steps` in turn.
  function composeWord(steps: string[], from = '') {
    compose('compositionstart', '');
    let current = from;
    for (const step of steps) {
      compose('compositionupdate', step);
      edit(field().slice(0, field().length - current.length) + step, 'insertCompositionText', { data: step, composing: true });
      current = step;
    }
    compose('compositionend', current);
  }
  const type = (word: string) => composeWord([...word].map((_, i) => word.slice(0, i + 1)));
  const insert = (text: string) => edit(field() + text, 'insertText', { data: text });
  const backspace = () => edit(field().slice(0, -1), 'deleteContentBackward');

  // The pty line the sent bytes produce.
  const pty = () => sent.join('').split('').reduce((line, c) => (c === DEL ? line.slice(0, -1) : line + c), '');

  test('forwards each keystroke of a composition live', () => {
    compose('compositionstart', '');
    compose('compositionupdate', 'g');
    edit('g', 'insertCompositionText', { data: 'g', composing: true });
    expect(sent.join('')).toBe('g');
    compose('compositionupdate', 'gi');
    edit('gi', 'insertCompositionText', { data: 'gi', composing: true });
    compose('compositionend', 'gi');
    expect(sent.join('')).toBe('gi');
  });

  test('shields xterm from every event it would act on', () => {
    // xterm registers its textarea listeners before us, so at the target node they run first
    // and stopImmediatePropagation cannot stop them: we intercept on an ancestor in the capture
    // phase. Its input handler would re-send the text and empty the field.
    type('a');
    insert(' ');
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', keyCode: 229, bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent('keypress', { key: 'a', bubbles: true }));
    expect(xtermSaw).toEqual([]);
    expect(sent.join('')).toBe('a ');
  });

  test('reconciles an autocorrect swap at commit with backspaces', () => {
    composeWord(['g', 'gi', 'git', 'gut']);
    expect(sent.join('')).toBe(`git${DEL}${DEL}ut`);
  });

  test('applies an autocorrect replacement of a committed word', () => {
    type('teh');
    insert(' ');
    edit('the ', 'insertReplacementText', { data: 'the' });
    expect(pty()).toBe('the ');
  });

  test('sends one backspace per character a single edit deletes', () => {
    type('hello');
    insert(' ');
    type('world');
    edit('hello ', 'deleteWordBackward');
    expect(pty()).toBe('hello ');
  });

  // Replays the on-device HeliBoard stream for "see path/to/file.ts", three backspaces, then
  // "md". HeliBoard splits words on "/" and ".", so after the backspaces it reopens just "file"
  // as a composition, with no change to the field. The pty used to get "see path/to/filefilemd".
  test('does not re-send a word the keyboard reopens after a backspace', () => {
    type('see');
    insert(' ');
    type('path');
    insert('/');
    type('to');
    insert('/');
    type('file');
    insert('.');
    compose('compositionstart', '');
    for (const step of ['t', 'ts', 't', '']) {
      compose('compositionupdate', step);
      edit(field().replace(/t?s?$/, step), 'insertCompositionText', { data: step, composing: true });
    }
    compose('compositionend', '');
    backspace(); // the "."
    compose('compositionstart', ''); // HeliBoard reopens "file": no beforeinput, no input
    compose('compositionupdate', 'file');
    for (const step of ['filem', 'filemd']) {
      compose('compositionupdate', step);
      edit(`see path/to/${step}`, 'insertCompositionText', { data: step, composing: true });
    }
    compose('compositionend', 'filemd');
    expect(pty()).toBe('see path/to/filemd');
  });

  test('editing a reopened word sends only the change', () => {
    type('hello');
    sent.length = 0;
    composeWord(['hello', 'hell', 'help'], 'hello');
    expect(sent.join('')).toBe(`${DEL}${DEL}p`);
    expect(field()).toBe('help');
  });

  // Gesture (swipe) typing emits the inter-word space as its own insertText, and only when the
  // keyboard sees a word before the cursor. The field must hold the whole line for that: a
  // one-word window passed with two words and dropped every space from the third
  // ("one twothreefour" on-device).
  test('keeps the whole line in the field, so every swiped space is emitted', () => {
    for (const word of ['one', 'two', 'three']) {
      composeWord([word]);
      insert(' ');
    }
    composeWord(['four']);
    expect(field()).toBe('one two three four');
    expect(pty()).toBe('one two three four');
  });

  test('a new word that starts with the previous one types in full', () => {
    composeWord(['two']);
    insert(' ');
    composeWord(['twofold']);
    expect(pty()).toBe('two twofold');
  });

  test('an edit before the end of the field retypes the tail', () => {
    type('abc');
    edit('axbc', 'insertText', { data: 'x', caret: 2 });
    expect(pty()).toBe('axbc');
  });

  // One soft-keyboard Enter fires keydown(13) → keypress(13) → beforeinput(insertLineBreak).
  // xterm answers a keypress with its own key whenever it did not handle the keydown, and it
  // never does here because the keydown is swallowed — so the line was submitted twice.
  test('sends exactly one carriage return for a soft-keyboard Enter and starts the field over', () => {
    type('hello');
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    textarea.dispatchEvent(
      new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, charCode: 13, bubbles: true, cancelable: true }),
    );
    const ev = edit('hello\n', 'insertLineBreak');
    expect(ev.defaultPrevented).toBe(true);
    expect(sent.join('')).toBe('hello\r');
    expect(field()).toBe('');
    expect(xtermSaw).toEqual([]);
  });

  test('a backspace on an empty field still reaches the pty', () => {
    // On-device: an empty field gets keydown(8) + beforeinput deleteContentBackward and no
    // input event, while the pty line can still hold text from before the field started over.
    backspace();
    backspace();
    expect(sent).toEqual([DEL, DEL]);
  });

  test('a backspace in a non-empty field is sent once', () => {
    type('ab');
    sent.length = 0;
    backspace();
    expect(sent).toEqual([DEL]);
  });

  const keydown = (init: KeyboardEventInit) => {
    const ev = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init });
    textarea.dispatchEvent(ev);
    return ev;
  };

  // A hardware keyboard (and HeliBoard's dpad joystick) sends real key events for shortcuts and
  // cursor moves. They edit no text, so xterm encodes them — it knows every modifier combination
  // and the application cursor mode — and the field starts over, since the pty line changed
  // without it.
  test.each<[string, KeyboardEventInit]>([
    ['Ctrl+P', { key: 'p', keyCode: 80, ctrlKey: true }],
    ['Alt+b', { key: 'b', keyCode: 66, altKey: true }],
    ['Ctrl+Backspace', { key: 'Backspace', keyCode: 8, ctrlKey: true }],
    ['Alt+Enter', { key: 'Enter', keyCode: 13, altKey: true }],
    ['Escape', { key: 'Escape', keyCode: 27 }],
    ['Tab', { key: 'Tab', keyCode: 9 }],
    ['Shift+Tab', { key: 'Tab', keyCode: 9, shiftKey: true }],
    ['Shift+ArrowLeft', { key: 'ArrowLeft', keyCode: 37, shiftKey: true }],
    ['ArrowLeft', { key: 'ArrowLeft', keyCode: 37 }],
    ['ArrowUp', { key: 'ArrowUp', keyCode: 38 }],
    ['Home', { key: 'Home', keyCode: 36 }],
    ['PageDown', { key: 'PageDown', keyCode: 34 }],
    ['Delete', { key: 'Delete', keyCode: 46 }],
    ['F5', { key: 'F5', keyCode: 116 }],
  ])('lets %s through to xterm and starts the field over', (_name, init) => {
    type('hello');
    sent.length = 0;
    keydown(init);
    expect(xtermSaw).toEqual(['keydown']);
    expect(sent).toEqual([]);
    expect(field()).toBe('');
  });

  test('a key let through mid-word ends the open word', () => {
    compose('compositionstart', '');
    compose('compositionupdate', 'he');
    edit('he', 'insertCompositionText', { data: 'he', composing: true });
    keydown({ key: 'Tab', keyCode: 9 });
    expect(field()).toBe('');
    sent.length = 0;
    type('x');
    expect(sent).toEqual(['x']);
  });

  // A keyboard-bar or hardware Shift held before a letter must not blank the field mid-word.
  test.each(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'])(
    'stops a bare %s keydown and keeps the field',
    (key) => {
      type('hello');
      keydown({ key, shiftKey: key === 'Shift' });
      expect(xtermSaw).toEqual([]);
      expect(field()).toBe('hello');
    },
  );

  // Text keys stay on the field path: soft-keyboard text (229/Unidentified), a printable key
  // with or without Shift, and the Enter/Backspace HeliBoard sends as real keycodes.
  test.each<[string, KeyboardEventInit]>([
    ['229', { key: 'Unidentified', keyCode: 229 }],
    ['Process', { key: 'Process', keyCode: 229 }],
    ['Dead', { key: 'Dead', keyCode: 222 }],
    ['a', { key: 'a', keyCode: 65 }],
    ['Shift+A', { key: 'A', keyCode: 65, shiftKey: true }],
    ['space', { key: ' ', keyCode: 32 }],
    ['Enter', { key: 'Enter', keyCode: 13 }],
    ['Shift+Enter', { key: 'Enter', keyCode: 13, shiftKey: true }],
    ['Backspace', { key: 'Backspace', keyCode: 8 }],
    ['AltGr+@', { key: '@', keyCode: 48, altKey: true, modifierAltGraph: true } as KeyboardEventInit],
  ])('keeps a %s keydown from xterm and the field intact', (_name, init) => {
    type('hello');
    keydown(init);
    expect(xtermSaw).toEqual([]);
    expect(field()).toBe('hello');
  });

  // xterm would send ^V and cancel the event, so the browser's paste — which is what HeliBoard's
  // paste key triggers — would never fire.
  test.each(['v', 'V'])('leaves Ctrl+%s to the browser paste', (key) => {
    const ev = keydown({ key, keyCode: 86, ctrlKey: true, shiftKey: key === 'V' });
    expect(xtermSaw).toEqual([]);
    expect(ev.defaultPrevented).toBe(false);
  });

  test('stops the keypress after a key let through, so nothing doubles', () => {
    keydown({ key: 'Escape', keyCode: 27 });
    textarea.dispatchEvent(new KeyboardEvent('keypress', { key: 'Escape', keyCode: 27, bubbles: true }));
    expect(xtermSaw).toEqual(['keydown']);
  });

  // The adapter's send may itself start the field over (a keyboard-bar Ctrl turns the typed
  // letter into a control byte the pty line does not hold): that must stick.
  test('a send that starts the field over leaves both empty', () => {
    sent.length = 0;
    const r = document.createElement('div');
    const ta = document.createElement('textarea');
    r.appendChild(ta);
    document.body.appendChild(r);
    const out: string[] = [];
    const a = attachAndroidInput(r, ta, {
      send: (d) => {
        out.push(d);
        if (d === 'p') a.resetContext();
      },
    });
    ta.value = 'p';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'p', bubbles: true }));
    expect(ta.value).toBe('');
    ta.value = 'x';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true }));
    expect(out).toEqual(['p', 'x']);
  });

  test('resetContext starts the field over without touching the pty', () => {
    type('hello');
    sent.length = 0;
    adapter.resetContext();
    expect(field()).toBe('');
    type('x');
    expect(sent).toEqual(['x']);
  });

  test('resetContext ends an open word, so the next letter starts a new one', () => {
    // On-device: a keyboard-bar key while HeliBoard still has "bc" open. Changing the field
    // makes HeliBoard drop that composition and start the next letter afresh, into the empty
    // field — no update for the old word follows.
    compose('compositionstart', '');
    for (const step of ['b', 'bc']) {
      compose('compositionupdate', step);
      edit(step, 'insertCompositionText', { data: step, composing: true });
    }
    adapter.resetContext();
    expect(field()).toBe('');
    sent.length = 0;
    type('x');
    expect(sent).toEqual(['x']);
  });

  test('a blur starts the field over, since xterm empties it', () => {
    // xterm's own blur listener sets textarea.value = ''. Diffing the next edit against the
    // line already sent backspaced all of it.
    textarea.addEventListener('blur', () => (textarea.value = ''));
    type('hello');
    textarea.dispatchEvent(new FocusEvent('blur'));
    textarea.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    sent.length = 0;
    type('x');
    expect(sent).toEqual(['x']);
  });

  // HeliBoard's paste key sends Ctrl+V: xterm sends the text from its `paste` listener and
  // empties the field, then the browser's default action would put the text back.
  function paste(text: string) {
    sent.push(text); // what xterm's own paste listener sends
    textarea.value = '';
    return edit(text, 'insertFromPaste', { data: text });
  }

  test('leaves a keyboard paste to xterm and starts the field over', () => {
    type('say');
    insert(' ');
    const ev = paste('alpha beta gamma');
    expect(ev.defaultPrevented).toBe(true);
    expect(pty()).toBe('say alpha beta gamma');
    expect(field()).toBe('');
    backspace();
    expect(pty()).toBe('say alpha beta gamm');
  });

  test('records the bytes it sends in the diagnostics log', () => {
    const log = createInputLog(50);
    const r = document.createElement('div');
    const ta = document.createElement('textarea');
    r.appendChild(ta);
    document.body.appendChild(r);
    attachAndroidInput(r, ta, { send: () => {}, log });
    ta.value = 'x';
    ta.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', data: 'x', isComposing: true, bubbles: true }));
    expect(log.snapshot().at(-1)).toMatchObject({ kind: 'input:insertCompositionText', detail: 'x', out: 'x' });
  });

  test('destroy removes listeners', () => {
    adapter.destroy();
    type('z');
    expect(sent).toEqual([]);
  });
});
