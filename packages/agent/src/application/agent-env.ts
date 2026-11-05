// deploy/agent.env, edited by `tarfa setup`. The file is sourced by bash and hand-edited, so
// edits touch only the one line they are about and keep every other line byte for byte.

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) return value.slice(1, -1);
  return value;
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = LINE.exec(line);
    if (match) values[match[1]!] = unquote(match[2]!);
  }
  return values;
}

// Values written here are URLs and origins, which need no quoting in bash.
export function setEnvValue(text: string, name: string, value: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => LINE.exec(line)?.[1] === name);
  if (at !== -1) {
    lines[at] = `${name}=${value}`;
    return lines.join('\n');
  }
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${name}=${value}\n`;
}
