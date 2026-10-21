import { describe, expect, it } from 'vitest';
import { JOIN_HEADER, accountId, generateAgentKeys, generateJoinKey, signAgentAuth, signJoinAuth } from '@perch/secure-channel';
import {
  JoinRateLimiter,
  MemoryRegistry,
  handleAdminRequest,
  parseAdminRequest,
  type AdminDeps,
  type AdminRequest,
} from './registry.ts';

const NOW = 1_800_000_000_000;
const joinKey = generateJoinKey();
const adminKey = generateJoinKey();
const agent = generateAgentKeys();
const account = accountId(agent.ed25519.publicKey);

function joinRequest(options: { key?: string; signWith?: string; joinWith?: string; account?: string; now?: number } = {}): AdminRequest {
  const acct = options.account ?? account;
  const now = options.now ?? NOW;
  return {
    role: 'join',
    account: acct,
    key: options.key ?? agent.ed25519.publicKey,
    authorization: signAgentAuth(options.signWith ?? agent.ed25519.privateKey, { account: acct, role: 'join' }, now),
    join: signJoinAuth(options.joinWith ?? joinKey, { account: acct, role: 'join' }, now),
  };
}

function setup(overrides: Partial<AdminDeps> = {}) {
  const registry = new MemoryRegistry();
  const evicted: string[] = [];
  const deps: AdminDeps = {
    registry,
    joinKey,
    adminKey,
    limiter: new JoinRateLimiter({ max: 100, windowMs: 60_000 }, () => NOW),
    now: () => NOW,
    evict: (acct) => void evicted.push(acct),
    reinstate: (acct) => void reinstated.push(acct),
    ...overrides,
  };
  const reinstated: string[] = [];
  const handle = (request: AdminRequest, address = '203.0.113.7') => handleAdminRequest(request, address, deps);
  return { registry, evicted, reinstated, handle };
}

describe('parseAdminRequest', () => {
  const headers = (h: Record<string, string>) => (name: string) => h[name];

  it('reads a join: POST to the account, the agent key in the query, both headers', () => {
    const request = parseAdminRequest(`/${account}?role=join&key=${agent.ed25519.publicKey}`, 'POST', headers({ authorization: 'a', [JOIN_HEADER]: 'j' }));
    expect(request).toEqual({ role: 'join', account, key: agent.ed25519.publicKey, authorization: 'a', join: 'j' });
  });

  it('reads the list at the root and a remove on the account', () => {
    expect(parseAdminRequest('/?role=machines', 'GET', headers({ [JOIN_HEADER]: 'j' }))).toEqual({ role: 'machines', account: '*', join: 'j' });
    expect(parseAdminRequest(`/${account}?role=remove`, 'POST', headers({}))).toEqual({ role: 'remove', account, join: undefined });
  });

  it('reads an allow on the account', () => {
    expect(parseAdminRequest(`/${account}?role=allow`, 'POST', headers({ [JOIN_HEADER]: 'j' }))).toEqual({ role: 'allow', account, join: 'j' });
    expect(parseAdminRequest(`/${account}?role=allow`, 'GET', headers({}))).toBe(null);
  });

  it('is null for everything else, so the relay roles are parsed as before', () => {
    expect(parseAdminRequest(`/${account}?role=join&key=x`, 'GET', headers({}))).toBe(null);
    expect(parseAdminRequest(`/${account}?role=join`, 'POST', headers({}))).toBe(null);
    expect(parseAdminRequest(`/${account}?role=remove`, 'GET', headers({}))).toBe(null);
    expect(parseAdminRequest(`/${account}?role=machines`, 'GET', headers({}))).toBe(null);
    expect(parseAdminRequest(`/${account}?role=agent`, 'POST', headers({}))).toBe(null);
    expect(parseAdminRequest(`/a/b?role=join&key=x`, 'POST', headers({}))).toBe(null);
  });
});

