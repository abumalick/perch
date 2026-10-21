// Noise_IK over 25519/ChaChaPoly/SHA256 (https://noiseprotocol.org/noise.html), just the pieces
// that pattern needs. The initiator (the phone) already knows the responder's (the agent's) static
// key and sends its own static key encrypted in message 1, `e, es, s, ss`; message 2 is
// `e, ee, se`, so the agent learns which device is calling in the same single round trip.
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { concatBytes } from '@noble/hashes/utils.js';

const IK_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256';
export const IK_PROLOGUE = new TextEncoder().encode('perch-relay-noise-v3');
const DH_LEN = 32;
const TAG_LEN = 16;
const EMPTY = new Uint8Array(0);

export class CipherState {
  private n = 0;
  constructor(private readonly k: Uint8Array | null = null) {}

  hasKey(): boolean {
    return this.k !== null;
  }

  encrypt(plaintext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (!this.k) return plaintext;
    const out = chacha20poly1305(this.k, nonce(this.n), ad).encrypt(plaintext);
    this.n += 1;
    return out;
  }

  decrypt(ciphertext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (!this.k) return ciphertext;
    // Throws on a bad tag before the counter moves, so a rejected frame costs nothing.
    const out = chacha20poly1305(this.k, nonce(this.n), ad).decrypt(ciphertext);
    this.n += 1;
    return out;
  }
}

function nonce(n: number): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(n), true);
  return out;
}

function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, ck, ikm);
  const out1 = hmac(sha256, temp, Uint8Array.of(1));
  const out2 = hmac(sha256, temp, concatBytes(out1, Uint8Array.of(2)));
  return [out1, out2];
}

class SymmetricState {
  private ck: Uint8Array;
  private h: Uint8Array;
  private cipher = new CipherState();

  constructor(protocolName: string, prologue: Uint8Array) {
    // Both names are exactly HASHLEN (32) bytes, so they are used as-is rather than hashed.
    this.h = new TextEncoder().encode(protocolName);
    this.ck = this.h;
    this.mixHash(prologue);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concatBytes(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, k] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cipher = new CipherState(k);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encrypt(plaintext, this.h);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cipher.decrypt(ciphertext, this.h);
    this.mixHash(ciphertext);
    return pt;
  }

  handshakeHash(): Uint8Array {
    return this.h;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

export interface HandshakeOptions {
  prologue?: Uint8Array;
  // Test vectors only: a fixed ephemeral key.
  ephemeralPrivate?: Uint8Array;
}

export interface TransportPair {
  send: CipherState;
  recv: CipherState;
}

class HandshakeError extends Error {}

// Message 1 was sealed for another responder key: the phone pinned another agent's key. Nothing
// else fails that first decryption except a frame altered on the way, which the relay could also
// do by closing the socket.
export class WrongStaticKeyError extends HandshakeError {}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  try {
    return x25519.getSharedSecret(priv, pub);
  } catch {
    throw new HandshakeError('invalid public key');
  }
}

// A static key the handshake can only use, not read: the phone keeps its private half in a
// non-extractable WebCrypto key, whose Diffie-Hellman is asynchronous.
export interface StaticKey {
  publicKey: Uint8Array;
  dh(remotePublic: Uint8Array): Promise<Uint8Array>;
}

export function rawStaticKey(privateKey: Uint8Array): StaticKey {
  return {
    publicKey: x25519.getPublicKey(privateKey),
    dh: async (remotePublic) => dh(privateKey, remotePublic),
  };
}

async function staticDh(key: StaticKey, remotePublic: Uint8Array): Promise<Uint8Array> {
  try {
    return await key.dh(remotePublic);
  } catch (cause) {
    throw new HandshakeError('invalid public key', { cause });
  }
}

export class IkInitiator {
  private readonly ss: SymmetricState;
  private readonly ePriv: Uint8Array;
  private step: 'write1' | 'read2' | 'done' = 'write1';

  constructor(
    private readonly localStatic: StaticKey,
    private readonly remoteStatic: Uint8Array,
    options: HandshakeOptions = {},
  ) {
    this.ss = new SymmetricState(IK_PROTOCOL_NAME, options.prologue ?? IK_PROLOGUE);
    this.ss.mixHash(remoteStatic);
    this.ePriv = options.ephemeralPrivate ?? x25519.utils.randomSecretKey();
  }

