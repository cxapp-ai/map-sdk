import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { cssInjectedByJs } from './css-inject.plugin';

// Self-contained global build for script-tag / WebView hosts with no bundler:
// exposes `window.MapSDK` (MapSDK.mountIndoorMap(...)). jmap.js is inlined —
// dynamic imports of bare specifiers cannot resolve inside a WebView — and
// the component CSS is inlined + self-injected (css-inject.plugin.ts) so the
// single file really is self-contained (DECISIONS.md #3).
export default defineConfig({
  plugins: [svelte(), cssInjectedByJs('index')],
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'MapSDK',
      formats: ['iife'],
      fileName: () => 'map-sdk.iife.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
    emptyOutDir: false,
    sourcemap: true,
  },
});
