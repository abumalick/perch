import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// A throwaway agent identity for the run, made with node:crypto because this config is loaded
// by Node, which cannot import the TypeScript workspace packages. Same shapes as
// @perch/secure-channel: raw keys in base64url, account = first 16 bytes of sha256(public key).
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'jwk' }).x!;
const priv = privateKey.export({ format: 'jwk' }).d!;
const joinKey = randomBytes(32).toString('base64url');
const adminKey = randomBytes(32).toString('base64url');
const account = createHash('sha256').update(Buffer.from(pub, 'base64url')).digest().subarray(0, 16).toString('base64url');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          RELAY_AUDIT: '1',
          // Small limits keep the conformance suite fast; the suite reads them back from env.
          RELAY_DIAL_TIMEOUT_MS: '2000',
          RELAY_MAX_PENDING: '2',
          RELAY_MAX_PAIRS: '3',
          RELAY_MAX_ENROLMENTS: '8',
          JOIN_KEY: joinKey,
          ADMIN_KEY: adminKey,
          RELAY_JOIN_MAX: '5',
          TEST_ACCOUNT: account,
          TEST_AGENT_KEY: priv,
          TEST_AGENT_PUBLIC_KEY: pub,
        },
      },
    }),
  ],
  test: {
    // Durable Object WebSockets need one shared runtime; see deploy/parallelism-caps.test.sh.
    maxWorkers: 1,
  },
});
