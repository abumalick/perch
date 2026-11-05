import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parseEnvFile, setEnvValue } from './agent-env';

const FILE = `# Perch agent
PERCH_TOKEN=abc123
PERCH_MACHINE_ID="dev box"
export PERCH_PORT=8787
# PERCH_PHONE_ADDRESSES=wss://commented.example
`;

describe('parseEnvFile', () => {
  it('reads assignments, quoted or exported, and skips comments', () => {
    expect(parseEnvFile(FILE)).toEqual({ PERCH_TOKEN: 'abc123', PERCH_MACHINE_ID: 'dev box', PERCH_PORT: '8787' });
  });

  it("reads single quotes literally, as bash would", () => {
    expect(parseEnvFile(`A='{"x":"y"}'\n`)).toEqual({ A: '{"x":"y"}' });
  });
});

describe('setEnvValue', () => {
  it('replaces an existing value in place, or appends a new one', () => {
    expect(setEnvValue(FILE, 'PERCH_PORT', '9000')).toContain("\nPERCH_PORT='9000'\n");
    const added = setEnvValue(FILE, 'PERCH_PWA_ORIGIN', 'https://pwa.example:8443');
    expect(parseEnvFile(added).PERCH_PWA_ORIGIN).toBe('https://pwa.example:8443');
  });

  it('adds the missing final newline before appending', () => {
    expect(setEnvValue('A=1', 'B', '2')).toBe("A=1\nB='2'\n");
  });
});

describe('setEnvValue quoting', () => {
  const sourced = (text: string, name: string) =>
    execFileSync('bash', ['-c', `${text}\nprintf '%s' "$${name}"`], { encoding: 'utf8', env: {} });

  it('single-quotes every value, so bash reads a $(…) payload as text', () => {
    const value = 'wss://$(echo injected).example.com/`id`;x';
    const text = setEnvValue('', 'PERCH_PHONE_ADDRESSES', value);
    expect(text).toBe(`PERCH_PHONE_ADDRESSES='${value}'\n`);
    expect(sourced(text, 'PERCH_PHONE_ADDRESSES')).toBe(value);
    expect(parseEnvFile(text).PERCH_PHONE_ADDRESSES).toBe(value);
  });

  it('escapes a single quote the way bash reads it back', () => {
    const value = "it's 'quoted'";
    const text = setEnvValue('A=1\n', 'B', value);
    expect(text).toBe("A=1\nB='it'\\''s '\\''quoted'\\'''\n");
    expect(sourced(text, 'B')).toBe(value);
    expect(parseEnvFile(text).B).toBe(value);
  });
});
