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
type IndoorMapExports = Pick<
	IndoorMapHandle,
	'confirmBooking' | 'focusResource' | 'setFloor' | 'getSelection' | 'clearSelection' | 'getFloors'
>;

/**
 * Component event name → `options.on` callback key. The DOM event name is
 * `mapsdk:<key>` (types.ts: the callback key with "on" dropped, lowercased).
 * The mapped type makes the table compile-checked exhaustive: adding a
 * callback to MapEventCallbacks (or typo-ing a key here) is a type error.
 */
type EventNameOf<K> = K extends `on${infer R}` ? Lowercase<R> : never;
const EVENT_CALLBACKS: { [K in keyof MapEventCallbacks as EventNameOf<K>]: K } = {
	ready: 'onReady',
	resourceselect: 'onResourceSelect',
	floorchange: 'onFloorChange',
	bookrequested: 'onBookRequested',
	bookingstatechange: 'onBookingStateChange',
	navigaterequested: 'onNavigateRequested',
	fullscreenchange: 'onFullscreenChange',
	locationselect: 'onLocationSelect',
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
	// postMessage mirror (iframe / WebView hosts): normalised once; null = off.
	const pm = options.postMessage === true ? {} : (options.postMessage || null);

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

	// Theme lives on the component: the `theme` prop flows into the view's
	// themeStyle, which applies the --map-* custom properties on the SDK root
	// inside this wrapper (every --map-* consumer is inside the component).
	container.appendChild(wrapper);

	// ── Events: options.on callback + mapsdk:* CustomEvent, both per emit ──
	let destroyed = false;
	function emit(name: string, detail: unknown): void {
		if (destroyed) return;
		// The component emits arbitrary strings; the exhaustive table narrows
		// known names to their callback key (unknown names → no callback,
		// CustomEvent still fires).
		const key = (EVENT_CALLBACKS as Record<string, keyof MapEventCallbacks | undefined>)[name];
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
		// Third channel, opt-in: mirror to window.postMessage so an embedding
		// page (iframe) or a WebView shell can listen without reaching into the
		// frame's DOM. Resources reach the view through the reactive `props`
		// bridge, so resource-carrying details (resourceselect, bookrequested,
		// bookingstatechange, navigaterequested) are Svelte $state PROXIES —
		// which structured clone rejects. Snapshot to plain data first. A
		// genuinely non-cloneable payload (a function inside bookingContext)
		// still throws: drop that one message, never break the map.
		if (pm && typeof window !== 'undefined') {
			try {
				const target = pm.target === 'self' ? window : window.parent;
				const plain = $state.snapshot(detail);
				target?.postMessage({ source: 'map-sdk', type: name, detail: plain }, pm.targetOrigin ?? '*');
			} catch (e) {
				logger?.warn?.(`[map-sdk] postMessage mirror of "${name}" failed (non-cloneable detail?)`, e);
			}
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
		// Seam S2: gate + defer NavigationKit (CDN) loading in the engine.
		// Default true (auto-reroute on). Public MapSdkOptions.autoReroute is
		// added by the packaging agent; read it off options here (TS reconciles
		// once the type lands).
		autoReroute: options.autoReroute ?? true,
		gps: options.gps ?? false,
		bookable: options.bookable ?? true,
		booking: options.booking,
		colleagues: options.colleagues,
		images: options.images,
		navigation: options.navigation,
		locationSelect: options.locationSelect ?? false,
		showCards: options.showCards ?? true,
		showFloorSelector: options.showFloorSelector ?? 'auto',
		floorSelectorStyle: options.floorSelectorStyle ?? 'auto',
		allFloors: options.allFloors ?? false,
		initialFloor: options.initialFloor,
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
		getSelection() {
			return destroyed ? null : api.getSelection();
		},
		clearSelection(): void {
			if (destroyed) return;
			api.clearSelection();
		},
		getFloors() {
			return destroyed ? [] : api.getFloors();
		},
		update(patch: {
			provider?: Partial<Pick<MapSdkOptions['provider'], 'floorLabels' | 'kioskCoordinate' | 'venueBounds' | 'venueCenter'>>;
			strings?: Partial<MapStrings>;
			theme?: Partial<MapTheme>;
		}): void {
			if (destroyed || !patch) return;
			if (patch.provider) {
				// floorLabels applies IN PLACE (the floor strip re-renders its
				// tab labels reactively — no engine rebuild). kioskCoordinate
				// participates in the component's rebuild signature (it changes
				// the synthetic route start / kiosk-first floor pick).
				// venueBounds/venueCenter update in place.
				props.provider = { ...props.provider, ...patch.provider };
			}
			if (patch.strings) props.strings = { ...(props.strings ?? {}), ...patch.strings };
			if (patch.theme) props.theme = { ...(props.theme ?? {}), ...patch.theme };
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
