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
    expect(setEnvValue(FILE, 'PERCH_PORT', '9000')).toContain('\nPERCH_PORT=9000\n');
    const added = setEnvValue(FILE, 'PERCH_PWA_ORIGIN', 'https://pwa.example:8443');
    expect(parseEnvFile(added).PERCH_PWA_ORIGIN).toBe('https://pwa.example:8443');
  });

  it('adds the missing final newline before appending', () => {
    expect(setEnvValue('A=1', 'B', '2')).toBe('A=1\nB=2\n');
  });
});
