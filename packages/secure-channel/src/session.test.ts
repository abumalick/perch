import { describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
import { IkInitiator, IkResponder, rawStaticKey, type TransportPair } from './noise';
import {
  FLAG_FINAL,
  FLAG_HANDSHAKE_IK,
  FLAG_MORE,
  MAX_CHUNK,
  SecureChannelError,
  SecureSession,
  handshakeFrame,
  readHandshakeFrame,
} from './session';

async function handshake(): Promise<{ i: TransportPair; r: TransportPair }> {
  const agent = x25519.utils.randomSecretKey();
  const initiator = new IkInitiator(rawStaticKey(x25519.utils.randomSecretKey()), x25519.getPublicKey(agent));
  const responder = new IkResponder(agent);
  responder.readMessage1(await initiator.writeMessage1());
  await initiator.readMessage2(responder.writeMessage2());
  return { i: initiator.split(), r: responder.split() };
}

async function pair(maxMessageBytes?: number): Promise<{ phone: SecureSession; agent: SecureSession }> {
  const { i, r } = await handshake();
  return {
    phone: new SecureSession(i.send, i.recv, { maxMessageBytes }),
    agent: new SecureSession(r.send, r.recv, { maxMessageBytes }),
  };
}

function deliver(to: SecureSession, frames: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const frame of frames) {
    const message = to.open(frame);
    if (message) out.push(message);
  }
  return out;
}

function filled(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = i % 251;
  return out;
}

describe('SecureSession', () => {
  it.each([
    [0, 1],
    [MAX_CHUNK, 1],
    [MAX_CHUNK + 1, 2],
    [20 * 1024 * 1024, 321],
  ])('seals a %i-byte message into %i frame(s) and reassembles it exactly', async (size, frames) => {
    const { phone, agent } = await pair();
    const message = filled(size);
    const sealed = phone.seal(message);
    expect(sealed).toHaveLength(frames);
    for (const frame of sealed) expect(frame.length).toBeLessThanOrEqual(1 + 65_535);
    expect(sealed.slice(0, -1).every((f) => f[0] === FLAG_MORE)).toBe(true);
    expect(sealed.at(-1)![0]).toBe(FLAG_FINAL);
    const [received] = deliver(agent, sealed);
    // A digest, because a deep equality over 20 MB exhausts the test worker's heap.
    expect(received!.length).toBe(size);
    expect(bytesToHex(sha256(received!))).toBe(bytesToHex(sha256(message)));
  });

  it('keeps consecutive messages apart', async () => {
    const { phone, agent } = await pair();
    const received = deliver(agent, [...phone.seal(filled(10)), ...phone.seal(filled(MAX_CHUNK + 5))]);
    expect(received.map((m) => m.length)).toEqual([10, MAX_CHUNK + 5]);
  });

  it('refuses a message whose reassembly would exceed the cap', async () => {
    const { phone, agent } = await pair(MAX_CHUNK * 2);
    const frames = phone.seal(filled(MAX_CHUNK * 3));
    expect(() => deliver(agent, frames)).toThrow(SecureChannelError);
  });

  it('refuses a tampered frame', async () => {
    const { phone, agent } = await pair();
    const [frame] = phone.seal(filled(10));
    frame![5]! ^= 1;
    expect(() => agent.open(frame!)).toThrow(SecureChannelError);
  });

  it('refuses a frame with an unknown or handshake flag', async () => {
    const { phone, agent } = await pair();
    const [frame] = phone.seal(filled(10));
    frame![0] = FLAG_HANDSHAKE_IK;
    expect(() => agent.open(frame!)).toThrow(SecureChannelError);
    expect(() => agent.open(new Uint8Array([7, 1, 2]))).toThrow(SecureChannelError);
    expect(() => agent.open(new Uint8Array(0))).toThrow(SecureChannelError);
  });

  it('refuses frames replayed or reordered by the relay', async () => {
    const { phone, agent } = await pair();
    const [first] = phone.seal(filled(3));
    const [second] = phone.seal(filled(4));
    expect(() => agent.open(second!)).toThrow(SecureChannelError);
    expect(agent.open(first!)).toEqual(filled(3));
    expect(() => agent.open(first!)).toThrow(SecureChannelError);
  });

  it('refuses a frame whose flag the relay flipped', async () => {
    const cut = await pair();
    const [first] = cut.phone.seal(filled(MAX_CHUNK + 1));
    first![0] = FLAG_FINAL;
    expect(() => cut.agent.open(first!)).toThrow(SecureChannelError);

    const merged = await pair();
    const [only] = merged.phone.seal(filled(10));
    only![0] = FLAG_MORE;
    expect(() => merged.agent.open(only!)).toThrow(SecureChannelError);
  });

  it('refuses a message split into more chunks than its cap allows', async () => {
    // A peer that completed the handshake crafting empty `more` chunks: they carry no bytes, so only a count cap stops them piling up.
    const { i, r } = await handshake();
    const { send } = i;
    const agent = new SecureSession(r.send, r.recv, { maxMessageBytes: MAX_CHUNK * 2 });
    const emptyMore = () => concatBytes(Uint8Array.of(FLAG_MORE), send.encrypt(new Uint8Array(0), Uint8Array.of(FLAG_MORE)));
    expect(agent.open(emptyMore())).toBeNull();
    expect(agent.open(emptyMore())).toBeNull();
    expect(() => agent.open(emptyMore())).toThrow(SecureChannelError);
  });

  // Before a peer has authenticated, the agent reads it under a small cap, raised once it has.
  it('takes a raised cap for the messages after it', async () => {
    const { phone, agent } = await pair(1024);
    expect(() => deliver(phone, agent.seal(filled(2048)))).toThrow(SecureChannelError);
    const again = await pair(1024);
    again.agent.raiseCap(4096);
    expect(deliver(again.agent, again.phone.seal(filled(2048)))[0]).toEqual(filled(2048));
  });

  it('works in both directions', async () => {
    const { phone, agent } = await pair();
    expect(deliver(phone, agent.seal(filled(7)))[0]).toEqual(filled(7));
  });
});

describe('handshake frames', () => {
  it('round-trips a handshake message behind its flag', () => {
    const frame = handshakeFrame(Uint8Array.of(1, 2, 3));
    expect(frame[0]).toBe(FLAG_HANDSHAKE_IK);
    expect(readHandshakeFrame(frame)).toEqual(Uint8Array.of(1, 2, 3));
  });

  it('refuses a transport frame where a handshake is expected', () => {
    expect(() => readHandshakeFrame(Uint8Array.of(FLAG_FINAL, 1))).toThrow(SecureChannelError);
    expect(() => readHandshakeFrame(new Uint8Array(0))).toThrow(SecureChannelError);
  });
});

describe('handshake frames', () => {
  it('knows only IK: the retired NK flag is not a handshake', async () => {
    const { handshakePattern } = await import('./session');
    expect(handshakePattern(handshakeFrame(Uint8Array.of(1)))).toBe('ik');
    expect(handshakePattern(Uint8Array.of(0x02, 1))).toBeNull();
    expect(handshakePattern(Uint8Array.of(FLAG_FINAL, 1))).toBeNull();
    expect(() => readHandshakeFrame(Uint8Array.of(0x02, 7))).toThrow(SecureChannelError);
  });
});
