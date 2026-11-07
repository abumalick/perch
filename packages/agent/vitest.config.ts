import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
    globalSetup: ['./src/test-sandbox.test-support.ts'],
  },
});
