import { describe, expect, it } from 'vitest';
import { b64url, generateAgentKeys } from '@perch/secure-channel';
import { parseAgentKey } from './relay-key';

describe('parseAgentKey', () => {
  it('reads the 32-byte X25519 key `perch relay-key` prints, ignoring surrounding spaces', () => {
    const key = generateAgentKeys().x25519.publicKey;
    expect(parseAgentKey(` ${key} `)).toEqual(b64url.decode(key));
  });

  it.each([undefined, '', '   ', 'not a key', 'abc', b64url.encode(new Uint8Array(31)), b64url.encode(new Uint8Array(33))])(
    'refuses %j',
    (value) => {
      expect(parseAgentKey(value)).toBeNull();
    },
  );
});
