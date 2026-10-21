import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addPairing, redeemPairing } from '../application/pairing';
import { FilePairingStore } from './file-pairing-store';

let dir: string;
let path: string;
const NOW = new Date();
const secret = (c: string) => c.repeat(43);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perch-pairing-'));
  path = join(dir, 'perch', 'pairing.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('FilePairingStore', () => {
  it('keeps secrets owner-only and reads them back', async () => {
    const store = new FilePairingStore(path);
    await store.update((l) => addPairing(l, secret('a'), NOW));
    expect((await store.read()).map((p) => p.secret)).toEqual([secret('a')]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('leaves the file alone when an update changes nothing', async () => {
    const store = new FilePairingStore(path);
    await store.update((l) => addPairing(l, secret('a'), NOW));
    const before = await stat(path);
    await new Promise((r) => setTimeout(r, 20));
    await store.update((l) => redeemPairing(l, secret('z'), NOW, 'phone').list);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect((await stat(path)).ino).toBe(before.ino);
  });

  it('keeps a spent secret, marked used, so a later attempt with it can be told so', async () => {
    const store = new FilePairingStore(path);
    await store.update((l) => addPairing(l, secret('a'), NOW));
    await store.update((l) => redeemPairing(l, secret('a'), NOW, 'phone').list);
    expect(await store.read()).toEqual([{ secret: secret('a'), expiresAt: NOW.toISOString(), usedAt: NOW.toISOString(), usedBy: 'phone' }]);
  });

  it('lets exactly one of two concurrent redemptions of the same secret win', async () => {
    const a = new FilePairingStore(path);
    const b = new FilePairingStore(path);
    await a.update((l) => addPairing(l, secret('a'), NOW));
    const outcomes: string[] = [];
    const redeem = (store: FilePairingStore, device: string) =>
      store.update((l) => {
        const result = redeemPairing(l, secret('a'), NOW, device);
        outcomes.push(result.outcome);
        return result.list;
      });
    await Promise.all([redeem(a, 'phone'), redeem(b, 'tablet')]);
    expect(outcomes.sort()).toEqual(['redeemed', 'used']);
  });

  it('reads a missing or malformed file as no secrets', async () => {
    const store = new FilePairingStore(path);
    expect(await store.read()).toEqual([]);
    await store.update((l) => l);
    await writeFile(path, '{"secret":"x"}');
    expect(await store.read()).toEqual([]);
  });
});
