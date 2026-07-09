import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import dts from 'vite-plugin-dts';
import { cssInjectedByJs } from './css-inject.plugin';

// ESM library build: `.` (compiled UI + mount API) and `./core` (pure-TS
// engine for hosts that draw their own overlays). jmap.js stays a dynamic
// import so it lands in its own chunk and only loads when a map mounts.
// Component CSS is inlined into the UI entry and self-injected at import
// time (css-inject.plugin.ts) — there is no separate stylesheet to import.
//
// Declarations: `rollupTypes: true` (API Extractor) cannot trace the
// .svelte/.svelte.ts mount layer and emits empty `export {}` entry files, so
// instead we emit per-file d.ts for the pure-TS surface only and hand-author
// the two entry declarations (dist/index.d.ts, dist/core.d.ts) that
// package.json#exports points at. Keep INDEX_DTS in sync with src/index.ts
// (mountIndoorMap's signature lives in src/mount.svelte.ts) and CORE_DTS in
// sync with src/core/index.ts.
const INDEX_DTS = `import type { IndoorMapHandle, MapSdkOptions } from './types.js';
export declare function mountIndoorMap(container: HTMLElement, options: MapSdkOptions): IndoorMapHandle;
export { cxaiNavigationPlugin } from './plugins/cxai.js';
export { clearJibestreamCaches } from './core/jibestream.js';
export type * from './types.js';
export { DEFAULT_STRINGS } from './strings.js';
export { DEFAULT_THEME } from './theme.js';
`;

const CORE_DTS = `export * from './core/index.js';
`;

export default defineConfig({
  plugins: [
    svelte(),
    cssInjectedByJs('index'),
    dts({
      rollupTypes: false,
      entryRoot: 'src',
      // The TS-only public surface. src/index.ts and the Svelte view layer
      // (mount.svelte.ts, src/ui/) are deliberately excluded — their public
      // types are covered by the hand-authored entries below.
      include: [
        'src/types.ts',
        'src/strings.ts',
        'src/theme.ts',
        'src/plugins/**/*.ts',
        'src/core/**/*.ts',
      ],
      // entryRoot alone still nests output under dist/src/ — flatten it so
      // the hand-authored entries' relative imports (./types.js, ./core/…)
      // resolve.
      beforeWriteFile: (filePath, content) => ({
        filePath: filePath.replace('/dist/src/', '/dist/'),
        content,
      }),
      afterBuild() {
        writeFileSync(fileURLToPath(new URL('dist/index.d.ts', import.meta.url)), INDEX_DTS);
        writeFileSync(fileURLToPath(new URL('dist/core.d.ts', import.meta.url)), CORE_DTS);
      },
    }),
  ],
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        core: 'src/core/index.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => (entryName === 'index' ? 'map-sdk.js' : `${entryName}.js`),
    },
    sourcemap: true,
  },
});
