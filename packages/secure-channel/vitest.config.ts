import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Capped like the other packages; see deploy/parallelism-caps.test.sh.
    maxWorkers: 2,
  },
});
