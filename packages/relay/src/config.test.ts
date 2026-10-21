import { describe, expect, it } from 'vitest';
import { accountId, generateAgentKeys, generateJoinKey } from '@perch/secure-channel';
import { parseJoinLimit, parseRelayConfig, parseRelayLimits } from './config.ts';
import { DEFAULT_JOIN_LIMIT } from './registry.ts';

const keys = generateAgentKeys();
const account = accountId(keys.ed25519.publicKey);
const agents = { [account]: keys.ed25519.publicKey };

describe('parseRelayLimits', () => {
  it('reads the caps and the dial timeout, from numbers or numeric strings', () => {
    expect(parseRelayLimits({ dialTimeoutMs: 500, maxPending: '2', maxPairs: 3, maxEnrolments: '4' })).toEqual({
      dialTimeoutMs: 500,
      maxPending: 2,
      maxPairs: 3,
      maxEnrolments: 4,
    });
  });

  it('leaves an unset limit to the relay default', () => {
    expect(parseRelayLimits({ maxPending: undefined, maxPairs: '' })).toEqual({});
  });

  it.each([0, -1, 1.5, 'ten', '1e3', null, true])('refuses the limit %s', (value) => {
    expect(() => parseRelayLimits({ maxPairs: value })).toThrow(/maxPairs/);
  });
});

describe('parseJoinLimit', () => {
  it('reads the join rate limit, and defaults what is unset', () => {
    expect(parseJoinLimit({ joinMax: 3, joinWindowMs: '1000' })).toEqual({ max: 3, windowMs: 1000 });
    expect(parseJoinLimit({})).toEqual(DEFAULT_JOIN_LIMIT);
  });

  it('refuses a malformed one', () => {
    expect(() => parseJoinLimit({ joinMax: 0 })).toThrow(/joinMax/);
  });
});

describe('parseRelayConfig', () => {
  it('reads the bind address and limits', () => {
    const raw = JSON.stringify({ host: '0.0.0.0', port: 9000, maxPending: 4 });
    expect(parseRelayConfig(raw)).toEqual({
      host: '0.0.0.0',
      port: 9000,
      limits: { maxPending: 4 },
      joinLimit: DEFAULT_JOIN_LIMIT,
    });
  });

  it('reads a join key and join limits', () => {
    const joinKey = generateJoinKey();
    expect(parseRelayConfig(JSON.stringify({ joinKey, joinMax: 2 }))).toMatchObject({ joinKey, joinLimit: { max: 2 } });
    expect(parseRelayConfig(JSON.stringify({})).joinKey).toBeUndefined();
  });

  it('reads an admin key, apart from the join key', () => {
    const adminKey = generateJoinKey();
    expect(parseRelayConfig(JSON.stringify({ adminKey })).adminKey).toBe(adminKey);
    expect(parseRelayConfig(JSON.stringify({})).adminKey).toBeUndefined();
    expect(() => parseRelayConfig(JSON.stringify({ adminKey: 'short' }))).toThrow(/adminKey/);
  });

  it('binds to localhost on the default port unless told otherwise', () => {
    expect(parseRelayConfig(JSON.stringify({}))).toMatchObject({ host: '127.0.0.1', port: 8450 });
  });

  it('believes no client-IP header unless one is named', () => {
    expect(parseRelayConfig(JSON.stringify({})).clientIpHeader).toBeUndefined();
    expect(parseRelayConfig(JSON.stringify({ clientIpHeader: null })).clientIpHeader).toBeUndefined();
    expect(parseRelayConfig(JSON.stringify({ clientIpHeader: 'X-Forwarded-For' })).clientIpHeader).toBe('x-forwarded-for');
  });

  it('refuses an unknown key, so a misspelt cap is not silently ignored', () => {
    expect(() => parseRelayConfig(JSON.stringify({ maxPair: 4 }))).toThrow(/maxPair/);
  });

  // Accounts live in the registry beside the config; a config still listing them is refused by name.
  it('refuses an agents list like any unknown key', () => {
    expect(() => parseRelayConfig(JSON.stringify({ agents }))).toThrow('relay config: unknown key "agents"');
  });

  it.each([
    ['not json', /JSON/],
    ['[]', /object/],
    [JSON.stringify({ joinKey: 'short' }), /joinKey/],
    [JSON.stringify({ port: 70_000 }), /port/],
    [JSON.stringify({ host: 3 }), /host/],
    [JSON.stringify({ clientIpHeader: '' }), /clientIpHeader/],
    [JSON.stringify({ clientIpHeader: 'x forwarded' }), /clientIpHeader/],
    [JSON.stringify({ clientIpHeader: true }), /clientIpHeader/],
  ])('refuses the malformed config %s', (raw, message) => {
    expect(() => parseRelayConfig(raw)).toThrow(message);
  });
});
