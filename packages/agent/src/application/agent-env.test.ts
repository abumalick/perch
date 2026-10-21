import { describe, expect, it } from 'vitest';
import { addRelayUrl, parseEnvFile, setEnvValue } from './agent-env';

const FILE = `# Perch agent
PERCH_TOKEN=abc123
PERCH_MACHINE_ID="dev box"
export PERCH_PORT=8787
# PERCH_RELAY_URLS=wss://commented.example
`;

describe('parseEnvFile', () => {
  it('reads assignments, quoted or exported, and skips comments', () => {
    expect(parseEnvFile(FILE)).toEqual({ PERCH_TOKEN: 'abc123', PERCH_MACHINE_ID: 'dev box', PERCH_PORT: '8787' });
  });

  it("reads single quotes literally, as bash would", () => {
    expect(parseEnvFile(`A='{"x":"y"}'\n`)).toEqual({ A: '{"x":"y"}' });
  });
});

describe('addRelayUrl', () => {
  it('adds PERCH_RELAY_URLS when there is none, leaving everything else as it was', () => {
    const { text, changed } = addRelayUrl(FILE, 'wss://relay.example/');
    expect(changed).toBe(true);
    expect(text.startsWith(FILE)).toBe(true);
    expect(parseEnvFile(text).PERCH_RELAY_URLS).toBe('wss://relay.example');
  });

  it('appends to an existing list', () => {
    const { text } = addRelayUrl(`${FILE}PERCH_RELAY_URLS=ws://127.0.0.1:8450\n`, 'wss://relay.example');
    expect(parseEnvFile(text).PERCH_RELAY_URLS).toBe('ws://127.0.0.1:8450,wss://relay.example');
    expect(text.match(/^PERCH_RELAY_URLS=/gm)).toHaveLength(1);
  });

  it('changes nothing when the relay is already listed', () => {
    const file = `${FILE}PERCH_RELAY_URLS=wss://a.example, wss://relay.example/\n`;
    expect(addRelayUrl(file, 'wss://relay.example')).toEqual({ text: file, changed: false });
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
