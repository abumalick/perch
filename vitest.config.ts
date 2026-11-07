import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// A filtered `vitest run packages/agent/...` from the repo root never reads the agent's config,
// so its tests would reach the real tmux server and home directory without this.
export default defineConfig({
  test: {
    globalSetup: [fileURLToPath(new URL('./packages/agent/src/test-sandbox.test-support.ts', import.meta.url))],
  },
});
