import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Embedded Postgres takes a few seconds to initialise on first run.
    hookTimeout: 180_000,
    testTimeout: 60_000,
    // The tenancy tests share one database and assert on row counts.
    fileParallelism: false,
  },
});
