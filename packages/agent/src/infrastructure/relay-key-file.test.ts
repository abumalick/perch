import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateRelayKeys } from './relay-key-file';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function keyPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'perch-relay-key-'));
  dirs.push(dir);
  return join(dir, '.perch', 'relay-key.json');
}

describe('relay key file', () => {
  it('creates the key file owner-only on first use, in a directory that may not exist yet', async () => {
    const path = await keyPath();
    const keys = await loadOrCreateRelayKeys(path);
    expect(keys.x25519.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(keys);
  });

  it('reuses the existing keys on the next call', async () => {
    const path = await keyPath();
    const first = await loadOrCreateRelayKeys(path);
    expect(await loadOrCreateRelayKeys(path)).toEqual(first);
  });

  it('refuses a malformed key file rather than replacing the identity', async () => {
    const path = await keyPath();
    await loadOrCreateRelayKeys(path);
    await writeFile(path, '{"x25519":{}}');
    await expect(loadOrCreateRelayKeys(path)).rejects.toThrow(/relay key file/);
    expect(await readFile(path, 'utf8')).toBe('{"x25519":{}}');
  });
});
