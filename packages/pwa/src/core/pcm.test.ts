import { describe, expect, it } from 'vitest';
import { PCM_RATE, toPcm16 } from './pcm';

const samples = (bytes: Uint8Array) => Array.from(new Int16Array(bytes.buffer));

describe('toPcm16', () => {
  it('keeps 16 kHz input as is, as little-endian 16-bit samples', () => {
    const out = toPcm16(new Float32Array([0, 1, -1, 0.5]), PCM_RATE);
    expect(samples(out)).toEqual([0, 32767, -32767, 16384]);
    expect([...out.slice(2, 4)]).toEqual([0xff, 0x7f]);
  });

  it('averages 48 kHz input down to 16 kHz', () => {
    const out = toPcm16(new Float32Array([0.3, 0.3, 0.3, -0.6, -0.6, -0.6, 1, 1]), 48_000);
    expect(samples(out)).toEqual([Math.round(0.3 * 32767), Math.round(-0.6 * 32767)]);
  });

  it('handles a rate that does not divide evenly, and clips', () => {
    const out = toPcm16(new Float32Array(441).fill(2), 44_100);
    expect(out.byteLength).toBe(160 * 2);
    expect(new Set(samples(out))).toEqual(new Set([32767]));
  });
});
