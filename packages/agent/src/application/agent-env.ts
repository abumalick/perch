// deploy/agent.env, edited by `perch connect`. The file is sourced by bash and hand-edited, so
// edits touch only the one line they are about and keep every other line byte for byte.
import { withoutTrailingSlash } from './relay-url';

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

const normalize = (url: string) => withoutTrailingSlash(url.trim());
const listOf = (value: string | undefined) => (value ?? '').split(/[\s,]+/).map(normalize).filter(Boolean);

// Adds a relay to PERCH_RELAY_URLS unless the agent already holds it.
export function addRelayUrl(text: string, url: string): { text: string; changed: boolean } {
  const values = parseEnvFile(text);
  const wanted = normalize(url);
  const held = listOf(values.PERCH_RELAY_URLS);
  if (held.includes(wanted)) return { text, changed: false };
  return { text: setEnvValue(text, 'PERCH_RELAY_URLS', [...held, wanted].join(',')), changed: true };
}