describe('handleAdminRequest: join', () => {
  it('registers an account signed by its own key and carrying the join key', async () => {
    const { registry, handle } = setup();
    expect((await handle(joinRequest())).status).toBe(201);
    expect(await registry.lookup(account)).toBe(agent.ed25519.publicKey);
  });

  it('answers 200 to a machine that joins again, and keeps its first registration', async () => {
    const { registry, handle } = setup();
    await handle(joinRequest());
    const [first] = await registry.list();
    expect((await handle(joinRequest({ now: NOW + 5000 }))).status).toBe(200);
    expect(await registry.list()).toEqual([first]);
  });

  it('refuses a wrong join key with 401 and registers nothing', async () => {
    const { registry, handle } = setup();
    expect((await handle(joinRequest({ joinWith: generateJoinKey() }))).status).toBe(401);
    expect(await registry.list()).toEqual([]);
  });

  it('refuses a missing join header or agent signature with 401', async () => {
    const { handle } = setup();
    expect((await handle({ ...joinRequest(), join: undefined })).status).toBe(401);
    expect((await handle({ ...(joinRequest() as Extract<AdminRequest, { role: 'join' }>), authorization: undefined })).status).toBe(401);
  });

  it('refuses a signature by another key than the one registered, with 401', async () => {
    const { handle } = setup();
    expect((await handle(joinRequest({ signWith: generateAgentKeys().ed25519.privateKey }))).status).toBe(401);
  });

  it('refuses an account that is not derived from the key, so nobody picks an account id', async () => {
    const { registry, handle } = setup();
    expect((await handle(joinRequest({ account: 'chosen-name' }))).status).toBe(400);
    expect((await handle(joinRequest({ key: 'not-a-key' }))).status).toBe(400);
    expect(await registry.list()).toEqual([]);
  });

  it('refuses a small-order agent key with 400, whatever signature comes with it', async () => {
    const { registry, handle } = setup();
    const identity = 'AQ' + 'A'.repeat(41);
    const forged = `Perch-Agent ${NOW / 1000}.${'AQ' + 'A'.repeat(84)}`;
    const request = { ...(joinRequest({ key: identity, account: accountId(identity) }) as Extract<AdminRequest, { role: 'join' }>), authorization: forged };
    expect((await handle(request)).status).toBe(400);
    expect(await registry.list()).toEqual([]);
  });

  it('refuses a stale request with 401', async () => {
    const { handle } = setup();
    expect((await handle(joinRequest({ now: NOW - 120_000 }))).status).toBe(401);
  });

  it('answers 501 when the relay has no join key, so the machine knows joining is off', async () => {
    const { handle } = setup({ joinKey: undefined });
    expect((await handle(joinRequest())).status).toBe(501);
  });
});

describe('handleAdminRequest: machines and remove', () => {
  const list = (key = adminKey, now = NOW): AdminRequest => ({ role: 'machines', account: '*', join: signJoinAuth(key, { account: '*', role: 'machines' }, now) });
  const remove = (acct = account, key = adminKey): AdminRequest => ({ role: 'remove', account: acct, join: signJoinAuth(key, { account: acct, role: 'remove' }, NOW) });
  const allow = (acct = account, key = adminKey): AdminRequest => ({ role: 'allow', account: acct, join: signJoinAuth(key, { account: acct, role: 'allow' }, NOW) });

  it('lists the registered accounts for the admin key holder', async () => {
    const { handle } = setup();
    await handle(joinRequest());
    const res = await handle(list());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ account, key: agent.ed25519.publicKey, addedAt: new Date(NOW).toISOString() }]);
    expect((await handle(list(generateJoinKey()))).status).toBe(401);
  });

  it('removes an account and evicts what it holds on the relay', async () => {
    const { registry, evicted, handle } = setup();
    await handle(joinRequest());
    expect((await handle(remove())).status).toBe(200);
    expect(await registry.lookup(account)).toBe(undefined);
    expect(evicted).toEqual([account]);
    expect((await handle(remove())).status).toBe(404);
  });

  // A thief holding the account's agent key and the join key (handed to every machine) must not
  // get a removed account back: only the admin key lifts a removal.
  it('refuses a removed account that joins again, until the admin key allows it', async () => {
    const { registry, reinstated, handle } = setup();
    await handle(joinRequest());
    await handle(remove());
    const refused = await handle(joinRequest({ now: NOW + 1000 }));
    expect(refused.status).toBe(403);
    expect(await registry.lookup(account)).toBe(undefined);
    expect((await handle(allow(account, joinKey))).status).toBe(401);
    expect((await handle(allow())).status).toBe(200);
    expect((await handle(joinRequest({ now: NOW + 2000 }))).status).toBe(201);
    expect(await registry.lookup(account)).toBe(agent.ed25519.publicKey);
    expect(reinstated).toEqual([account, account]);
  });

  it('answers 404 to an allow for an account that was never removed', async () => {
    const { handle } = setup();
    expect((await handle(allow())).status).toBe(404);
  });

  it('lists a removed account with when it was removed, so the operator sees what an allow would lift', async () => {
    const { handle } = setup();
    await handle(joinRequest());
    await handle(remove());
    const res = await handle(list());
    expect(JSON.parse(res.body)).toEqual([
      { account, key: agent.ed25519.publicKey, addedAt: new Date(NOW).toISOString(), removedAt: new Date(NOW).toISOString() },
    ]);
  });

  it('refuses a remove with a header made for another account', async () => {
    const { registry, handle } = setup();
    await handle(joinRequest());
    const forOther = signJoinAuth(adminKey, { account: 'other', role: 'remove' }, NOW);
    expect((await handle({ role: 'remove', account, join: forOther })).status).toBe(401);
    expect(await registry.lookup(account)).toBe(agent.ed25519.publicKey);
  });
});

