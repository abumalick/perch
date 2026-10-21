import { describe, expect, it } from 'vitest';
import { parseAgentControl, parseRelayControl, type RelayPolicy } from './relay-control';
import { REFUSAL } from './refusal';
import { generateDeviceKeys } from './keys';

const key = generateDeviceKeys().ed25519.publicKey;
// The identity point: a small-order key, under which a forged signature can verify.
const SMALL_ORDER = 'AQ' + 'A'.repeat(41);

describe('relay control messages', () => {
  it('parses a policy the agent publishes', () => {
    const policy: RelayPolicy = { type: 'policy', devices: [key], revoked: [], enrol: true, tokenEnrol: false };
    expect(parseAgentControl(JSON.stringify(policy))).toEqual(policy);
  });

  it('drops the `anonymous` an agent from before NK was removed still publishes', () => {
    const policy = { type: 'policy', devices: [key], revoked: [], enrol: true };
    expect(parseAgentControl(JSON.stringify({ ...policy, anonymous: true }))).toEqual(policy);
  });

  it('parses a refusal of an enrolment', () => {
    expect(parseAgentControl('{"type":"refuse","id":"d1"}')).toEqual({ type: 'refuse', id: 'd1' });
  });

  it('carries why the agent refused, and drops a reason it does not know rather than the refusal', () => {
    expect(parseAgentControl('{"type":"refuse","id":"d1","reason":"pairing code expired"}')).toEqual({
      type: 'refuse',
      id: 'd1',
      reason: REFUSAL.codeExpired,
    });
    expect(parseAgentControl('{"type":"refuse","id":"d1","reason":"<script>"}')).toEqual({ type: 'refuse', id: 'd1' });
  });

  it('carries which credential an enrolment proof was made with, when the phone says', () => {
    const enrol = { device: key, nonce: 'n', proof: 'p', cred: 'pairing' };
    expect(parseRelayControl(JSON.stringify({ type: 'dial', id: 'd1', enrol }))).toEqual({ type: 'dial', id: 'd1', enrol });
    const odd = parseRelayControl(JSON.stringify({ type: 'dial', id: 'd1', enrol: { ...enrol, cred: 'magic' } }));
    expect(odd).toEqual({ type: 'dial', id: 'd1', enrol: { device: key, nonce: 'n', proof: 'p' } });
  });

  it('parses a dial, with or without an enrolment to check', () => {
    expect(parseRelayControl('{"type":"dial","id":"d1"}')).toEqual({ type: 'dial', id: 'd1' });
    const enrol = { device: key, nonce: 'n', proof: 'p' };
    expect(parseRelayControl(JSON.stringify({ type: 'dial', id: 'd1', enrol }))).toEqual({ type: 'dial', id: 'd1', enrol });
  });

  it('parses the relay acknowledging a policy', () => {
    expect(parseRelayControl('{"type":"applied"}')).toEqual({ type: 'applied' });
  });

  it('returns null for anything else, never throws', () => {
    for (const text of ['pong', '{', '{"type":"dial"}', '{"type":"policy","devices":["short"],"revoked":[],"enrol":true}']) {
      expect(parseAgentControl(text)).toBeNull();
      expect(parseRelayControl(text)).toBeNull();
    }
  });

  it('refuses a policy that admits a small-order device key', () => {
    expect(parseAgentControl(JSON.stringify({ type: 'policy', devices: [key, SMALL_ORDER], revoked: [], enrol: true }))).toBeNull();
  });

  it('caps the published lists, so a policy stays small', () => {
    const many = Array.from({ length: 257 }, () => key);
    expect(parseAgentControl(JSON.stringify({ type: 'policy', devices: many, revoked: [], enrol: false }))).toBeNull();
  });

  // The agent logs a dial id and sends it as a header: a relay must not be able to write journal
  // lines (or terminal escapes) with one.
  it('takes ids, nonces and refusal ids in a token charset only', () => {
    expect(parseRelayControl(JSON.stringify({ type: 'dial', id: '6f1c2a9e-0b7d-4c1e-9a2f-3d4e5f60718a' }))).not.toBeNull();
    for (const id of ['x\nforged line', 'a\u001b[2K', 'a b', '']) {
      expect(parseRelayControl(JSON.stringify({ type: 'dial', id }))).toBeNull();
      expect(parseAgentControl(JSON.stringify({ type: 'refuse', id }))).toBeNull();
      expect(parseRelayControl(JSON.stringify({ type: 'dial', id: 'ok', enrol: { device: key, nonce: id, proof: 'p' } }))).toBeNull();
    }
  });
});
