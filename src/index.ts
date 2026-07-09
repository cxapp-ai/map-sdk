/**
 * @cxapp-ai/map-sdk — mount API.
 *
 * Svelte is an internal detail: this module compiles to a plain JS function.
 * The actual mounting lives in mount.svelte.ts (runes file) so the options →
 * component-props bridge stays reactive after `handle.setResources()` etc.
 */
export { mountIndoorMap } from './mount.svelte.js';
export { cxaiNavigationPlugin } from './plugins/cxai.js';
// Hard-reset escape hatch for the per-config token/venue caches (rarely
// needed — entries are keyed by config + auth identity; see core/jibestream).
export { clearJibestreamCaches } from './core/jibestream.js';
export type * from './types.js';
export { DEFAULT_STRINGS } from './strings.js';
export { DEFAULT_THEME } from './theme.js';
