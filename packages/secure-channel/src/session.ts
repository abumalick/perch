// The encrypted session on the wire. Each relay frame is one flag byte and one Noise message.
// Noise caps a message at 65 535 bytes, so a larger plaintext (a big terminal burst, an
// attached file) is split into chunks flagged `more` and reassembled up to a cap. The flag is
// the chunk's associated data: it travels in the clear but is authenticated, so the relay
// cannot merge two messages or cut one short by flipping it.
import { concatBytes } from '@noble/hashes/utils.js';
import type { CipherState } from './noise';

export const FLAG_FINAL = 0x00;
export const FLAG_MORE = 0x01;
export const FLAG_HANDSHAKE_IK = 0x03;
const NOISE_MAX_MESSAGE = 65_535;
const TAG_LEN = 16;
export const MAX_CHUNK = NOISE_MAX_MESSAGE - TAG_LEN;
export const MAX_FRAME_BYTES = 1 + NOISE_MAX_MESSAGE;
// Enough for the PWA's 20 MB attachment limit once base64'd into JSON.
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export class SecureChannelError extends Error {}

type HandshakePattern = 'ik';

// The flag names the handshake's Noise pattern. Only IK is left; the flag NK used (0x02) is no
// longer a handshake, so a phone from before device keys fails at once.
export function handshakeFrame(message: Uint8Array, _pattern: HandshakePattern = 'ik'): Uint8Array {
  return concatBytes(Uint8Array.of(FLAG_HANDSHAKE_IK), message);
}

export function handshakePattern(frame: Uint8Array): HandshakePattern | null {
  return frame[0] === FLAG_HANDSHAKE_IK ? 'ik' : null;
}

export function readHandshakeFrame(frame: Uint8Array, _pattern: HandshakePattern = 'ik'): Uint8Array {
  if (frame.length < 1 || handshakePattern(frame) !== 'ik') {
    throw new SecureChannelError('expected a handshake frame');
  }
  return frame.subarray(1);
}

export class SecureSession {
  private maxMessageBytes: number;
  private maxChunks: number;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly sendCipher: CipherState,
    private readonly recvCipher: CipherState,
    options: { maxMessageBytes?: number } = {},
  ) {
    this.maxMessageBytes = 0;
    this.maxChunks = 0;
    this.raiseCap(options.maxMessageBytes ?? MAX_MESSAGE_BYTES);
  }

  // The largest message accepted from here on.
  raiseCap(maxMessageBytes: number): void {
    this.maxMessageBytes = maxMessageBytes;
    this.maxChunks = Math.max(1, Math.ceil(maxMessageBytes / MAX_CHUNK));
  }

  seal(plaintext: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    let offset = 0;
    do {
      const end = Math.min(offset + MAX_CHUNK, plaintext.length);
      const flag = end < plaintext.length ? FLAG_MORE : FLAG_FINAL;
      const ad = Uint8Array.of(flag);
      frames.push(concatBytes(ad, this.sendCipher.encrypt(plaintext.subarray(offset, end), ad)));
      offset = end;
    } while (offset < plaintext.length);
    return frames;
  }

  // Returns the whole message once its final chunk arrives, null while more are expected.
  open(frame: Uint8Array): Uint8Array | null {
    const flag = frame[0];
    if (flag !== FLAG_FINAL && flag !== FLAG_MORE) {
      throw new SecureChannelError('unexpected frame flag');
    }
    let chunk: Uint8Array;
    try {
      chunk = this.recvCipher.decrypt(frame.subarray(1), Uint8Array.of(flag));
    } catch {
      throw new SecureChannelError('frame failed authentication');
    }
    this.pendingBytes += chunk.length;
    if (this.pendingBytes > this.maxMessageBytes || this.pending.length >= this.maxChunks) {
      throw new SecureChannelError('message exceeds the size cap');
    }
    this.pending.push(chunk);
    if (flag === FLAG_MORE) return null;
    const message = this.pending.length === 1 ? this.pending[0]! : concatBytes(...this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    return message;
  }
}
