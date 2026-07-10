import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
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
// instead we emit per-file d.ts for the pure-TS surface and:
//   - `.`      → dist/index.d.ts is src/index.public.d.ts copied verbatim
//                (committed, tsc-checked; drift-guarded by
//                src/index.assert-public.ts under `npm run check`);
//   - `./core` → dist/core/index.d.ts, emitted directly from
//                src/core/index.ts by the dts plugin.

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const distDir = path.join(rootDir, 'dist');

export default defineConfig({
  plugins: [
    svelte(),
    cssInjectedByJs('index'),
    dts({
      rollupTypes: false,
      entryRoot: 'src',
      // The TS-only public surface. src/index.ts and the Svelte view layer
      // (mount.svelte.ts, src/ui/) are deliberately excluded — their public
      // types are covered by the hand-authored src/index.public.d.ts.
      include: [
        'src/types.ts',
        'src/strings.ts',
        'src/theme.ts',
        'src/plugins/**/*.ts',
        'src/core/**/*.ts',
      ],
      // entryRoot alone still nests output under dist/src/ — flatten it so
      // the hand-authored entry's relative imports (./types.js, ./core/…)
      // resolve.
      beforeWriteFile: (filePath, content) => {
        const srcDir = path.join(distDir, 'src');
        const rel = path.relative(srcDir, filePath);
        // Only flatten files nested under dist/src/; leave anything else as-is.
        const flattened = rel.startsWith('..') || path.isAbsolute(rel)
          ? filePath
          : path.join(distDir, rel);
        return { filePath: flattened, content };
      },
      afterBuild() {
        copyFileSync(path.join(rootDir, 'src', 'index.public.d.ts'), path.join(distDir, 'index.d.ts'));
        // Post-condition: every declaration the two entry d.ts files import
        // must exist, or consumers get a silently-broken type surface (e.g.
        // if the flattening above or the include list regresses).
        const required = [
          'index.d.ts',
          'types.d.ts',
          'strings.d.ts',
          'theme.d.ts',
          'plugins/cxai.d.ts',
          'core/index.d.ts',
          'core/engine.d.ts',
          'core/jibestream.d.ts',
        ];
        const missing = required.filter((f) => !existsSync(path.join(distDir, f)));
        if (missing.length > 0) {
          throw new Error(
            `[map-sdk] declaration post-condition failed — missing: ${missing.join(', ')} `
            + '(check the dts include list / beforeWriteFile flattening in vite.config.ts)',
          );
        }
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
    // jmap.js is a webpack-UMD bundle of PixiJS that reassigns its own module
    // exports at runtime. Bundling it into this ESM output makes Rollup expose
    // those exports as getter-only live bindings, so on the 2nd map mount Pixi
    // throws "Cannot set property glCore … which has only a getter". Keep it
    // EXTERNAL here: the ESM entry emits `import('jmap.js')` and the consumer's
    // bundler transforms Pixi once (the proven-working path). jmap.js is a
    // runtime `dependency` so it installs automatically. The IIFE build
    // (vite.config.iife.ts) still inlines it for no-bundler WebView hosts.
    rollupOptions: {
      external: ['jmap.js'],
    },
    sourcemap: true,
  },
});