describe('handleAdminRequest: the admin key', () => {
  // A leaked join key lets strangers register machines of their own; it must not also let them
  // see or remove anyone else's.
  it('refuses a list or a remove signed with the join key', async () => {
    const { registry, handle } = setup();
    await handle(joinRequest());
    expect((await handle({ role: 'machines', account: '*', join: signJoinAuth(joinKey, { account: '*', role: 'machines' }, NOW) })).status).toBe(401);
    expect((await handle({ role: 'remove', account, join: signJoinAuth(joinKey, { account, role: 'remove' }, NOW) })).status).toBe(401);
    expect(await registry.lookup(account)).toBe(agent.ed25519.publicKey);
  });

  it('refuses a join signed with the admin key', async () => {
    const { handle } = setup();
    expect((await handle(joinRequest({ joinWith: adminKey }))).status).toBe(401);
  });

  it('answers 501 to a list or a remove when the relay has no admin key, and still lets machines join', async () => {
    const { handle } = setup({ adminKey: undefined });
    expect((await handle(joinRequest())).status).toBe(201);
    expect((await handle({ role: 'machines', account: '*', join: signJoinAuth(adminKey, { account: '*', role: 'machines' }, NOW) })).status).toBe(501);
    expect((await handle({ role: 'remove', account, join: signJoinAuth(adminKey, { account, role: 'remove' }, NOW) })).status).toBe(501);
  });
});

describe('join rate limit', () => {
  it('refuses the requests of one address past the limit with 429, whatever they carry', async () => {
    const { handle } = setup({ limiter: new JoinRateLimiter({ max: 2, windowMs: 60_000 }, () => NOW) });
    expect((await handle(joinRequest({ joinWith: generateJoinKey() }))).status).toBe(401);
    expect((await handle(joinRequest({ joinWith: generateJoinKey() }))).status).toBe(401);
    expect((await handle(joinRequest())).status).toBe(429);
    expect((await handle(joinRequest(), '198.51.100.1')).status).toBe(201);
  });

  it('opens again once the window has passed', () => {
    let now = NOW;
    const limiter = new JoinRateLimiter({ max: 1, windowMs: 60_000 }, () => now);
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    now += 60_000;
    expect(limiter.take('a')).toBe(true);
  });

  it('forgets old addresses, so a flood of them cannot grow it without bound', () => {
    let now = NOW;
    const limiter = new JoinRateLimiter({ max: 1, windowMs: 1000 }, () => now);
    for (let i = 0; i < 5000; i += 1) limiter.take(`a${i}`);
    now += 1000;
    limiter.take('fresh');
    expect(limiter.size).toBe(1);
  });

  // Every window still live: pruning frees nothing, so the oldest window goes. Refusing instead
  // would lock the owner out of joins for the whole window under a flood.
  it('stays bounded while every window is live, dropping the oldest', () => {
    const limiter = new JoinRateLimiter({ max: 1, windowMs: 600_000 }, () => NOW);
    expect(limiter.take('first')).toBe(true);
    expect(limiter.take('kept')).toBe(true);
    for (let i = 0; i < 20_000; i += 1) limiter.take(`a${i}`);
    expect(limiter.size).toBeLessThanOrEqual(4096);
    expect(limiter.take('first')).toBe(true);
  });

  it('counts a renewed window as new, so eviction does not drop an address it just renewed', () => {
    let now = NOW;
    const limiter = new JoinRateLimiter({ max: 1, windowMs: 1000 }, () => now);
    limiter.take('renewed');
    now += 500;
    for (let i = 0; i < 4094; i += 1) limiter.take(`a${i}`);
    now += 600;
    limiter.take('renewed');
    now += 100;
    limiter.take('one-more');
    expect(limiter.take('renewed')).toBe(false);
  });
});
