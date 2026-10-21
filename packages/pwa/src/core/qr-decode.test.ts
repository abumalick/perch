import { describe, expect, it } from 'vitest';
import encodeQR from 'qr';
import decodeQR from 'qr/decode.js';
import { accountId, generateAgentKeys, generatePairingSecret, pairingLink } from '@perch/secure-channel';

// The decoder the in-app scanner uses must read the codes `perch pair` prints, at their real
// length. Rendered here the way a camera frame arrives: RGBA pixels, a few per module.
function render(text: string, scale = 4) {
  const matrix = encodeQR(text, 'raw', { ecc: 'low', border: 4 });
  const size = matrix.length * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const v = matrix[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
      data.set([v, v, v, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

describe('QR decoding of a pairing link', () => {
  it('reads back the exact link', () => {
    const keys = generateAgentKeys();
    const link = pairingLink('https://perch-host.example-tailnet.ts.net:8443', {
      url: `wss://perch-relay.example.com/${accountId(keys.ed25519.publicKey)}`,
      agentKey: keys.x25519.publicKey,
      secret: generatePairingSecret(),
      name: 'dev box',
    });
    expect(decodeQR(render(link))).toBe(link);
  });
});
