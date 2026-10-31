// OSC 52 is how a terminal program sets the clipboard (Claude Code's /copy, vim, tmux):
// `ESC ] 52 ; <selection> ; <base64> BEL`. xterm.js hands the handler everything after `52;`.
// A `?` payload asks the terminal to report its clipboard; that is never answered, since any
// program in a workspace could read the phone's clipboard with it.
export function parseOsc52(data: string): string | null {
  const sep = data.indexOf(';');
  if (sep < 0) return null;
  const payload = data.slice(sep + 1);
  if (!payload || payload === '?') return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes) || null;
}
