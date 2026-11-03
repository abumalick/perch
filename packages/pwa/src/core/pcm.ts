// What Claude voice streams: 16 kHz mono signed 16-bit little-endian PCM, the format the
// machine plays into its virtual mic and the rate Claude Code records at.
export const PCM_RATE = 16_000;

// Resamples one block of Web Audio samples (-1..1 at `inRate`) to PCM_RATE by averaging the
// input samples each output sample covers, which also low-passes enough for speech.
export function toPcm16(input: Float32Array, inRate: number): Uint8Array {
  const step = inRate / PCM_RATE;
  const count = Math.floor(input.length / step);
  const out = new DataView(new ArrayBuffer(count * 2));
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = from; j < to; j++) sum += input[j]!;
    const sample = Math.max(-1, Math.min(1, sum / (to - from)));
    out.setInt16(i * 2, Math.round(sample * 0x7fff), true);
  }
  return new Uint8Array(out.buffer);
}
