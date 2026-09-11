import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The web app's tests.
 *
 * These are Node tests, not browser ones: they import the route modules directly to check
 * that every endpoint is closed by default. There is no jsdom and no React rendering here.
 *
 * The @/ alias has to be declared again because vitest does not read tsconfig paths.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
  },
});
