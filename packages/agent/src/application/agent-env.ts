// deploy/agent.env, edited by `tarfa setup`. The file is sourced by bash and hand-edited, so
// edits touch only the one line they are about and keep every other line byte for byte.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

// Reads the forms written here and by hand: plain, "double-quoted", or a run of 'single-quoted'
// pieces joined by \' (how setEnvValue writes a quote). Not a full bash parser: no trailing
// comments, no expansion.
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') return value.slice(1, -1);
  if (value[0] !== "'") return value;
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === "'") {
      const end = value.indexOf("'", i + 1);
      if (end === -1) return value;
      out += value.slice(i + 1, end);
      i = end + 1;
    } else if (value[i] === '\\' && i + 1 < value.length) {
      out += value[i + 1];
      i += 2;
    } else {
      out += value[i];
      i += 1;
    }
  }
  return out;
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = LINE.exec(line);
    if (match) values[match[1]!] = unquote(match[2]!);
  }
  return values;
}

// Every value is single-quoted, so nothing in it (a `$(…)`, a backtick, a `;`) runs when bash
// sources the file.
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function setEnvValue(text: string, name: string, value: string): string {
  const line = `${name}=${shellQuote(value)}`;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => LINE.exec(l)?.[1] === name);
  if (at !== -1) {
    lines[at] = line;
    return lines.join('\n');
  }
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${line}\n`;
}
