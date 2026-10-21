// A plain-text copy of the terminal buffer (scrollback included) for select mode, which the
// PWA shows in an ordinary scrollable element so every platform's native text selection works
// on it. xterm keeps its own rows unselectable, rebuilds them on every redraw (which collapses
// a native selection) and has only the visible screen in the DOM.
//
// Lines come back whole in two steps. A line the terminal wrapped is stored as several rows,
// each continuation marked `isWrapped`; those are joined exactly. A row followed by a
// continuation is read untrimmed, or a space at the wrap point would be lost.
//
// Claude Code (and Codex) wrap their own text instead: each row arrives as a separate line,
// with the indent repeated and the space at the break dropped, so the terminal holds nothing
// to tell such a break from a real newline. `reflow` rebuilds those paragraphs by inference.

export interface SnapshotLine {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface SnapshotBuffer {
  readonly length: number;
  readonly viewportY: number;
  getLine(y: number): SnapshotLine | undefined;
}

export interface SnapshotText {
  text: string;
  // Columns the continuation rows of a rebuilt paragraph were indented by, so it can be
  // displayed with the same hanging indent; 0 for a line that was not rebuilt.
  hang: number;
}

export interface TerminalSnapshot {
  lines: SnapshotText[];
  // The line holding the viewport's top row, so the snapshot opens where the user was.
  viewportLine: number;
}

interface Logical {
  text: string;
  firstRow: number;
  rows: number;
}

export function snapshotBuffer(buffer: SnapshotBuffer, cols: number): TerminalSnapshot {
  const logical: Logical[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const continued = buffer.getLine(y + 1)?.isWrapped ?? false;
    const text = line.translateToString(!continued);
    const last = logical[logical.length - 1];
    if (line.isWrapped && last) {
      last.text += text;
      last.rows++;
    } else logical.push({ text, firstRow: y, rows: 1 });
  }
  while (logical.at(-1)?.text === '') logical.pop();

  const paragraphs = reflow(logical, cols);
  let viewportLine = 0;
  paragraphs.forEach((p, i) => {
    if (p.firstRow <= buffer.viewportY) viewportLine = i;
  });
  return { lines: paragraphs.map(({ text, hang }) => ({ text, hang })), viewportLine };
}

// A line that opens an item: its continuation rows line up under the item's text ("- foo")
// or under the marker itself ("• foo"), so both indents are accepted.
const ITEM = /^(?:[-*+•●⏺⎿]\s+|\d+[.)]\s+)/;
// A line that must never be joined to the one above it.
const NEW_ITEM = /^(?:[-*+•●⏺⎿❯✻]|\d+[.)]\s|[│├└┌┐┘┤┬┴┼╭╮╯╰─])/;
// A line nothing is joined onto: a table row, or the prompt line, whose box wraps narrower.
const UNJOINABLE = /^[❯│├└┌┐┘┤┬┴┼╭╮╯╰─]/;

const indentOf = (s: string) => s.length - s.trimStart().length;
const firstToken = (s: string) => s.trimStart().split(' ')[0] ?? '';
const lastToken = (s: string) => s.slice(s.lastIndexOf(' ') + 1);

interface Paragraph extends Logical {
  hang: number;
  lastRowLength: number;
  hangs: number[];
}

// An app that wraps text breaks a row only when the next word does not fit, so a break is
// taken as the app's own when the row plus a space plus the next word exceeds the width, and
// the next row is indented as a continuation and does not open a new item. Measured on Claude
// Code: it wraps at exactly the terminal width. A row filled to the last column whose last
// token cannot fit on any row (a long URL or command) was cut mid-token, so it rejoins with
// no space. Rows the terminal wrapped itself are already whole when they get here.
function reflow(lines: Logical[], cols: number): Paragraph[] {
  const out: Paragraph[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const lastRowLength = line.text.length - (line.rows - 1) * cols;
    if (prev && joins(prev, line.text, cols)) {
      const indent = indentOf(line.text);
      const rest = line.text.slice(indent);
      const cut = prev.lastRowLength === cols && lastToken(prev.text).length + firstToken(rest).length > cols - indent;
      prev.text += (cut ? '' : ' ') + rest;
      prev.hang = indent;
      prev.hangs = [indent];
      prev.lastRowLength = lastRowLength;
      prev.rows += line.rows;
      continue;
    }
    const trimmed = line.text.trimStart();
    const indent = indentOf(line.text);
    const item = ITEM.exec(trimmed);
    out.push({
      ...line,
      hang: 0,
      lastRowLength,
      hangs: item ? [indent, indent + item[0].length] : [indent],
    });
  }
  return out;
}

function joins(prev: Paragraph, next: string, cols: number): boolean {
  if (prev.text.trim() === '' || next.trim() === '') return false;
  if (UNJOINABLE.test(prev.text.trimStart())) return false;
  const rest = next.trimStart();
  if (NEW_ITEM.test(rest)) return false;
  const indent = indentOf(next);
  if (!prev.hangs.includes(indent)) return false;
  const token = firstToken(rest).length;
  // A token too long for any row says nothing about whether it fitted, unless the row
  // before was filled to the edge: then it was cut there.
  if (token > cols - indent) return prev.lastRowLength === cols;
  return prev.lastRowLength + 1 + token > cols;
}

// What the OS copies from the snapshot keeps the terminal's left margin (Claude Code indents
// its whole reply), so a copy drops the indent the selected lines share. A first line with no
// indent is left out of the measure: the selection most likely started mid-line.
export function dedentCopied(text: string): string {
  const lines = text.split('\n');
  if (lines.length === 1) return text.trimStart();
  const [first = '', ...rest] = lines;
  const measured = (indentOf(first) > 0 ? lines : rest).filter((l) => l.trim() !== '');
  const shared = measured.length > 0 ? Math.min(...measured.map(indentOf)) : 0;
  return lines.map((l) => l.slice(Math.min(shared, indentOf(l)))).join('\n');
}
