import { describe, expect, it } from 'vitest';
import { deviceFingerprint, encodeDeviceHello, parseDeviceHello, sanitizeDeviceName } from './device-hello';
import { generateDeviceKeys } from './keys';

describe('device hello', () => {
  it('round-trips the Ed25519 key and name', () => {
    const hello = { sig: generateDeviceKeys().ed25519.publicKey, name: 'Android · Chrome' };
    expect(parseDeviceHello(encodeDeviceHello(hello))).toEqual(hello);
  });

  it('carries whether the phone asks to be served at once, and ignores a value it does not know', () => {
    const sig = generateDeviceKeys().ed25519.publicKey;
    expect(parseDeviceHello(encodeDeviceHello({ sig, name: 'p', push: true }))?.push).toBe(true);
    const encode = (s: string) => new TextEncoder().encode(s);
    expect(parseDeviceHello(encode(JSON.stringify({ sig, name: 'p', push: 'yes' }))))?.toEqual({ sig, name: 'p' });
  });

  // A PWA built before direct connections still signs its hello for a relay.
  it('parses a hello that still carries a relay proof', () => {
    const hello = { sig: generateDeviceKeys().ed25519.publicKey, name: 'p', proof: 'A'.repeat(86) };
    expect(parseDeviceHello(encodeDeviceHello(hello))).toEqual(hello);
  });

  it('returns null for anything else', () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    expect(parseDeviceHello(new Uint8Array(0))).toBeNull();
    expect(parseDeviceHello(encode('{"sig":"short","name":"x"}'))).toBeNull();
    expect(parseDeviceHello(encode(JSON.stringify({ sig: 'A'.repeat(43), name: 'n'.repeat(65) })))).toBeNull();
  });
});

describe('device hello Ed25519 key', () => {
  it('refuses a small-order key', () => {
    const identity = 'AQ' + 'A'.repeat(41);
    expect(parseDeviceHello(encodeDeviceHello({ sig: identity, name: 'p', proof: 'A'.repeat(86) }))).toBeNull();
  });
});

describe('device hello names', () => {
  it('keeps a name as the phone sends it when it is plain text', () => {
    expect(sanitizeDeviceName('iPhone · Safari')).toBe('iPhone · Safari');
  });

  // The name reaches the agent's journal and `tarfa devices`: control characters (a newline that
  // forges a log line, an escape that rewrites the terminal) and bidi overrides are replaced.
  it('replaces control characters and bidi overrides', () => {
    expect(sanitizeDeviceName('a\nphone: device ffff enrolled')).toBe('a?phone: device ffff enrolled');
    expect(sanitizeDeviceName('x\u001b[2Jy\u202Ez\u0085')).toBe('x?[2Jy?z?');
    const hello = { sig: generateDeviceKeys().ed25519.publicKey, name: 'evil\r\nname' };
    expect(parseDeviceHello(encodeDeviceHello(hello))?.name).toBe('evil??name');
  });
});

describe('deviceFingerprint', () => {
  it('is short, stable and differs between keys', () => {
    const a = generateDeviceKeys().x25519.publicKey;
    expect(deviceFingerprint(a)).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(deviceFingerprint(a)).toBe(deviceFingerprint(a));
    expect(deviceFingerprint(generateDeviceKeys().x25519.publicKey)).not.toBe(deviceFingerprint(a));
  });
});
