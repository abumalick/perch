import { describe, expect, it } from 'vitest';
import { accountId, generateAgentKeys, signAgentAuth } from '@perch/secure-channel';
import { authorize, validateAgents, type AccountLookup } from './authorize.ts';

const NOW = 1_800_000_000_000;
const keys = generateAgentKeys();
const account = accountId(keys.ed25519.publicKey);
const agents = { [account]: keys.ed25519.publicKey };
const lookup: AccountLookup = async (a) => (a === account ? keys.ed25519.publicKey : undefined);

describe('validateAgents', () => {
  it('reads an account → Ed25519 public key map', () => {
    expect(validateAgents(agents)).toEqual(agents);
  });

  it.each(['null', '[]', '{"a b":"x"}', '{"acct":"short"}', '{"acct":3}'])('refuses the malformed map %s', (raw) => {
    expect(() => validateAgents(JSON.parse(raw))).toThrow();
  });
});

describe('authorize', () => {
  it('lets a client through to a known account without credentials', async () => {
    expect(await authorize({ role: 'client', account }, lookup, NOW)).toBeNull();
  });

  it('answers 404 for an account it does not know, whatever the role', async () => {
    expect(await authorize({ role: 'client', account: 'nobody' }, lookup, NOW)).toBe(404);
    const header = signAgentAuth(keys.ed25519.privateKey, { account: 'nobody', role: 'agent' }, NOW);
    expect(await authorize({ role: 'agent', account: 'nobody', authorization: header }, lookup, NOW)).toBe(404);
  });

  it('lets a correctly signed agent and dial through', async () => {
    const control = signAgentAuth(keys.ed25519.privateKey, { account, role: 'agent' }, NOW);
    expect(await authorize({ role: 'agent', account, authorization: control }, lookup, NOW)).toBeNull();
    const dial = signAgentAuth(keys.ed25519.privateKey, { account, role: 'dial', dialId: 'd1' }, NOW);
    expect(await authorize({ role: 'dial', account, id: 'd1', authorization: dial }, lookup, NOW)).toBeNull();
  });

  it('answers 401 to an agent role without credentials or with a wrong signature', async () => {
    expect(await authorize({ role: 'agent', account }, lookup, NOW)).toBe(401);
    const stranger = generateAgentKeys();
    const forged = signAgentAuth(stranger.ed25519.privateKey, { account, role: 'agent' }, NOW);
    expect(await authorize({ role: 'agent', account, authorization: forged }, lookup, NOW)).toBe(401);
  });

  it('answers 401 to a dial signed for another dial id', async () => {
    const header = signAgentAuth(keys.ed25519.privateKey, { account, role: 'dial', dialId: 'd1' }, NOW);
    expect(await authorize({ role: 'dial', account, id: 'd2', authorization: header }, lookup, NOW)).toBe(401);
  });

  it('lets a spare through only under a signature for that spare id, never a dial signature', async () => {
    const spare = signAgentAuth(keys.ed25519.privateKey, { account, role: 'spare', dialId: 's1' }, NOW);
    expect(await authorize({ role: 'spare', account, id: 's1', authorization: spare }, lookup, NOW)).toBeNull();
    expect(await authorize({ role: 'spare', account, id: 's2', authorization: spare }, lookup, NOW)).toBe(401);
    const dial = signAgentAuth(keys.ed25519.privateKey, { account, role: 'dial', dialId: 's1' }, NOW);
    expect(await authorize({ role: 'spare', account, id: 's1', authorization: dial }, lookup, NOW)).toBe(401);
    expect(await authorize({ role: 'dial', account, id: 's1', authorization: spare }, lookup, NOW)).toBe(401);
  });
});