  // `payload` may be built from the handshake hash as it stands when the payload is sealed
  // (after `e, es, s, ss`), which the responder reads back as `payloadHash()`: a signature over it
  // is bound to this handshake.
  async writeMessage1(payload: Uint8Array | ((hash: Uint8Array) => Promise<Uint8Array>) = EMPTY): Promise<Uint8Array> {
    if (this.step !== 'write1') throw new HandshakeError('out of order');
    this.step = 'read2';
    const ePub = x25519.getPublicKey(this.ePriv);
    this.ss.mixHash(ePub);
    this.ss.mixKey(dh(this.ePriv, this.remoteStatic));
    const sealedStatic = this.ss.encryptAndHash(this.localStatic.publicKey);
    this.ss.mixKey(await staticDh(this.localStatic, this.remoteStatic));
    const body = typeof payload === 'function' ? await payload(this.ss.handshakeHash()) : payload;
    return concatBytes(ePub, sealedStatic, this.ss.encryptAndHash(body));
  }

  async readMessage2(message: Uint8Array): Promise<Uint8Array> {
    if (this.step !== 'read2') throw new HandshakeError('out of order');
    if (message.length < DH_LEN + TAG_LEN) throw new HandshakeError('message 2 too short');
    this.step = 'done';
    const re = message.subarray(0, DH_LEN);
    this.ss.mixHash(re);
    this.ss.mixKey(dh(this.ePriv, re));
    this.ss.mixKey(await staticDh(this.localStatic, re));
    try {
      return this.ss.decryptAndHash(message.subarray(DH_LEN));
    } catch {
      throw new HandshakeError('responder does not hold the expected static key');
    }
  }

  handshakeHash(): Uint8Array {
    return this.ss.handshakeHash();
  }

  split(): TransportPair {
    if (this.step !== 'done') throw new HandshakeError('handshake not complete');
    const [c1, c2] = this.ss.split();
    return { send: c1, recv: c2 };
  }
}

export class IkResponder {
  private readonly ss: SymmetricState;
  private readonly ePriv: Uint8Array;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;
  private hashAtPayload: Uint8Array | null = null;
  private step: 'read1' | 'write2' | 'done' = 'read1';

  constructor(
    private readonly staticPrivate: Uint8Array,
    options: HandshakeOptions = {},
  ) {
    this.ss = new SymmetricState(IK_PROTOCOL_NAME, options.prologue ?? IK_PROLOGUE);
    this.ss.mixHash(x25519.getPublicKey(staticPrivate));
    this.ePriv = options.ephemeralPrivate ?? x25519.utils.randomSecretKey();
  }

  readMessage1(message: Uint8Array): Uint8Array {
    if (this.step !== 'read1') throw new HandshakeError('out of order');
    if (message.length < DH_LEN + DH_LEN + TAG_LEN + TAG_LEN) throw new HandshakeError('message 1 too short');
    const re = message.subarray(0, DH_LEN);
    this.ss.mixHash(re);
    this.ss.mixKey(dh(this.staticPrivate, re));
    let rs: Uint8Array;
    let payload: Uint8Array;
    try {
      rs = this.ss.decryptAndHash(message.subarray(DH_LEN, 2 * DH_LEN + TAG_LEN));
    } catch {
      throw new WrongStaticKeyError('initiator targeted another static key');
    }
    try {
      this.ss.mixKey(dh(this.staticPrivate, rs));
      this.hashAtPayload = this.ss.handshakeHash();
      payload = this.ss.decryptAndHash(message.subarray(2 * DH_LEN + TAG_LEN));
    } catch (err) {
      if (err instanceof HandshakeError) throw err;
      throw new HandshakeError('message 1 payload failed to decrypt');
    }
    this.re = re.slice();
    this.rs = rs;
    this.step = 'write2';
    return payload;
  }

  // The handshake hash message 1's payload was sealed under (see IkInitiator.writeMessage1).
  payloadHash(): Uint8Array {
    if (!this.hashAtPayload || !this.rs) throw new HandshakeError('message 1 not read');
    return this.hashAtPayload;
  }

  // The initiator's static public key, known once message 1 has been read.
  remoteStatic(): Uint8Array {
    if (!this.rs) throw new HandshakeError('message 1 not read');
    return this.rs;
  }

  writeMessage2(payload: Uint8Array = EMPTY): Uint8Array {
    if (this.step !== 'write2' || !this.re || !this.rs) throw new HandshakeError('out of order');
    const ePub = x25519.getPublicKey(this.ePriv);
    this.ss.mixHash(ePub);
    this.ss.mixKey(dh(this.ePriv, this.re));
    this.ss.mixKey(dh(this.ePriv, this.rs));
    this.step = 'done';
    return concatBytes(ePub, this.ss.encryptAndHash(payload));
  }

  handshakeHash(): Uint8Array {
    return this.ss.handshakeHash();
  }

  split(): TransportPair {
    if (this.step !== 'done') throw new HandshakeError('handshake not complete');
    const [c1, c2] = this.ss.split();
    return { send: c2, recv: c1 };
  }
}
