import { defineConfig } from 'vitest/config';

// Unit tests only — no Svelte, no build plugins (vite.config.ts is the library
// build). IndexedDB comes from fake-indexeddb, installed per test.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
