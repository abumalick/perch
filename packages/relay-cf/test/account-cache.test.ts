import { describe, expect, it } from 'vitest';
import { accountId, generateAgentKeys, signAgentAuth } from '@perch/secure-channel';
import { AccountCache, authorizeCached } from '../src/account-cache';

function setup(maxEntries = 4) {
  let now = 1_000_000;
  const registry = new Map<string, string>();
  let asked = 0;
  const cache = new AccountCache({ now: () => now, hitMs: 60_000, missMs: 10_000, maxEntries });
  const ask = async (a: string) => {
    asked += 1;
    return registry.get(a);
  };
  const lookup = (account: string) => cache.lookup(account, ask);
  return { registry, cache, ask, lookup, asked: () => asked, now: () => now, advance: (ms: number) => (now += ms) };
}

describe('AccountCache', () => {
  it('answers a miss from memory for a short while, so a repeated guess does not reach the registry', async () => {
    const c = setup();
    expect(await c.lookup('guess')).toBe(undefined);
    expect(await c.lookup('guess')).toBe(undefined);
    expect(c.asked()).toBe(1);
    c.advance(10_000);
    expect(await c.lookup('guess')).toBe(undefined);
    expect(c.asked()).toBe(2);
  });

  it('forgets a miss when a machine joins through this isolate, so it is found at once', async () => {
    const c = setup();
    await c.lookup('new');
    c.registry.set('new', 'key');
    c.cache.joined('new');
    expect(await c.lookup('new')).toBe('key');
  });

  it('answers a hit from memory until it expires', async () => {
    const c = setup();
    c.registry.set('acct', 'key');
    await c.lookup('acct');
    await c.lookup('acct');
    expect(c.asked()).toBe(1);
    c.advance(60_000);
    await c.lookup('acct');
    expect(c.asked()).toBe(2);
  });

  it('forgets a removed account at once', async () => {
    const c = setup();
    c.registry.set('acct', 'key');
    await c.lookup('acct');
    c.registry.delete('acct');
    c.cache.removed('acct');
    expect(await c.lookup('acct')).toBe(undefined);
  });

  // A stranger's distinct guesses are all misses: they must never push the owner's hit out, or the
  // owner's next request would join the flood at the registry.
  it('keeps its hits through any number of guesses, and stays bounded', async () => {
    const c = setup();
    c.registry.set('acct', 'key');
    await c.lookup('acct');
    for (let i = 0; i < 100; i += 1) await c.lookup(`guess-${i}`);
    const asked = c.asked();
    expect(await c.lookup('acct')).toBe('key');
    expect(c.asked()).toBe(asked);
    expect(c.cache.size).toBeLessThanOrEqual(8);
  });

  it('drops the least recently used hit once full', async () => {
    const c = setup(2);
    for (const a of ['a', 'b', 'c']) c.registry.set(a, `key-${a}`);
    await c.lookup('a');
    await c.lookup('b');
    await c.lookup('a');
    await c.lookup('c');
    const asked = c.asked();
    await c.lookup('a');
    expect(c.asked()).toBe(asked);
    await c.lookup('b');
    expect(c.asked()).toBe(asked + 1);
  });
});

describe('authorizeCached', () => {
  const keys = generateAgentKeys();
  const account = accountId(keys.ed25519.publicKey);
  const signed = (now: number, key = keys.ed25519.privateKey) => signAgentAuth(key, { account, role: 'agent' }, now);

  function warm() {
    const c = setup();
    c.registry.set(account, keys.ed25519.publicKey);
    return c;
  }

  it('serves a challenge from a cached hit', async () => {
    const c = warm();
    await c.lookup(account);
    expect(await authorizeCached({ role: 'challenge', account }, c.cache, c.ask, c.now())).toBe(null);
    expect(c.asked()).toBe(1);
  });

  // Only the holder of the agent key can make a control socket reach the registry: a forged
  // signature is refused against the cached key.
  it('refuses a forged control socket against a cached hit, without asking the registry', async () => {
    const c = warm();
    await c.lookup(account);
    const forged = signed(c.now(), generateAgentKeys().ed25519.privateKey);
    expect(await authorizeCached({ role: 'agent', account, authorization: forged }, c.cache, c.ask, c.now())).toBe(401);
    expect(c.asked()).toBe(1);
  });

  it('confirms a signed control socket with the registry, so a removed account cannot come back through a stale hit', async () => {
    const c = warm();
    await c.lookup(account);
    expect(await authorizeCached({ role: 'agent', account, authorization: signed(c.now()) }, c.cache, c.ask, c.now())).toBe(null);
    expect(c.asked()).toBe(2);
    c.registry.delete(account);
    expect(await authorizeCached({ role: 'agent', account, authorization: signed(c.now()) }, c.cache, c.ask, c.now())).toBe(404);
    expect(await c.lookup(account)).toBe(undefined);
  });

  it('asks the registry only once for a control socket whose account was not cached', async () => {
    const c = warm();
    expect(await authorizeCached({ role: 'agent', account, authorization: signed(c.now()) }, c.cache, c.ask, c.now())).toBe(null);
    expect(c.asked()).toBe(1);
  });
});
