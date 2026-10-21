import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Capped like the other packages so the whole gate stays within a memory budget.
    // See deploy/parallelism-caps.test.sh.
    maxWorkers: 2,
  },
});
