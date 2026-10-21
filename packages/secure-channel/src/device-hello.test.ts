import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { deviceFingerprint, encodeDeviceHello, parseDeviceHello, sanitizeDeviceName, signDeviceHello, verifyDeviceHello } from './device-hello';
import { b64url, ed25519Signer, generateDeviceKeys } from './keys';
import { IkInitiator, IkResponder, rawStaticKey } from './noise';

describe('device hello', () => {
  it('round-trips the relay key and name', () => {
    const hello = { sig: generateDeviceKeys().ed25519.publicKey, name: 'Android · Chrome' };
    expect(parseDeviceHello(encodeDeviceHello(hello))).toEqual(hello);
  });

  it('returns null for anything else', () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    expect(parseDeviceHello(new Uint8Array(0))).toBeNull();
    expect(parseDeviceHello(encode('{"sig":"short","name":"x"}'))).toBeNull();
    expect(parseDeviceHello(encode(JSON.stringify({ sig: 'A'.repeat(43), name: 'n'.repeat(65) })))).toBeNull();
  });
});

describe('device hello relay key', () => {
  it('refuses a small-order relay key', () => {
    const identity = 'AQ' + 'A'.repeat(41);
    expect(parseDeviceHello(encodeDeviceHello({ sig: identity, name: 'p', proof: 'A'.repeat(86) }))).toBeNull();
  });
});

describe('device hello names', () => {
  it('keeps a name as the phone sends it when it is plain text', () => {
    expect(sanitizeDeviceName('iPhone · Safari')).toBe('iPhone · Safari');
  });

  // The name reaches the agent's journal and `perch devices`: control characters (a newline that
  // forges a log line, an escape that rewrites the terminal) and bidi overrides are replaced.
  it('replaces control characters and bidi overrides', () => {
    expect(sanitizeDeviceName('a\nrelay client: device ffff enrolled')).toBe('a?relay client: device ffff enrolled');
    expect(sanitizeDeviceName('x\u001b[2Jy\u202Ez\u0085')).toBe('x?[2Jy?z?');
    const hello = { sig: generateDeviceKeys().ed25519.publicKey, name: 'evil\r\nname' };
    expect(parseDeviceHello(encodeDeviceHello(hello))?.name).toBe('evil??name');
  });
});

// The hello names the phone's Ed25519 relay key; without a proof, one phone could claim another's
// relay key and have the agent publish it. The proof signs the phone's X25519 key and the IK
// handshake hash as it stands when the hello is sealed, which both ends know and which no other
// session repeats.
describe('device hello proof', () => {
  async function handshake(device = generateDeviceKeys(), signWith = device) {
    const agentPriv = x25519.utils.randomSecretKey();
    const initiator = new IkInitiator(rawStaticKey(b64url.decode(device.x25519.privateKey)), x25519.getPublicKey(agentPriv));
    const m1 = await initiator.writeMessage1(async (h) =>
      encodeDeviceHello({
        sig: signWith.ed25519.publicKey,
        name: 'p',
        proof: await signDeviceHello(ed25519Signer(signWith.ed25519.privateKey), b64url.decode(device.x25519.publicKey), h),
      }),
    );
    const responder = new IkResponder(agentPriv);
    const hello = parseDeviceHello(responder.readMessage1(m1))!;
    return { hello, responder };
  }

  it('verifies for the key that signed it, over this handshake', async () => {
    const { hello, responder } = await handshake();
    expect(await verifyDeviceHello(hello, responder.remoteStatic(), responder.payloadHash())).toBe(true);
  });

  it("refuses a hello naming another phone's relay key", async () => {
    const victim = generateDeviceKeys();
    const { hello, responder } = await handshake(generateDeviceKeys());
    expect(await verifyDeviceHello({ ...hello, sig: victim.ed25519.publicKey }, responder.remoteStatic(), responder.payloadHash())).toBe(false);
  });

  it('refuses a proof replayed from another handshake, or none', async () => {
    const device = generateDeviceKeys();
    const first = await handshake(device);
    const second = await handshake(device);
    expect(await verifyDeviceHello(first.hello, second.responder.remoteStatic(), second.responder.payloadHash())).toBe(false);
    const { proof: _, ...bare } = first.hello;
    expect(await verifyDeviceHello(bare, first.responder.remoteStatic(), first.responder.payloadHash())).toBe(false);
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
