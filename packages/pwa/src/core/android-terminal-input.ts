// Turns an edit of xterm's hidden textarea into pty bytes, on Android.
//
// Android soft keyboards edit the textarea through composition + `beforeinput` events, and
// xterm.js's own composition handler desyncs from the pty on them. Inferring each edit from
// its event type does not work either: a keyboard re-opens, replaces and deletes text in ways
// a textarea's events do not describe (getTargetRanges() is always empty there). So the
// browser applies every edit, and the pty is brought from the line it already has to the
// field's new text. Kept DOM-free so it can be unit-tested.

const DEL = '\x7f';

// Bytes that turn `prev` (already on the pty line) into `next`: backspace the diverging
// suffix, then type the new one. The pty cursor is at the end of the line.
export function diffLine(prev: string, next: string): string {
  let i = 0;
  const max = Math.min(prev.length, next.length);
  while (i < max && prev[i] === next[i]) i++;
  return DEL.repeat(prev.length - i) + next.slice(i);
}
