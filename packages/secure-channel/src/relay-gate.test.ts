import { describe, expect, it } from 'vitest';
import { GATE_READY, encodeGateChallenge, encodeGateReply, parseGateChallenge, parseGateReply } from './relay-gate';

const key = 'k'.repeat(43);
const sig = 's'.repeat(86);

describe('relay gate messages', () => {
  it('round-trips a challenge', () => {
    expect(parseGateChallenge(encodeGateChallenge('nonce_1'))).toBe('nonce_1');
  });

  it('reads no challenge from anything else, the ready message included', () => {
    for (const text of [GATE_READY, '{"type":"challenge"}', '{"type":"challenge","nonce":""}', 'nonsense', '[]']) {
      expect(parseGateChallenge(text)).toBeNull();
    }
  });

  it('round-trips a reply, with or without an enrolment proof and its credential', () => {
    expect(parseGateReply(encodeGateReply({ key, nonce: 'n-1', sig }))).toEqual({ key, nonce: 'n-1', sig });
    const full = { key, nonce: 'n-1', sig, proof: 'p_1', cred: 'pairing' as const };
    expect(parseGateReply(encodeGateReply(full))).toEqual(full);
  });

  it('drops a credential it does not know, as the URL form does', () => {
    const text = JSON.stringify({ type: 'device', device: key, nonce: 'n', sig, proof: 'p', cred: 'other' });
    expect(parseGateReply(text)).toEqual({ key, nonce: 'n', sig, proof: 'p' });
  });

  it('refuses a reply in any shape the URL form refuses', () => {
    const base = { type: 'device', device: key, nonce: 'n', sig };
    for (const bad of [
      { ...base, type: 'other' },
      { ...base, device: 'short' },
      { ...base, sig: 'x'.repeat(85) },
      { ...base, nonce: 'n'.repeat(129) },
      { ...base, nonce: 'a b' },
      { ...base, proof: 'p'.repeat(129) },
      { ...base, device: 7 },
    ]) {
      expect(parseGateReply(JSON.stringify(bad))).toBeNull();
    }
    expect(parseGateReply('not json')).toBeNull();
    expect(parseGateReply('null')).toBeNull();
  });
});
