import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { IkInitiator, IkResponder, WrongStaticKeyError, rawStaticKey } from './noise';
import fixture from './fixtures/ik-vectors.json';

const utf8 = (s: string) => new TextEncoder().encode(s);

function keypair() {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

describe('Noise_IK_25519_ChaChaPoly_SHA256 test vectors', () => {
  for (const [i, v] of fixture.vectors.entries()) {
    it(`reproduces vector ${i} byte for byte`, async () => {
      const initiator = new IkInitiator(rawStaticKey(hexToBytes(v.init_static)), hexToBytes(v.init_remote_static), {
        prologue: hexToBytes(v.init_prologue),
        ephemeralPrivate: hexToBytes(v.init_ephemeral),
      });
      const responder = new IkResponder(hexToBytes(v.resp_static), {
        prologue: hexToBytes(v.resp_prologue),
        ephemeralPrivate: hexToBytes(v.resp_ephemeral),
      });
      const [m1, m2, ...transport] = v.messages;

      const c1 = await initiator.writeMessage1(hexToBytes(m1!.payload));
      expect(bytesToHex(c1)).toBe(m1!.ciphertext);
      expect(bytesToHex(responder.readMessage1(c1))).toBe(m1!.payload);
      expect(bytesToHex(responder.remoteStatic())).toBe(bytesToHex(x25519.getPublicKey(hexToBytes(v.init_static))));

      const c2 = responder.writeMessage2(hexToBytes(m2!.payload));
      expect(bytesToHex(c2)).toBe(m2!.ciphertext);
      expect(bytesToHex(await initiator.readMessage2(c2))).toBe(m2!.payload);

      expect(bytesToHex(initiator.handshakeHash())).toBe(v.handshake_hash);
      expect(bytesToHex(responder.handshakeHash())).toBe(v.handshake_hash);

      const i2r = initiator.split();
      const r2i = responder.split();
      transport.forEach((m, n) => {
        const [writer, reader] = n % 2 === 0 ? [i2r.send, r2i.recv] : [r2i.send, i2r.recv];
        const ct = writer.encrypt(hexToBytes(m.payload));
        expect(bytesToHex(ct)).toBe(m.ciphertext);
        expect(bytesToHex(reader.decrypt(ct))).toBe(m.payload);
      });
    });
  }
});

async function completed() {
  const agent = keypair();
  const initiator = new IkInitiator(rawStaticKey(keypair().priv), agent.pub);
  const responder = new IkResponder(agent.priv);
  responder.readMessage1(await initiator.writeMessage1());
  await initiator.readMessage2(responder.writeMessage2());
  return { p: initiator.split(), a: responder.split() };
}

describe('IK handshake', () => {
  it('tells the responder who the initiator is and carries traffic both ways', async () => {
    const agent = keypair();
    const phone = keypair();
    const initiator = new IkInitiator(rawStaticKey(phone.priv), agent.pub);
    const responder = new IkResponder(agent.priv);
    expect(new TextDecoder().decode(responder.readMessage1(await initiator.writeMessage1(utf8('hi'))))).toBe('hi');
    expect(responder.remoteStatic()).toEqual(phone.pub);
    await initiator.readMessage2(responder.writeMessage2());
    const p = initiator.split();
    const a = responder.split();
    expect(new TextDecoder().decode(a.recv.decrypt(p.send.encrypt(utf8('hello'))))).toBe('hello');
    expect(new TextDecoder().decode(p.recv.decrypt(a.send.encrypt(utf8('world'))))).toBe('world');
  });

  it('works through an asynchronous static key, as a non-extractable WebCrypto key would be', async () => {
    const agent = keypair();
    const phone = keypair();
    const slow = { publicKey: phone.pub, dh: async (pub: Uint8Array) => x25519.getSharedSecret(phone.priv, pub) };
    const initiator = new IkInitiator(slow, agent.pub);
    const responder = new IkResponder(agent.priv);
    responder.readMessage1(await initiator.writeMessage1());
    await initiator.readMessage2(responder.writeMessage2());
    expect(initiator.handshakeHash()).toEqual(responder.handshakeHash());
  });

  it('keeps a failing static key\'s own error as the cause, so a caller can tell it from a bad peer key', async () => {
    const responder = keypair();
    const failure = new Error('key unusable');
    const local = { publicKey: keypair().pub, dh: () => Promise.reject(failure) };
    const error = await new IkInitiator(local, responder.pub).writeMessage1().catch((e: unknown) => e);
    expect((error as Error).cause).toBe(failure);
  });

  it('fails at the responder when the initiator targets another agent', async () => {
    const initiator = new IkInitiator(rawStaticKey(keypair().priv), keypair().pub);
    const m1 = await initiator.writeMessage1();
    expect(() => new IkResponder(keypair().priv).readMessage1(m1)).toThrow(WrongStaticKeyError);
  });

  it('tells a payload that fails to decrypt from a message for another key', async () => {
    const agent = keypair();
    const m1 = await new IkInitiator(rawStaticKey(keypair().priv), agent.pub).writeMessage1(utf8('hello'));
    m1[m1.length - 1]! ^= 1;
    const error = (() => {
      try {
        new IkResponder(agent.priv).readMessage1(m1);
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WrongStaticKeyError);
  });

  it('fails at the initiator when the answer does not come from the pinned agent', async () => {
    const agent = keypair();
    const initiator = new IkInitiator(rawStaticKey(keypair().priv), agent.pub);
    await initiator.writeMessage1();
    const forged = new Uint8Array(48);
    forged.set(x25519.getPublicKey(x25519.utils.randomSecretKey()));
    await expect(initiator.readMessage2(forged)).rejects.toThrow();
  });

  it('rejects a tampered transport message', async () => {
    const { p, a } = await completed();
    const ct = p.send.encrypt(utf8('hello'));
    ct[0]! ^= 1;
    expect(() => a.recv.decrypt(ct)).toThrow();
  });

  it('rejects messages out of order', async () => {
    const { p, a } = await completed();
    const first = p.send.encrypt(utf8('a'));
    const second = p.send.encrypt(utf8('b'));
    expect(() => a.recv.decrypt(second)).toThrow();
    // A failed decrypt must not advance the nonce, or one bad frame would poison the session.
    expect(new TextDecoder().decode(a.recv.decrypt(first))).toBe('a');
  });

  it('refuses a message 1 too short to hold the static key', () => {
    expect(() => new IkResponder(keypair().priv).readMessage1(new Uint8Array(64))).toThrow();
  });
});
