/**
 * mountIndoorMap — the framework-agnostic public entry point.
 *
 * Bridges the plain-JS options object to the compiled Svelte view:
 *  - a `$state` props object keeps `handle.setResources()` / `setItinerary()` /
 *    `update()` reactive after mount (this file is `.svelte.ts` so runes
 *    compile);
 *  - the component's single `emit(name, detail)` outbound channel fans out to
 *    BOTH the `options.on.onX` callback and a bubbling DOM CustomEvent
 *    `mapsdk:<name>` on the host container (decision log #3: native WebView
 *    shells listen without bundler interop);
 *  - the SDK owns a wrapper div inside the host container; fullscreen mode
 *    (decision log #4) fixes that wrapper over the viewport and locks body
 *    scroll — new work, the chat popup never locked scroll.
 */
import { mount, unmount } from 'svelte';
import IndoorMap from './ui/IndoorMap.svelte';
import type {
	IndoorMapHandle,
	ItineraryOptions,
	MapEventCallbacks,
	MapResource,
	MapSdkOptions,
	MapStrings,
	MapTheme,
} from './types.js';

/** Imperative methods exported by the view component. */
interface IndoorMapExports {
	confirmBooking(id: string | number): void;
	focusResource(id: string | number): void;
	setFloor(mapId: number): void;
}

/**
 * Component event name → `options.on` callback key. The DOM event name is
 * `mapsdk:<key>` (types.ts: the callback key with "on" dropped, lowercased).
 */
const EVENT_CALLBACKS: Record<string, keyof MapEventCallbacks | undefined> = {
	ready: 'onReady',
	resourceselect: 'onResourceSelect',
	floorchange: 'onFloorChange',
	bookrequested: 'onBookRequested',
	bookingstatechange: 'onBookingStateChange',
	navigaterequested: 'onNavigateRequested',
	fullscreenchange: 'onFullscreenChange',
	error: 'onError',
};

/**
 * Above any sane host chrome, below the browser's own UI. Matches the
 * "top-most layer" convention (max int32 minus headroom for host toasts).
 */
const FULLSCREEN_Z_INDEX = '2147483000';

// Body scroll-lock is refcounted at module level so overlapping fullscreen
// instances don't fight over the save/restore: first-in saves the host's
// inline overflow and locks, last-out restores it. (Per-handle saving broke
// with two instances: A exits and unlocks while B is still fullscreen, then B
// exits and restores 'hidden' — permanently locking scroll.)
let bodyScrollLocks = 0;
let savedBodyOverflow = '';
function lockBodyScroll(): void {
	if (bodyScrollLocks++ === 0) {
		// Save the body's PRIOR inline overflow so the final unlock restores
		// exactly what the host had (including "no inline value").
		savedBodyOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
	}
}
function unlockBodyScroll(): void {
	if (bodyScrollLocks > 0 && --bodyScrollLocks === 0) {
		document.body.style.overflow = savedBodyOverflow;
		savedBodyOverflow = '';
	}
}

