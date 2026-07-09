/**
 * Hand-authored public declarations for the default entry (`.`).
 *
 * Copied verbatim to dist/index.d.ts at build time (vite.config.ts
 * afterBuild): vite-plugin-dts with `rollupTypes: true` (API Extractor)
 * cannot trace the .svelte/.svelte.ts mount layer and emits an empty
 * `export {}` entry file, so the entry declaration is authored here instead.
 * Relative imports resolve BOTH in-tree (src/types.ts, …) and in dist/
 * (dist/types.d.ts, …) because the dts output is flattened to mirror src/.
 *
 * Drift guard: src/index.assert-public.ts asserts mutual assignability with
 * the real src/index.ts surface, so `npm run check` fails when they diverge.
 */
import type { IndoorMapHandle, MapSdkOptions } from './types.js';
export declare function mountIndoorMap(container: HTMLElement, options: MapSdkOptions): IndoorMapHandle;
export { cxaiNavigationPlugin } from './plugins/cxai.js';
export { clearJibestreamCaches } from './core/jibestream.js';
export type * from './types.js';
export { DEFAULT_STRINGS } from './strings.js';
export { DEFAULT_THEME } from './theme.js';
