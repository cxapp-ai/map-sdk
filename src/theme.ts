import type { MapTheme } from './types.js';

/**
 * Default --map-* tokens.
 *
 * Values are the hardcoded fallbacks from ResourceMinimap.svelte's
 * var(--chat-*, fallback) usages — those fallbacks ARE the current popup
 * appearance (the dialog portaled out of the themed chat root, so it never
 * consumed --chat-* at runtime). Token name = the --chat-* name with the
 * prefix swapped to --map-*.
 *
 * NOTE: these defaults are NOT applied as inline properties by the view —
 * every CSS usage keeps its own original fallback value, and a couple of
 * tokens had different per-usage fallbacks in the original (preserved
 * verbatim in the component CSS):
 *   - --map-primary: #6366f1 everywhere except the teardrop pin (#0070F0)
 *   - --map-border: rgba(0,0,0,0.06|0.08|0.1|0.18) depending on the element
 *   - --map-surface-elevated: rgba(0,0,0,0.04) canvas backdrop, #fff cards
 * The values below are the predominant fallback for each token. Setting a
 * token (via `options.theme` or a host stylesheet) overrides ALL usages of
 * it uniformly.
 *
 * Opt-in pin tokens, deliberately absent here (unset, their fallbacks keep
 * the historical look): --map-pin-selected (selected pin body; falls back to
 * the pin's --map-primary, #0070F0) and --map-pin-added (`added` resource
 * pins; #0070F0).
 */
export const DEFAULT_THEME: MapTheme = {
	'--map-primary': '#6366f1',
	'--map-accent': '#1d6ef5',
	'--map-bg': '#ffffff',
	'--map-text': '#0f172a',
	'--map-text-muted': '#64748b',
	'--map-border': 'rgba(0,0,0,0.08)',
	'--map-surface': 'rgba(0,0,0,0.04)',
	'--map-surface-elevated': 'rgba(0,0,0,0.04)',
	'--map-font-family': 'system-ui, -apple-system, sans-serif',
};
