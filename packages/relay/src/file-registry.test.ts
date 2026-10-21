import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountId, generateAgentKeys } from '@perch/secure-channel';
import { openFileRegistry } from './file-registry.ts';

const keys = generateAgentKeys();
const account = accountId(keys.ed25519.publicKey);

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-registry-'));
  path = join(dir, 'relay', 'accounts.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('openFileRegistry', () => {
  it('starts empty without a file, and writes it owner-only on the first join', async () => {
    const registry = await openFileRegistry(path);
    expect(await registry.list()).toEqual([]);
    await registry.add({ account, key: keys.ed25519.publicKey, addedAt: 'now' });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ accounts: { [account]: { key: keys.ed25519.publicKey, addedAt: 'now' } }, removed: {} });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('keeps what joined and what was removed across a restart', async () => {
    const first = await openFileRegistry(path);
    await first.add({ account, key: keys.ed25519.publicKey, addedAt: 'then' });
    const other = generateAgentKeys();
    const otherAccount = accountId(other.ed25519.publicKey);
    await first.add({ account: otherAccount, key: other.ed25519.publicKey, addedAt: 'now' });
    await first.remove(account, 'later');
    const second = await openFileRegistry(path);
    expect(await second.lookup(otherAccount)).toBe(other.ed25519.publicKey);
    expect(await second.lookup(account)).toBe(undefined);
    expect(await second.add({ account, key: keys.ed25519.publicKey, addedAt: 'again' })).toBe('removed');
    expect(await second.removedAccounts()).toEqual([{ account, key: keys.ed25519.publicKey, addedAt: 'then', removedAt: 'later' }]);
  });

  it('refuses a malformed removed list too', async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ accounts: {}, removed: { [account]: { key: 'nope' } } }));
    await expect(openFileRegistry(path)).rejects.toThrow(/malformed/);
  });

  it('loads a file that still lists the accounts once seeded, keeping every account', async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ accounts: { [account]: { key: keys.ed25519.publicKey, addedAt: 'then' } }, seeded: [account] }));
    const registry = await openFileRegistry(path);
    expect(await registry.list()).toEqual([{ account, key: keys.ed25519.publicKey, addedAt: 'then' }]);
  });

  it('refuses a malformed file instead of serving nobody, or everybody', async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"accounts": "all"}');
    await expect(openFileRegistry(path)).rejects.toThrow(/malformed/);
  });
});
