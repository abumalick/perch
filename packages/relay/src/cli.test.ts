import { describe, expect, it } from 'vitest';
import { JOIN_HEADER, generateJoinKey, verifyJoinAuth } from '@perch/secure-channel';
import { runRelayCli, type RelayCliDeps } from './cli.ts';

function deps(config: Record<string, unknown> | null, responses: Array<{ status: number; body: string }> = []) {
  const written: string[] = [];
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const d: RelayCliDeps = {
    configPath: '/home/u/.perch/relay/config.json',
    readConfig: async () => (config === null ? null : JSON.stringify(config)),
    writeConfig: async (text) => void written.push(text),
    fetch: async (url, init) => {
      requests.push({ url, method: init.method, headers: init.headers });
      return responses.shift() ?? { status: 500, body: '' };
    },
    now: () => Date.now(),
    env: {},
  };
  return { d, written, requests };
}

describe('perch-relay join-command', () => {
  it('prints the machine command with the relay URL and the join key', async () => {
    const joinKey = generateJoinKey();
    const { d, written } = deps({ joinKey, port: 8450 });
    const out = await runRelayCli(['join-command', '--url', 'wss://relay.example:8451'], d);
    expect(out).toContain(`PERCH_JOIN_KEY=${joinKey} pnpm perch connect wss://relay.example:8451`);
    expect(written).toEqual([]);
  });

  it('defaults to the relay on this machine', async () => {
    const joinKey = generateJoinKey();
    const { d } = deps({ joinKey, port: 9000 });
    expect(await runRelayCli(['join-command'], d)).toContain(`PERCH_JOIN_KEY=${joinKey} pnpm perch connect ws://127.0.0.1:9000`);
  });

  it('creates a join key once, keeping the rest of the config, and says to restart', async () => {
    const { d, written } = deps({ port: 8450, host: '127.0.0.1' });
    const out = await runRelayCli(['join-command'], d);
    expect(written).toHaveLength(1);
    const saved = JSON.parse(written[0]!) as { joinKey: string; port: number; host: string };
    expect(saved).toMatchObject({ port: 8450, host: '127.0.0.1' });
    expect(out).toContain(`PERCH_JOIN_KEY=${saved.joinKey} `);
    expect(out).toMatch(/restart/i);
  });

  it('refuses without a config file', async () => {
    await expect(runRelayCli(['join-command'], deps(null).d)).rejects.toThrow(/config/);
  });
});

describe('perch-relay admin-key', () => {
  it('creates the admin key once, keeping the rest of the config, says to restart, and prints it', async () => {
    const { d, written } = deps({ port: 8450, joinKey: generateJoinKey() });
    const out = await runRelayCli(['admin-key'], d);
    const saved = JSON.parse(written[0]!) as { adminKey: string; port: number; joinKey: string };
    expect(saved).toMatchObject({ port: 8450 });
    expect(saved.adminKey === saved.joinKey).toBe(false);
    expect(out).toContain(saved.adminKey);
    expect(out).toMatch(/restart/i);
    const again = deps({ adminKey: saved.adminKey });
    expect(await runRelayCli(['admin-key'], again.d)).toContain(saved.adminKey);
    expect(again.written).toHaveLength(0);
  });
});

describe('perch-relay machines', () => {
  const adminKey = generateJoinKey();
  const joinKey = generateJoinKey();

  it('lists the machines of the local relay, signed with its admin key', async () => {
    const entries = [{ account: 'acct1', key: 'k', addedAt: '2026-09-26T10:00:00.000Z' }];
    const { d, requests } = deps({ joinKey, adminKey, port: 8450 }, [{ status: 200, body: JSON.stringify(entries) }]);
    const out = await runRelayCli(['machines', 'list'], d);
    expect(out).toContain('acct1');
    expect(requests[0]!.url).toBe('http://127.0.0.1:8450/?role=machines');
    expect(verifyJoinAuth(requests[0]!.headers[JOIN_HEADER], adminKey, { account: '*', role: 'machines' }, Date.now())).toBe(true);
  });

  it('says how to create an admin key when the local relay has none', async () => {
    await expect(runRelayCli(['machines', 'list'], deps({ joinKey }).d)).rejects.toThrow(/admin-key/);
  });

  it('removes a machine from a remote relay given its URL and PERCH_ADMIN_KEY, without any config', async () => {
    const { d, requests } = deps(null, [{ status: 200, body: 'removed' }]);
    d.env = { PERCH_ADMIN_KEY: adminKey };
    const out = await runRelayCli(['machines', 'remove', 'acct1', '--url', 'wss://relay.example'], d);
    expect(out).toContain('removed acct1');
    expect(requests[0]!.url).toBe('https://relay.example/acct1?role=remove');
    expect(verifyJoinAuth(requests[0]!.headers[JOIN_HEADER], adminKey, { account: 'acct1', role: 'remove' }, Date.now())).toBe(true);
  });

  it('takes the admin key as --admin-key too, and refuses the old --key with a pointer to the admin key', async () => {
    const { d, requests } = deps(null, [{ status: 200, body: '[]' }]);
    await runRelayCli(['machines', 'list', '--url', 'wss://relay.example', '--admin-key', adminKey], d);
    expect(verifyJoinAuth(requests[0]!.headers[JOIN_HEADER], adminKey, { account: '*', role: 'machines' }, Date.now())).toBe(true);
    await expect(runRelayCli(['machines', 'list', '--url', 'wss://relay.example', '--key', joinKey], deps(null).d)).rejects.toThrow(/admin key/);
  });

  it('lists a removed machine as removed, with the command that lets it join again', async () => {
    const entries = [
      { account: 'acct1', key: 'k', addedAt: '2026-09-26T10:00:00.000Z' },
      { account: 'acct2', key: 'k', addedAt: '2026-09-20T10:00:00.000Z', removedAt: '2026-10-01T10:00:00.000Z' },
    ];
    const { d } = deps({ adminKey }, [{ status: 200, body: JSON.stringify(entries) }]);
    const out = await runRelayCli(['machines', 'list'], d);
    expect(out).toContain('acct1  added 2026-09-26');
    expect(out).toContain('acct2  removed 2026-10-01');
    expect(out).toContain('machines allow');
  });

  it('allows a removed machine to join again', async () => {
    const { d, requests } = deps({ adminKey }, [{ status: 200, body: 'allowed' }]);
    const out = await runRelayCli(['machines', 'allow', 'acct1'], d);
    expect(out).toContain('acct1 may join again');
    expect(requests[0]!.url).toBe('http://127.0.0.1:8450/acct1?role=allow');
    expect(verifyJoinAuth(requests[0]!.headers[JOIN_HEADER], adminKey, { account: 'acct1', role: 'allow' }, Date.now())).toBe(true);
  });

  it('explains a refusal', async () => {
    const { d } = deps({ adminKey }, [{ status: 401, body: 'admin key refused' }]);
    await expect(runRelayCli(['machines', 'list'], d)).rejects.toThrow(/401.*admin key refused/);
  });
});