export function mountIndoorMap(
	container: HTMLElement,
	options: MapSdkOptions,
): IndoorMapHandle {
	// ── Validation ─────────────────────────────────────────────────────────
	if (!container || typeof (container as { appendChild?: unknown }).appendChild !== 'function') {
		throw new Error('mountIndoorMap: a container HTMLElement is required as the first argument');
	}
	if (!options || typeof options !== 'object') {
		throw new Error('mountIndoorMap: an options object with `provider` is required');
	}
	if (!options.provider) {
		throw new Error('mountIndoorMap: options.provider (Jibestream venue + auth config) is required');
	}
	if (!options.provider.auth) {
		throw new Error('mountIndoorMap: options.provider.auth is required — pass { getToken } (production) or { clientId, clientSecret } (dev only)');
	}
	const logger = options.logger;
	const mode = options.mode ?? 'container';

	// The engine snapshots the container size at init — a 0×0 rect breaks the
	// view transform, so the component will surface an error. Warn early with
	// an actionable message. (Skipped for fullscreen mounts: the wrapper is
	// viewport-sized regardless of the host container.)
	if (mode !== 'fullscreen') {
		const rect = container.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			logger?.warn?.(
				'[map-sdk] container has a 0×0 rect at mount — the map engine errors on unsized containers; give the container a width/height before mounting',
				{ width: rect.width, height: rect.height },
			);
		}
	}

	// ── Wrapper (the element the SDK owns) ─────────────────────────────────
	const wrapper = document.createElement('div');
	wrapper.className = 'map-sdk-root';
	wrapper.style.position = 'relative';
	wrapper.style.width = '100%';
	wrapper.style.height = '100%';

	// Host theme overrides as inline --map-* custom properties on the wrapper.
	// DEFAULT_THEME is deliberately NOT applied inline: the component CSS keeps
	// the original per-usage fallbacks (e.g. the teardrop pin's #0070F0 vs
	// --map-primary's predominant #6366f1, the #fff card vs the rgba canvas
	// backdrop under the same --map-surface-elevated token) — inlining the
	// defaults would override those minority fallbacks and change today's
	// look. See src/theme.ts. Keys without a leading "--" get the --map-
	// prefix, mirroring the component's own themeStyle normalization.
	let appliedThemeKeys: string[] = [];
	function applyTheme(theme: Partial<MapTheme> | undefined): void {
		for (const key of appliedThemeKeys) wrapper.style.removeProperty(key);
		appliedThemeKeys = [];
		if (!theme) return;
		for (const [k, v] of Object.entries(theme)) {
			if (v == null) continue;
			const key = k.startsWith('--') ? k : `--map-${k}`;
			wrapper.style.setProperty(key, v);
			appliedThemeKeys.push(key);
		}
	}
	applyTheme(options.theme);
	container.appendChild(wrapper);

	// ── Events: options.on callback + mapsdk:* CustomEvent, both per emit ──
	let destroyed = false;
	function emit(name: string, detail: unknown): void {
		if (destroyed) return;
		const key = EVENT_CALLBACKS[name];
		const cb = key ? (options.on?.[key] as ((detail: unknown) => void) | undefined) : undefined;
		if (cb) {
			// A throwing host callback must not break the map's internal flow
			// (emit fires inside effects and promise chains).
			try { cb(detail); }
			catch (e) { logger?.warn?.(`[map-sdk] options.on.${String(key)} threw`, e); }
		}
		try {
			container.dispatchEvent(new CustomEvent(`mapsdk:${name}`, {
				detail,
				bubbles: true,
				composed: true,
			}));
		} catch (e) {
			logger?.warn?.('[map-sdk] CustomEvent dispatch failed', e);
		}
	}

	// ── Fullscreen (decision log #4) ───────────────────────────────────────
	let fullscreen = false;
	function applyFullscreen(on: boolean): void {
		if (on) {
			lockBodyScroll();
			wrapper.style.position = 'fixed';
			wrapper.style.inset = '0';
			// inset:0 stretches the fixed wrapper to the viewport.
			wrapper.style.width = 'auto';
			wrapper.style.height = 'auto';
			wrapper.style.zIndex = FULLSCREEN_Z_INDEX;
		} else {
			unlockBodyScroll();
			wrapper.style.position = 'relative';
			wrapper.style.inset = '';
			wrapper.style.width = '100%';
			wrapper.style.height = '100%';
			wrapper.style.zIndex = '';
		}
	}
	function setFullscreen(next: boolean): void {
		if (destroyed) return;
		const on = !!next;
		if (on === fullscreen) return;
		fullscreen = on;
		applyFullscreen(on);
		emit('fullscreenchange', on);
	}

	// mode:'fullscreen' applies the fixed wrapper BEFORE the component mounts
	// so the engine's initial size snapshot is already viewport-sized. The
	// fullscreenchange emit happens after mount, below, so callbacks observe a
	// live handle.
	if (mode === 'fullscreen') {
		fullscreen = true;
		applyFullscreen(true);
	}

	// ── Reactive props bridge ($state survives past this call) ─────────────
	const props = $state({
		provider: options.provider,
		resources: options.resources ?? [],
		focusResourceId: options.focusResourceId,
		itinerary: options.itinerary,
		itineraryOptions: options.itineraryOptions,
		gps: options.gps ?? false,
		booking: options.booking,
		colleagues: options.colleagues,
		images: options.images,
		navigation: options.navigation,
		strings: options.strings,
		theme: options.theme,
		logger: options.logger,
		emit,
	});

	const app = mount(IndoorMap, { target: wrapper, props });
	const api = app as unknown as IndoorMapExports;

	if (mode === 'fullscreen') emit('fullscreenchange', true);

	// ── Handle ─────────────────────────────────────────────────────────────
	return {
		setResources(resources: MapResource[]): void {
			if (destroyed) return;
			props.resources = resources ?? [];
		},
		setItinerary(ids: Array<string | number> | null, opts?: ItineraryOptions): void {
			if (destroyed) return;
			// The view treats undefined/[] as "clear"; keep prior draw options
			// when the caller doesn't pass new ones.
			props.itinerary = ids ?? undefined;
			if (opts !== undefined) props.itineraryOptions = opts;
		},
		setFloor(mapId: number): void {
			if (destroyed) return;
			api.setFloor(mapId);
		},
		focusResource(id: string | number): void {
			if (destroyed) return;
			api.focusResource(id);
		},
		confirmBooking(id: string | number): void {
			if (destroyed) return;
			api.confirmBooking(id);
		},
		setFullscreen,
		update(patch: {
			provider?: Partial<Pick<MapSdkOptions['provider'], 'floorLabels' | 'kioskCoordinate' | 'venueBounds' | 'venueCenter'>>;
			strings?: Partial<MapStrings>;
			theme?: Partial<MapTheme>;
		}): void {
			if (destroyed || !patch) return;
			if (patch.provider) {
				// floorLabels/kioskCoordinate participate in the component's
				// rebuild signature — a late floorLabels fetch re-renders the
				// floor strip (REQUIREMENTS §3 coupling #1: preserve config
				// reactivity). venueBounds/venueCenter update in place.
				props.provider = { ...props.provider, ...patch.provider };
			}
			if (patch.strings) props.strings = { ...(props.strings ?? {}), ...patch.strings };
			if (patch.theme) {
				props.theme = { ...(props.theme ?? {}), ...patch.theme };
				applyTheme(props.theme);
			}
		},
		destroy(): void {
			if (destroyed) return;
			// Squelch any emits during component teardown before unmounting.
			destroyed = true;
			try { unmount(app); }
			catch (e) { logger?.warn?.('[map-sdk] unmount threw during destroy()', e); }
			// Restore the host's scroll + remove the SDK-owned wrapper.
			if (fullscreen) {
				applyFullscreen(false);
				fullscreen = false;
			}
			wrapper.remove();
		},
	};
}
