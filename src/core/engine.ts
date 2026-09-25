// Live, interactive Jibestream minimap. Each `MinimapInstance` mounts its own
// JMap controller into a caller-supplied container, enables pan + pinch +
// wheel zoom, and exposes per-pin world coordinates plus a world→screen
// projection so the host component can render HTML pin overlays that track
// pan/zoom in real time.
//
// JMap-specific quirks (learned the hard way):
//   - getUnitsFromDestination is SYNC in jmap.js v4 (the callback variant
//     never fires).
//   - The Controller's strict-typed APIs (styleShapes, fitBoundsInView)
//     reject plain objects; the inner mapView accepts them.
//   - Pin/icon rendering: we draw HTML overlays instead of going through
//     JMap's icon API because the icon class shape isn't documented in this
//     bundled build.

import {
	type Destination,
	type VenueData,
	loadVenue,
	resolveDestination,
	getToken,
	peekTokenExpiry,
	jibLogWith,
	makeJibLog,
} from './jibestream.js';

import type {
	JibestreamConfig,
	MapResource,
	ColleagueBooking,
	MapLogger,
	FloorSummary,
	HighlightStyle,
	LocationCandidate,
	MapSelection,
	ResolveLocationOptions,
	SelectableKind,
} from '../types.js';

export interface FloorInfo {
	mapId: number;
	mapName: string;
	pins: PinInfo[];
}

export interface PinInfo {
	resource: MapResource;
	/** World-coordinate centre of the unit (used by the projection helper). */
	worldX: number;
	worldY: number;
}

export interface ColleagueMarker {
	booking: ColleagueBooking;
	/** Floor the colleague is booked on — host filters markers to current floor. */
	mapId: number;
	worldX: number;
	worldY: number;
}

export interface MinimapInstanceState {
	floors: FloorInfo[];
	dominantMapId: number | null;
	unresolved: number;
}

const MAP_SETTLE_MS = 600;

// Injectable logger (coupling #13): the chat SDK's logger import is replaced
// by an optional MapLogger threaded through createMinimap opts. No logger =
// no output. jibLogWith/makeJibLog (imported from ./jibestream.js) preserve
// the `[jibestream:<stage>]` prefix format.

// --- JMap typings -------------------------------------------------------------

type JmapModule = {
	core: {
		JCore: new (opts: Record<string, unknown>) => JCore;
		Auth: new (clientId: string, clientSecret: string) => unknown;
	};
	JController: new (opts: Record<string, unknown>) => JController;
	Style?: new (opts: Record<string, unknown>) => unknown;
	Font?: new (opts: Record<string, unknown>) => unknown;
};

// Host-supplied-token JMap auth shim. JMap's bundled `Auth` class assumes a
// `client_credentials` flow it drives itself. With a host-supplied token, we
// don't have a secret to hand JMap — so we manufacture an auth-shaped object
// covering every callback/property shape jmap.js v4 is known to invoke.
//
// Token freshness:
//   - Async getters (getToken/getAccessToken/authenticate/authorize/headers)
//     route through getToken(cfg), which transparently re-invokes the host
//     callback once the cached token is within 30s of expiry.
//   - Sync property reads (.token/.accessToken/.access_token/.bearer) return
//     a `currentToken` local. To keep this current even when JMap never
//     invokes an async getter (e.g. it reads .token directly to build a
//     header), a background timer fires (expiresAt - 30s) after each
//     successful refresh and updates currentToken in place.
//   - Caller MUST call dispose() when the JMap session ends so the timer
//     doesn't leak or fire post-destroy.
//
// Best-effort: jmap.js is not source-available, so if a future build reads a
// property shape we haven't covered, the map fails to render with a visible
// auth error — extend this shim then.
const REFRESH_SKEW_MS = 30_000;
const MIN_REFRESH_INTERVAL_MS = 60_000; // floor to avoid tight loops on tiny TTLs.

async function buildHostTokenAuth(
	cfg: JibestreamConfig,
	logger?: MapLogger,
	onEngineError?: (err: { stage: string; message: string; cause?: unknown }) => void,
): Promise<{
	auth: unknown;
	dispose: () => void;
	start: () => void;
}> {
	const jibLog = makeJibLog(logger);
	let currentToken = await getToken(cfg, logger);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	// The background-refresh timer is NOT armed until start() is called at the
	// end of a successful createMinimap. Any throw during mount (after the shim
	// is built but before the instance is returned) therefore leaves no armed
	// timer to strand — nothing keeps calling the host's getToken() for a dead
	// mount. refresh() may still run during init (JMap pulling a token); its
	// scheduleNext() call no-ops until started.
	let started = false;

	const scheduleNext = (): void => {
		if (timer) { clearTimeout(timer); timer = null; }
		if (disposed || !started) return;
		const expiresAt = peekTokenExpiry(cfg);
		if (!expiresAt) return; // No cache info — falls back to async-getter-driven refresh.
		const wait = Math.max(MIN_REFRESH_INTERVAL_MS, expiresAt - Date.now() - REFRESH_SKEW_MS);
		timer = setTimeout(() => {
			void refresh().catch((e) => {
				// This is the ONLY silent-until-now post-init failure path: the
				// mount succeeded, then a background bearer refresh threw (host
				// getToken rejecting, mid-session 401). Keep the jibLog for
				// parity, and surface it through onEngineError so the view can
				// emit('error', …) — otherwise auth expiry dies silently.
				jibLog('auth', 'background refresh failed', e);
				try {
					onEngineError?.({
						stage: 'auth-refresh',
						message: e instanceof Error ? e.message : String(e),
						cause: e,
					});
				} catch { /* host callback must never break the shim */ }
			});
		}, wait);
	};

	const refresh = async (cb?: (err: unknown, t: string) => void): Promise<string> => {
		if (disposed) {
			if (typeof cb === 'function') cb(null, currentToken);
			return currentToken;
		}
		try {
			currentToken = await getToken(cfg, logger);
			scheduleNext();
			if (typeof cb === 'function') cb(null, currentToken);
			return currentToken;
		} catch (e) {
			// Node convention: callback IS the error channel. If a callback
			// was provided, deliver the error through it and resolve the
			// Promise — callers using the callback API discard the returned
			// Promise, so a rejection here would surface as an unhandled
			// rejection on every failure (loud Sentry noise during a map
			// session). If no callback, propagate via Promise rejection so
			// `await refresh()` callers see the error.
			if (typeof cb === 'function') {
				cb(e, '');
				return '';
			}
			throw e;
		}
	};

	// NB: the timer is intentionally NOT armed here — start() arms it once the
	// mount has fully succeeded (see the `started` flag above).

	// JCore reads `auth._[0]` and `auth._[1]` to feed `setCredentials({client_id, client_secret})`.
	// With host-supplied tokens we don't have or want client credentials in the
	// browser, but JMap will crash with "Cannot read properties of undefined (reading '0')"
	// on construction unless `_` is present. Empty strings keep JMap's
	// setCredentials happy without leaking secrets — JMap won't call
	// /auth/token because our shim's getAccessToken intercepts the request.
	const auth = {
		_: ['', ''] as [string, string],
		get token() { return currentToken; },
		get accessToken() { return currentToken; },
		get access_token() { return currentToken; },
		get bearer() { return currentToken; },
		getToken: refresh,
		getAccessToken: refresh,
		authenticate: refresh,
		authorize: refresh,
		headers: async () => ({ Authorization: `Bearer ${await refresh()}` }),
	};

	const dispose = (): void => {
		disposed = true;
		if (timer) { clearTimeout(timer); timer = null; }
	};

	// Arm the background refresh. createMinimap calls this only after the mount
	// has fully succeeded, so a failed mount never leaves a live timer running.
	const start = (): void => {
		if (disposed) return;
		started = true;
		scheduleNext();
	};

	return { auth, dispose, start };
}

interface JCore {
	populateVenueWithDefaultBuilding: (venueId: number, cb: (err: unknown, av: unknown) => void) => void;
}

interface ActiveVenueLike {
	getClosestWaypointToCoordinatesOnMap?: (coords: [number, number], map: unknown) => unknown;
}

interface JungleLike {
	Text?: new (opts: Record<string, unknown>) => unknown;
}

interface MapViewLike {
	guaranteeMapLayer?: (name: string) => MapLayerLike | undefined;
	getLayerByName?: (name: string) => MapLayerLike | undefined;
}

interface MapLayerLike {
	addText?: (text: unknown) => unknown;
	clearTexts?: () => unknown;
}

interface JController {
	showDefaultMap?: () => void;
	showMap?: (map: unknown) => void;
	getUnitsFromDestination?: (dest: unknown) => unknown[];
	getUnitsFromMap?: (map: unknown) => unknown[];
	getViewportPointFromMapPoint?: (point: [number, number]) => [number, number];
	addDragPan?: () => void;
	addPinchZoom?: () => void;
	addMouseWheelZoom?: () => void;
	destroy?: () => void;
	activeVenue?: ActiveVenueLike;
	jungle?: JungleLike;
	// Wayfinding (jmap.js v4). wayfindBetweenWaypoints returns an array of
	// path segments — one per floor traversed. drawWayfindingPath expects the
	// whole segments array (it calls .map(seg => Line.createFromWaypoints(...))
	// internally); calling it per-segment throws inside JMap. Paths accumulate
	// on the canvas when limitConcurrentPaths is false; clearWayfindingPath
	// removes them.
	wayfindBetweenWaypoints?: (
		from: unknown,
		to: unknown,
		accessibility?: unknown,
		obstacles?: unknown,
	) => unknown[];
	drawWayfindingPath?: (path: unknown, style?: unknown) => unknown;
	clearWayfindingPath?: () => unknown;
	limitConcurrentPaths?: boolean;
	renderCurrentMapView?: () => unknown;
	_getParsedMapView?: (map: unknown) => MapViewLike | undefined;
	showAllPathTypes?: () => void;
	// Tap plumbing (jmap.js v4). enableGenericTapHandler REPLACES the single
	// generic-tap slot; the callback's event carries `localPoint` = [x, y] in
	// the current map's local (world) frame, set by the stage's hit-test.
	enableGenericTapHandler?: (cb: (e: { localPoint?: unknown }) => void) => unknown;
	// Unit styling (selection highlight). styleShapes wants a jmap.Style.
	styleShapes?: (shapes: unknown[], style: unknown) => unknown;
}

interface UnitBounds { x: number; y: number; width: number; height: number; }

// JMap stores a Map model's width/height under a `_` private bag (the public
// Map instance only exposes `_` and `uris` as enumerable keys), so
// `mapObj.size` is undefined — read `_.size`, falling back to `_.width`/
// `_.height` if present. See floorSizeWorld in createMinimap.
type JMapPrivateSizeBag = {
	_?: { size?: { width?: number; height?: number }; width?: number; height?: number };
};

// --- JACS request interceptor ------------------------------------------------

interface JacsRequestOpts { url: string; headers?: Record<string, string>; form?: Record<string, string>; }
type JacsRequestCb = (err: unknown, response: { statusCode: number }, body: string) => void;
interface JacsRequestFn {
	(opts: JacsRequestOpts, cb: JacsRequestCb): void;
	post: (opts: JacsRequestOpts, cb: JacsRequestCb) => void;
}

/**
 * JCore `request` override. Two responsibilities:
 *
 *   1. GET path: inject `?mapProfileId=N` into JACS URLs. JMap v4's URL
 *      builder appends `?v=4.12` but has no notion of map profiles, so
 *      service accounts that lack a default profile 401 on every call.
 *
 *   2. POST path: short-circuit `/JACS/api/auth/token` requests. With a
 *      host-supplied token callback, JMap's own client_credentials POST
 *      runs with empty client_id/client_secret (the auth shim's `_:
 *      ['', '']` placeholder) and 401s. Intercept the auth POST and
 *      return our shim's token in the JACS response shape.
 *
 * Signatures (reverse-engineered from jmap.min.js):
 *   request({url, headers}, (err, {statusCode}, bodyString) => ...)
 *   request.post({url, headers, form}, (err, {statusCode}, bodyString) => ...)
 */
// `getBearer` is intentionally optional. When provided, the post() interceptor
// short-circuits JMap's /JACS/api/auth/token POST and returns the host-supplied
// bearer in JACS shape — this is the host-token path (cfg.auth.getToken set).
// When omitted, we MUST NOT hijack the auth POST: JMap is then responsible for
// performing a real client_credentials exchange against the configured
// clientId/clientSecret. Hijacking it with an empty token (the previous
// behaviour) silently broke SDK-direct auth whenever mapProfileId was set.
function makeJacsRequest(mapProfileId: number, getBearer?: () => Promise<string>): JacsRequestFn {
	const get = (opts: JacsRequestOpts, cb: JacsRequestCb): void => {
		let finalUrl = opts.url;
		try {
			const u = new URL(opts.url);
			if (!u.searchParams.has('mapProfileId')) {
				u.searchParams.set('mapProfileId', String(mapProfileId));
			}
			finalUrl = u.toString();
		} catch {
			const sep = opts.url.includes('?') ? '&' : '?';
			finalUrl = `${opts.url}${sep}mapProfileId=${mapProfileId}`;
		}
		fetch(finalUrl, { headers: opts.headers ?? {} })
			.then(async (res) => cb(null, { statusCode: res.status }, await res.text()))
			.catch((err) => cb(err, { statusCode: 0 }, ''));
	};
	const fn = get as JacsRequestFn;
	fn.post = (opts: JacsRequestOpts, cb: JacsRequestCb): void => {
		// Auth-token POST: only hijack when the host supplied a token source.
		// Without a host token we MUST forward the request so JMap can do its
		// real client_credentials exchange — otherwise mapProfileId-mode with
		// SDK-direct auth (configured clientId/clientSecret) silently breaks.
		if (getBearer && opts.url.includes('/JACS/api/auth/token')) {
			getBearer()
				.then((token) => {
					const body = JSON.stringify({
						access_token: token,
						token_type: 'bearer',
						expires_in: 1799,
						scope: 'sdk.read',
					});
					cb(null, { statusCode: 200 }, body);
				})
				.catch((err) => cb(err, { statusCode: 401 }, ''));
			return;
		}
		// Pass-through: real auth-token POST (no host token) OR any other
		// POST JMap might surface. JMap's request interface separates
		// `form` from `headers` because its native transport (e.g. the
		// `request` npm module) auto-applies application/x-www-form-urlencoded
		// for form bodies — so opts.headers almost never carries Content-Type.
		// fetch() defaults string bodies to text/plain, which JACS rejects;
		// inject Content-Type ourselves when forwarding a form body, but
		// don't clobber any caller-supplied header.
		const form = opts.form
			? new URLSearchParams(opts.form).toString()
			: undefined;
		const headers: Record<string, string> = { ...(opts.headers ?? {}) };
		if (form !== undefined) {
			const hasContentType = Object.keys(headers).some(
				(k) => k.toLowerCase() === 'content-type',
			);
			if (!hasContentType) headers['Content-Type'] = 'application/x-www-form-urlencoded';
		}
		fetch(opts.url, { method: 'POST', headers, body: form })
			.then(async (res) => cb(null, { statusCode: res.status }, await res.text()))
			.catch((err) => cb(err, { statusCode: 0 }, ''));
	};
	return fn;
}

// --- Module-level: shared module load + token cache --------------------------

let jmapModulePromise: Promise<JmapModule> | null = null;
async function loadJmap(): Promise<JmapModule> {
	if (jmapModulePromise) return jmapModulePromise;
	jmapModulePromise = (async () => {
		const mod = (await import('jmap.js')) as unknown as JmapModule | { default: JmapModule };
		return (mod as { default?: JmapModule }).default ?? (mod as JmapModule);
	})();
	return jmapModulePromise;
}

// NavigationKit — CDN-only plugin (not on npm); inject as a UMD script that
// attaches `window.NavigationKit`, then `new NavigationKit(control, {})`. Drives
// OOTB veer-based auto-reroute; entitlement-gated per venue (loads regardless —
// verify on-venue).
type NavigationKitInstance = {
	hasUserVeeredOffRoute: (path: unknown, thresholdMm: number) => boolean;
};
type NavigationKitCtor = new (control: unknown, opts: Record<string, unknown>) => NavigationKitInstance;
const NAVIGATIONKIT_SRC = 'https://cdn.jibestream.com/web/plugins/navigationkit/v1.2.0/navigationkit.js';
let navKitScriptInjected = false;
// Synchronous accessor: returns the global ctor if the CDN script has loaded,
// else null. Callers re-check this lazily (each time the kit is needed) instead
// of awaiting a one-shot promise — so a script that finishes AFTER an 8s timeout
// is still picked up rather than permanently treated as null.
function getNavigationKitCtor(): NavigationKitCtor | null {
	if (typeof window === 'undefined') return null;
	return (window as unknown as { NavigationKit?: NavigationKitCtor }).NavigationKit ?? null;
}
// Inject the CDN <script> once (idempotent, non-blocking). Does NOT cache a
// resolved value — readiness is read live via getNavigationKitCtor(), so a slow
// load that lands after the createMinimap callback still becomes usable.
function ensureNavigationKitLoading(logger?: MapLogger): void {
	if (typeof document === 'undefined') return;
	if (navKitScriptInjected || getNavigationKitCtor()) return;
	navKitScriptInjected = true;
	const s = document.createElement('script');
	s.src = NAVIGATIONKIT_SRC;
	s.async = true;
	// crossorigin is REQUIRED for SRI to be enforced (an opaque cross-origin
	// response can't be hash-checked) and, on its own, keeps the script's
	// error details out of other origins. Always set it.
	s.crossOrigin = 'anonymous';
	// TODO(SRI): pin an integrity hash for the immutable v1.2.0 artifact so a
	// cdn.jibestream.com compromise can't inject arbitrary JS into every host
	// (the script is handed the live JController whose JCore holds the auth
	// object). Compute offline against the exact pinned URL:
	//   curl -s https://cdn.jibestream.com/web/plugins/navigationkit/v1.2.0/navigationkit.js \
	//     | openssl dgst -sha384 -binary | openssl base64 -A
	// then: s.integrity = 'sha384-<hash>';
	// Left unset here because the hash cannot be computed/verified offline in
	// this environment; crossorigin is already applied so adding integrity
	// later is a one-line change. See skipped[] in the fix report.
	s.onerror = () => {
		// Allow a future retry: clear the flag so a later mount re-injects.
		navKitScriptInjected = false;
		jibLogWith(logger, 'minimap', 'NavigationKit script failed to load');
	};
	document.head.appendChild(s);
}

// --- Geometry helpers ---------------------------------------------------------

function readPoint(p: unknown): { x: number; y: number } | null {
	if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
		return { x: p[0], y: p[1] };
	}
	if (p && typeof p === 'object') {
		const po = p as { x?: unknown; y?: unknown };
		if (typeof po.x === 'number' && typeof po.y === 'number') return { x: po.x, y: po.y };
	}
	return null;
}

function unitCenterFromPoints(u: unknown): { x: number; y: number } | null {
	const pts = (u as { points?: unknown }).points;
	if (!Array.isArray(pts)) return null;
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	let saw = false;
	for (const p of pts) {
		const pt = readPoint(p);
		if (!pt) continue;
		saw = true;
		if (pt.x < minX) minX = pt.x;
		if (pt.y < minY) minY = pt.y;
		if (pt.x > maxX) maxX = pt.x;
		if (pt.y > maxY) maxY = pt.y;
	}
	if (!saw) return null;
	return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// Read a JMap Waypoint's world coordinate. jmap.js v4 exposes it directly
// (wp.x / wp.y), under the raw `_` payload (wp._.x / wp._.y), or as a
// `coordinates: [x, y]` pair — probe all shapes via readPoint.
function readWaypointCoord(wp: unknown): { x: number; y: number } | null {
	if (!wp) return null;
	const w = wp as { _?: { coordinates?: unknown }; coordinates?: unknown };
	return readPoint(wp)
		?? readPoint(w._)
		?? readPoint(w.coordinates)
		?? readPoint(w._?.coordinates);
}

// Resolve a Jibestream waypointId to its JMap Waypoint object. Waypoints live
// at activeVenue.maps.getById(mapId).waypoints.getById(id) — the only public
// surface for this lookup. Tries the preferred (own-floor) map first (O(1)),
// then scans all maps. `onPreferredMap` records which one hit: waypoint
// coordinates are in their OWN map's frame, so a cross-map hit is safe to
// anchor a route (wayfinding re-projects) but NOT to place a pin on
// `preferredMapId`. Best-effort: returns null on any failure.
function lookupWaypoint(
	activeVenue: unknown,
	preferredMapId: number,
	idKey: string,
	log: (stage: string, msg: string, extra?: unknown) => void,
): { wp: unknown; onPreferredMap: boolean } | null {
	const wpNum = Number(idKey);
	if (!Number.isFinite(wpNum)) return null;
	try {
		const av = activeVenue as {
			maps?: {
				getById?: (id: number) => { waypoints?: { getById?: (id: number) => unknown } } | null;
				getAll?: () => Array<{ waypoints?: { getById?: (id: number) => unknown } }>;
			}
		} | null;
		const own = av?.maps?.getById?.(preferredMapId)?.waypoints?.getById?.(wpNum);
		if (own) return { wp: own, onPreferredMap: true };
		for (const m of av?.maps?.getAll?.() ?? []) {
			const found = m.waypoints?.getById?.(wpNum);
			if (found) return { wp: found, onPreferredMap: false };
		}
	} catch (e) {
		log('minimap', 'waypoint lookup threw', e);
	}
	return null;
}

function getCollection(activeVenue: unknown, key: string): {
	getById?: (id: number) => unknown;
	getAll?: () => unknown[];
} | null {
	const av = activeVenue as Record<string, unknown> | null;
	if (!av) return null;
	const coll = av[key] as Record<string, unknown> | undefined;
	if (coll && typeof coll === 'object') return coll as never;
	return null;
}

// --- Public: MinimapInstance --------------------------------------------------

export interface CreateMinimapOpts {
	container: HTMLElement;
	resources: MapResource[];
	/**
	 * Venue + auth config. Required — the SDK has no baked-in defaults and no
	 * env reads. Per-building venue targeting still comes from
	 * `resources[].buildingExternalId` (it wins over `cfg.venueId`).
	 */
	cfg: JibestreamConfig;
	/** Optional logger; omit for silence (no-op default). */
	logger?: MapLogger;
	/** Fired whenever pan/zoom changes so the host can reposition pin overlays. */
	onViewChange?: () => void;
	/**
	 * Invoked on async post-init engine failures that happen AFTER createMinimap
	 * has resolved — currently a background token-refresh failure (the armed
	 * auth-shim timer's getToken() throwing). Synchronous mount failures are
	 * still surfaced by rejecting the createMinimap promise; this covers the
	 * failures that would otherwise be logger-only. `stage` names the failure
	 * class ('auth-refresh'); the view routes it to emit('error', …).
	 */
	onEngineError?: (err: { stage: string; message: string; cause?: unknown }) => void;
	/**
	 * Gate + defer the CDN-loaded NavigationKit (veer auto-reroute). When
	 * false, the third-party script is never fetched (pin-only mounts stay
	 * fully self-contained; veer auto-reroute silently no-ops). When true
	 * (default), loading is DEFERRED to the first drawItinerary call, so a
	 * pin-only mount that never draws a route also never hits the CDN.
	 */
	autoReroute?: boolean;
	/**
	 * List every venue floor (not just floors carrying a pin) and allow an
	 * empty `resources` array. Floors are ordered by Jibestream level/
	 * elevation, then mapId; a pin-less floor is framed to its full footprint
	 * when shown. Default false (historical: pin floors only, pins-desc).
	 */
	allFloors?: boolean;
	/**
	 * Floor (mapId) to show first, when it is a listed floor; otherwise the
	 * floor with the most pins. Passing the host's opening floor here avoids
	 * rendering + settling another floor first and then switching.
	 */
	initialMapId?: number;
}

/** Public-surface alias (core/index.ts exports `MinimapOptions`). */
export type MinimapOptions = CreateMinimapOpts;

export interface DrawItineraryOpts {
	/**
	 * When true, the route starts at the nearest waypoint to the current
	 * floor's geometric centre (resolved via
	 * `activeVenue.getClosestWaypointToCoordinatesOnMap`). Adds an implicit
	 * leg from that start to `externalIds[0]`. Use this when the host has
	 * no real user location and wants a deterministic "from somewhere on
	 * this floor" start point.
	 *
	 * Superseded by `startCoordinate` when both are provided.
	 */
	startFromMapCenter?: boolean;
	/**
	 * Fixed start coordinate for the route. When provided, the route starts
	 * at the waypoint nearest to `{x, y}` on `mapId` (resolved via
	 * `activeVenue.getClosestWaypointToCoordinatesOnMap`). Takes precedence
	 * over `startFromMapCenter`. Use this for a fixed kiosk / "you are here"
	 * anchor when the host knows the exact world coordinate.
	 */
	startCoordinate?: { mapId: number; x: number; y: number };
	/**
	 * Forwarded to `new jmap.Style(...)` and passed to JMap's
	 * drawWayfindingPath. When omitted, JMap renders with its built-in
	 * defaultPathStyle (red, strokeWidth 5).
	 */
	style?: { stroke?: string; strokeWidth?: number; strokeOpacity?: number };
	/**
	 * Render numbered "1", "2", … labels at each destination's waypoint.
	 * Defaults to true when externalIds.length > 1, false otherwise.
	 * The synthetic map-centre start is never labelled.
	 */
	showStopNumbers?: boolean;
}

export interface MinimapInstance {
	/** Initial floors + dominant + unresolved count, ready when this resolves. */
	state: MinimapInstanceState;
	/** Switches the live view to a given floor (must be one of state.floors). */
	setFloor: (mapId: number) => Promise<void>;
	/** Currently rendered floor's mapId. */
	getCurrentMapId: () => number | null;
	/**
	 * World → viewport-pixel projection for the current view. Returns null
	 * when the projection isn't available (e.g. controller torn down).
	 */
	projectWorldToViewport: (worldX: number, worldY: number) => { x: number; y: number } | null;
	/** Floor world coords → WGS84 lat/lng. Null if convertCoordinate unavailable. */
	worldToLatLng: (worldX: number, worldY: number) => { latitude: number; longitude: number } | null;
	/**
	 * Nearest venue waypoint to a world coord, via the same
	 * `activeVenue.getClosestWaypointToCoordinatesOnMap` used for route starts.
	 * For a point outside the floor (an off-venue user's projected fix) this
	 * snaps to the nearest perimeter/entrance waypoint — the venue's entry
	 * point. Returns its world coords, or null if the API/waypoint is
	 * unavailable. Mirrors the snap that anchors a GPS-origin route.
	 */
	nearestWaypointWorld: (
		world: { worldX: number; worldY: number; mapId: number },
		excludeIds?: ReadonlySet<string>,
	) => { worldX: number; worldY: number; mapId: number } | null;
	/** Clamp a world coord into its floor's footprint (no-op if size metadata is
	 *  unavailable). Used as the away-route fallback so it doesn't anchor at a
	 *  distant off-map GPS projection. */
	clampWorldToFloor: (
		world: { worldX: number; worldY: number; mapId: number },
	) => { worldX: number; worldY: number; mapId: number };
	/** True when the projected world point falls inside the floor's world rectangle. False if bounds unavailable or on a different floor. */
	isWorldInsideFloor: (world: { worldX: number; worldY: number; mapId: number } | null) => boolean;
	/**
	 * Resolve a list of colleague bookings to map-anchored markers using the
	 * same waypointId → destination → unit pipeline as pins. Synchronous —
	 * the venue + controller are already loaded by `createMinimap`.
	 * Bookings whose resource can't be located on the floorplan are
	 * dropped silently.
	 */
	resolveColleagueBookings: (bookings: ColleagueBooking[]) => ColleagueMarker[];
	/**
	 * Draws a routed line through `externalIds` in input order (not TSP-
	 * optimised). Each consecutive pair is wayfound via JMap's native
	 * wayfindBetweenWaypoints; per-floor segments only render on the
	 * currently-shown floor, so cross-floor routes appear as the user
	 * switches floors. Idempotent — clears prior routes (and stop labels)
	 * before drawing.
	 *
	 * Behaviour:
	 *   - `opts.startFromMapCenter=true` prepends a synthetic start at the
	 *     nearest waypoint to the current floor's geometric centre, so a
	 *     single-destination input renders as one leg (centre → dest) and
	 *     N destinations render as N legs. Without this flag, length<2
	 *     inputs are a no-op clear (preserving prior pair-wise behaviour).
	 *   - `opts.style` is forwarded to JMap's drawWayfindingPath. Omit to
	 *     fall back to JMap's built-in red defaultPathStyle.
	 *   - `opts.showStopNumbers` renders "1", "2", … labels at each stop
	 *     (skipping the synthetic centre when applicable). Defaults to true
	 *     when the input has >1 destination.
	 *
	 * Return: `drawn + missing === pairs` always, where pairs counts the
	 * actual rendered legs (including the synthetic centre→first leg when
	 * `startFromMapCenter` is on). `drawn` means at least one segment painted
	 * for that pair; `missing` covers unknown waypoints, empty wayfind
	 * results, and drawWayfindingPath throws.
	 *
	 * `syntheticStart` is populated when a kiosk/map-centre/coordinate waypoint
	 * was prepended and a route leg drew from it; use it to render a "you are
	 * here" overlay via projectWorldToViewport.
	 */
	drawItinerary: (
		externalIds: Array<string | number>,
		opts?: DrawItineraryOpts,
	) => {
		drawn: number;
		missing: number;
		syntheticStart?: { worldX: number; worldY: number; mapId: number };
	};
	/** Removes any currently-drawn route and numbered stop labels from the canvas. */
	clearItinerary: (resetFraming?: boolean) => void;
	/**
	 * Project a WGS84 GPS fix onto the current floor. Named lat/lng fields
	 * avoid the [lat,lng] vs [lng,lat] tuple ambiguity. Returns null when
	 * called with null, when no floor is loaded, or when convertCoordinate
	 * is unavailable. Does not touch the wayfinding layer.
	 */
	updateUserPosition: (
		coords: { latitude: number; longitude: number } | null,
	) => {
		worldX: number;
		worldY: number;
		mapId: number;
	} | null;
	/**
	 * Render the user dot natively via JMap's built-in `control.updateUserLocation`
	 * (pulsing dot + accuracy halo drawn on the canvas), instead of the host's
	 * HTML overlay. Accepts the already-projected world result from
	 * updateUserPosition to avoid a redundant convertCoordinate round-trip.
	 * Pass null to clear. Returns true if the native call succeeded.
	 * EXPERIMENTAL: gated behind a host flag pending browser verification
	 * under the host-supplied-token controller (the public examples use
	 * client-credentials init, not our token shim).
	 */
	setNativeUserLocation: (
		world: { worldX: number; worldY: number; mapId: number } | null,
	) => boolean;
	/**
	 * Zoom + pan the current map view so the given world point is centred,
	 * with tight padding around it. Used by the carousel to re-frame the map
	 * on the selected resource. No-op when the point's mapId doesn't match
	 * the currently-shown floor — caller must `await setFloor(mapId)` first
	 * if a cross-floor target is needed.
	 */
	centerOnWorld: (world: { worldX: number; worldY: number; mapId: number }) => void;
	/** True when the user has veered from the last drawn route beyond `thresholdMm`
	 *  (NavigationKit). False if unavailable/unentitled or no route — no fallback. */
	hasUserVeeredOffRoute: (thresholdMm: number) => boolean;
	/** Subscribe to the native user-location settle (`MOVING_OBJECT_ANIMATION_COMPLETE`)
	 *  — the veer-check trigger. Returns an unsubscribe fn (no-op if unavailable). */
	subscribeUserLocationSettled: (cb: () => void) => () => void;
	/**
	 * Register a map-tap listener (location-select mode). The tap arrives in
	 * the CURRENT floor's world frame. JMap has a single generic-tap slot; the
	 * engine multiplexes it so several listeners can coexist. Returns an
	 * unregister function. Taps are not reported while a drag/pan is in
	 * progress (JMap's own tap detection).
	 */
	onTap: (cb: (tap: { worldX: number; worldY: number; mapId: number }) => void) => () => void;
	/**
	 * Resolve a world point on a floor to the selectable item at/nearest it:
	 *   1. the innermost unit polygon containing the point that resolves to a
	 *      destination → that space (distance 0);
	 *   2. the nearest destination/amenity waypoint among `selectable` kinds
	 *      (ties break by `selectable` order);
	 *   3. the nearest bare waypoint, only if 'waypoint' is selectable;
	 *   4. the tapped spot itself (kind 'point'), only if 'point' is selectable.
	 * `accept` filters candidates at every step (rejected ones are skipped, the
	 * next-best is used). Steps 2–3 only reach as far as the tighter of
	 * `maxSnapDistance` (map units) and `maxSnapMeters` (via the floor's
	 * mmPerPixel). Null when nothing qualifies. `selectable` omitted →
	 * ['space', 'amenity']; [] → always null.
	 */
	resolveLocation: (
		world: { worldX: number; worldY: number; mapId: number },
		opts?: ResolveLocationOptions,
	) => MapSelection | null;
	/**
	 * Outline the selected space's unit polygon(s) on the map (restoring the
	 * previous highlight). Null clears. No-op when the item has no polygon.
	 */
	highlightSelection: (sel: MapSelection | null, style?: HighlightStyle) => void;
	/** The listed floors (see CreateMinimapOpts.allFloors) with their JMap metadata. */
	listFloors: () => FloorSummary[];
	/** Tear down the JMap controller and detach RAF/event listeners. */
	destroy: () => void;
}

/**
 * Mounts a live, pan/zoom-enabled minimap into `container` with a pin per
 * resolved resource. Returns once the dominant floor is shown and the pin
 * data is ready. The caller renders pins as HTML overlays and uses
 * `projectWorldToViewport` (driven by `onViewChange`) to keep them aligned.
 */
export async function createMinimap(opts: CreateMinimapOpts): Promise<MinimapInstance> {
	const jibLog = makeJibLog(opts.logger);
	const baseCfg = opts.cfg;
	// Prefer the resource's own buildingExternalId (== venueId of its building) —
	// a single campus can span multiple buildings/venues, so a single top-level
	// venueId would pick one building and miss resources in any of the others.
	// Falls back to cfg.venueId for sources that don't carry buildingExternalId.
	let venueId: number | null = null;
	for (const r of opts.resources) {
		const n = typeof r.buildingExternalId === 'number'
			? r.buildingExternalId
			: Number(r.buildingExternalId);
		if (Number.isFinite(n) && n > 0) { venueId = n; break; }
	}
	if (venueId == null) {
		const n = Number(baseCfg.venueId);
		if (Number.isFinite(n) && n > 0) venueId = n;
	}
	// The chat SDK resolved the venue from a campus meetingId here (tier 2,
	// wxsuperapp GET /m/spaces/maps/v3). The map SDK is backend-agnostic — the
	// host must supply the venue directly, so fail loudly instead.
	if (venueId == null) {
		throw new Error('venueId required: set cfg.venueId or resources[].buildingExternalId');
	}
	const cfg: JibestreamConfig = { ...baseCfg, venueId };
	// Kick off the jmap.js chunk download concurrently with the venue fetch.
	// The two are fully independent (loadVenue is a token POST + /full fetch;
	// loadJmap is a module-cached dynamic import), so starting the ~307KB-gzip
	// chunk transfer now instead of after loadVenue resolves removes a serial
	// network round-trip from cold start. Module-cached → race-safe; awaited at
	// the original load site below, so no observable ordering change.
	const jmapPromise = loadJmap();
	// Guard against an unhandled-rejection warning if loadVenue throws first and
	// we return before awaiting jmapPromise below. The real error still
	// surfaces at the `await jmapPromise` site (loadJmap is module-cached, so
	// this attaches a second handler, not a second import).
	jmapPromise.catch(() => {});
	const venue: VenueData = await loadVenue(cfg, opts.logger);

	// Resolve resources → group by floor. Each item records HOW it resolved
	// (`kind`) — the pin loop switches on that decision instead of re-deriving
	// it from raw fields, so the coordinate-source priority (explicit coords >
	// destination index > waypoint lookup) is encoded exactly once, here.
	type PinKind = 'coords' | 'dest' | 'waypoint';
	interface FloorGroup {
		mapId: number;
		mapName: string;
		items: Array<{ kind: PinKind; dest: Destination | null; res: MapResource }>;
	}
	const byMap = new Map<number, FloorGroup>();
	let unresolved = 0;
	const pushItem = (mapId: number, kind: PinKind, dest: Destination | null, r: MapResource) => {
		let g = byMap.get(mapId);
		if (!g) {
			g = { mapId, mapName: '', items: [] };
			byMap.set(mapId, g);
		}
		g.items.push({ kind, dest, res: r });
	};
	for (const r of opts.resources) {
		// Explicit-coordinate pins (host-supplied world x/y) place directly —
		// no resolveDestination needed.
		if (r.mapId != null && r.worldX != null && r.worldY != null) {
			pushItem(r.mapId, 'coords', null, r);
			continue;
		}
		// Host-explicit placement wins over the destination index: a resource
		// carrying BOTH its floor (mapId) and a waypoint externalId has already
		// chosen WHICH instance of the POI to show (bond's map agent selects
		// per-floor instances for counts/nearest/routes, and amenities aren't
		// in the destination index at all). Resolving through the destination
		// index here would re-group on the destination's FIRST location and
		// pin a multi-floor POI on the wrong level. Resources without a mapId
		// (booking flows) still resolve through the index below.
		if (r.externalId != null && r.mapId != null) {
			pushItem(r.mapId, 'waypoint', null, r);
			continue;
		}
		const dest = resolveDestination(venue, r);
		if (dest) {
			const mapId = dest.locations?.[0]?.mapId;
			if (mapId) { pushItem(mapId, 'dest', dest, r); continue; }
		}
		unresolved++;
	}

	// Under allFloors an empty resource set is legitimate (venue browser /
	// location picker) — the floor list comes from the venue's maps below.
	if (byMap.size === 0 && !opts.allFloors) {
		throw new Error(unresolved > 0
			? "Couldn't locate any of these on the map."
			: 'No floors to render.');
	}

	// Create our own JMap controller mounted in the supplied container.
	const jmap = await jmapPromise;

	// JMap requires the container to have a DOM id selector. Generate one.
	let containerId = opts.container.id;
	if (!containerId) {
		containerId = `nova-minimap-${Math.random().toString(36).slice(2, 8)}`;
		opts.container.id = containerId;
	}
	// Make sure the container has enough size for the renderer to attach.
	if (!opts.container.style.position) opts.container.style.position = 'relative';

	// Two auth modes for JMap: with cfg.auth.getToken, hand JMap a shim that
	// keeps its bearer fresh via a background timer scheduled (expiresAt - 30s)
	// after each refresh. Async getters also refresh through the shared
	// cache. The shim's dispose() must run on minimap destroy or the timer
	// leaks. Without cfg.auth.getToken, JMap drives its own client_credentials.
	let jmapAuth: unknown;
	let disposeAuthShim: (() => void) | null = null;
	let startAuthRefresh: (() => void) | null = null;
	if ('getToken' in cfg.auth) {
		const built = await buildHostTokenAuth(cfg, opts.logger, opts.onEngineError);
		jmapAuth = built.auth;
		disposeAuthShim = built.dispose;
		startAuthRefresh = built.start;
	} else {
		jmapAuth = new jmap.core.Auth(cfg.auth.clientId ?? '', cfg.auth.clientSecret ?? '');
	}
	// JMap v4 has no `mapProfileId` URL param built into its `?v=4.12` query
	// builder, so we have to inject it via the `request` opt — JCore's escape
	// hatch for overriding the HTTP layer. Without this, every JACS call
	// (`/full`, `/building/.../full`, etc.) 401s for service accounts that
	// require an explicit map profile.
	//
	// Contract (reverse-engineered from jmap.min.js): JMap calls
	//   request({url, headers}, (err, response, bodyString) => ...)
	// and reads `response.statusCode` (304 is honoured) plus the body string.
	const coreOpts: Record<string, unknown> = {
		auth: jmapAuth,
		customerId: cfg.customerId,
		host: cfg.host,
	};
	if (cfg.mapProfileId != null) {
		coreOpts.mapProfileId = cfg.mapProfileId;
		// `request` overrides JMap's HTTP layer to inject mapProfileId into
		// GET URLs. When the host also supplies a token (cfg.auth.getToken),
		// the override additionally short-circuits the /JACS/api/auth/token
		// POST — JMap would otherwise try a client_credentials exchange with
		// the shim's empty clientId/clientSecret and 401. When no host token
		// is supplied, the auth POST is forwarded so JMap performs its normal
		// client_credentials exchange against the configured credentials.
		const getBearer: (() => Promise<string>) | undefined = 'getToken' in cfg.auth
			? () => getToken(cfg, opts.logger)
			: undefined;
		coreOpts.request = makeJacsRequest(cfg.mapProfileId, getBearer);
	}
	// The auth-shim's background refresh timer is NOT armed yet — startAuthRefresh()
	// arms it only after a fully successful mount (just before the return below), so
	// a throw anywhere between here and that return strands no timer. The try/catch
	// guards below additionally tear down control / RAF / ResizeObserver — resources
	// that DO get created mid-mount — and best-effort dispose the shim.
	let core: JCore;
	let activeVenue: unknown;
	let control: JController;
	try {
		core = new jmap.core.JCore(coreOpts);

		activeVenue = await new Promise((resolve, reject) => {
			core.populateVenueWithDefaultBuilding(cfg.venueId, (err, av) => {
				if (err) reject(err);
				else resolve(av);
			});
		});

		control = new jmap.JController({
			engine: 'canvas',
			container: `#${containerId}`,
			activeVenue,
		});
	} catch (e) {
		try { disposeAuthShim?.(); } catch { /* best-effort teardown */ }
		throw e;
	}

	if (typeof control.showDefaultMap === 'function') {
		try { control.showDefaultMap(); } catch (e) {
			jibLog('minimap', 'showDefaultMap threw', e);
		}
	}

	// Enable all path types (stairs, escalators, elevators) so the JMap router
	// can build cross-floor routes. Without this call the graph only includes
	// the default "walking" type and wayfindBetweenWaypoints returns empty
	// segments for cross-floor legs.
	if (typeof control.showAllPathTypes === 'function') {
		try { control.showAllPathTypes(); }
		catch (e) { jibLog('minimap', 'showAllPathTypes threw', e); }
	}

	// Enable pan + zoom. These are no-arg toggles in jmap.js v4.
	for (const fn of ['addDragPan', 'addPinchZoom', 'addMouseWheelZoom'] as const) {
		const m = control[fn];
		if (typeof m === 'function') {
			try { m.call(control); } catch (e) { jibLog('minimap', `${fn} threw`, e); }
		}
	}

	// NavigationKit (OOTB veer-based auto-reroute), CDN-loaded in the BACKGROUND
	// so a slow/blocked script never blocks map creation. Entitlement-gated per
	// venue; if unentitled, hasUserVeeredOffRoute may no-op/throw (verify on-venue).
	// No re-anchor fallback by request — auto-reroute relies solely on this.
	//
	// SECURITY / SELF-CONTAINEDNESS: the CDN fetch is now GATED and DEFERRED.
	//   - autoReroute === false  → the third-party script is NEVER fetched.
	//   - autoReroute !== false   → loading is deferred to the FIRST drawItinerary
	//     (its only consumer), so pin-only mounts that never draw a route stay
	//     fully self-contained and never hit cdn.jibestream.com.
	// ensureNavigationKitLoading() is therefore NO LONGER called eagerly here.
	//
	// Constructed LAZILY on first use (getNavigationKit), re-checking the global
	// each call — so a script that loads after a slow CDN is still picked up
	// rather than being lost to a one-shot timeout that already resolved null.
	const autoReroute = opts.autoReroute ?? true;
	let navigationKit: NavigationKitInstance | null = null;
	// Kick off the (idempotent) CDN injection. Called lazily from drawItinerary,
	// never at mount. No-op when auto-reroute is disabled.
	function ensureNavigationKit(): void {
		if (!autoReroute) return;
		ensureNavigationKitLoading(opts.logger);
	}
	function getNavigationKit(): NavigationKitInstance | null {
		if (!autoReroute) return null;
		if (navigationKit) return navigationKit;
		const Ctor = getNavigationKitCtor();
		if (!Ctor) { ensureNavigationKitLoading(opts.logger); return null; }
		try { navigationKit = new Ctor(control, {}); }
		catch (e) { jibLog('minimap', 'NavigationKit init failed', e); }
		return navigationKit;
	}
	// Concatenated segments of the last drawn route — the `path` argument to
	// navigationKit.hasUserVeeredOffRoute(). Reset/rebuilt on each drawItinerary.
	let lastWayfindSegments: unknown[] = [];

	const mapsColl = getCollection(activeVenue, 'maps') as
		| { getById?: (id: number) => unknown; getAll?: () => unknown[] }
		| null;
	const destColl = getCollection(activeVenue, 'destinations') as
		| { getById?: (id: number) => unknown }
		| null;
	const buildingsColl = getCollection(activeVenue, 'buildings') as
		| { getFloorByMap?: (map: unknown) => unknown }
		| null;

	// Floor labels live on the JMap FLOOR model (name / shortName / level /
	// elevation) — the Map model only carries geometry (width, height, svg…).
	// Resolve through buildings.getFloorByMap(map). shortName is whatever the
	// JACS payload carried — usually a string from the CMS ("L3", "44", "G").
	// JMap's Floor setter is typed Number, but the model constructor copies
	// the raw payload into its `_` bag without calling setters, so the getter
	// returns the string unchanged; accept both types here.
	type FloorMeta = {
		name: string | null;
		shortName: string | number | null;
		level: number | null;
		elevation: number | null;
		/** False when the map belongs to no building floor (e.g. a venue-level map). */
		isFloor: boolean;
	};
	// Memoised: the venue is immutable for the controller's life, and
	// getFloorByMap is a linear scan that allocates on every call.
	const floorMetaCache = new Map<number, FloorMeta>();
	function floorMeta(mapId: number): FloorMeta {
		const hit = floorMetaCache.get(mapId);
		if (hit) return hit;
		const out: FloorMeta = { name: null, shortName: null, level: null, elevation: null, isFloor: false };
		floorMetaCache.set(mapId, out);
		const mapObj = mapsColl?.getById?.(mapId);
		if (!mapObj) return out;
		try {
			const fl = buildingsColl?.getFloorByMap?.(mapObj) as
				| { name?: unknown; shortName?: unknown; level?: unknown; elevation?: unknown }
				| null
				| undefined;
			if (fl) {
				out.isFloor = true;
				if (typeof fl.name === 'string' && fl.name) out.name = fl.name;
				if (typeof fl.shortName === 'number' && Number.isFinite(fl.shortName)) out.shortName = fl.shortName;
				else if (typeof fl.shortName === 'string' && fl.shortName.trim()) out.shortName = fl.shortName.trim();
				if (typeof fl.level === 'number') out.level = fl.level;
				if (typeof fl.elevation === 'number') out.elevation = fl.elevation;
			}
		} catch (e) {
			jibLog('minimap', 'getFloorByMap threw', e);
		}
		return out;
	}
	// Label from JMap data alone (no host override): Floor.name, then its
	// shortName; null when the venue has neither.
	function jmapFloorLabel(mapId: number): string | null {
		const fm = floorMeta(mapId);
		return fm.name ?? (fm.shortName != null ? String(fm.shortName) : null);
	}
	// …with the raw id as a last resort.
	function floorBaseName(mapId: number): string {
		return jmapFloorLabel(mapId) ?? `Floor ${mapId}`;
	}

	for (const g of byMap.values()) {
		const m = mapsColl?.getById?.(g.mapId) as
			| { name?: string; shortName?: string; floorName?: string }
			| null
			| undefined;
		// Prefer the JMap map's own labels, then fall back to the floorName
		// the resource was tagged with (e.g. bookings carry "Level 3" /
		// "Level 1"). Only use the numeric mapId fallback as a last resort
		// — the raw id is meaningless to users.
		const resourceFloor = g.items.find(it => !!it.res.floorName)?.res.floorName;
		// The Map model carries no name in practice (floor labels are on the
		// Floor model — see floorMeta); the Map probes are kept for parity with
		// older payloads. Legacy mounts keep the host's own resource floorName
		// ahead of the Floor model (unchanged behaviour: it only replaces the
		// raw "Floor <id>" fallback). Under allFloors the Floor model comes
		// first so pin floors and pin-less floors are labelled the same way.
		const jmapFloorName = jmapFloorLabel(g.mapId) ?? '';
		g.mapName = m?.name || m?.shortName || m?.floorName
			|| (opts.allFloors ? (jmapFloorName || resourceFloor) : (resourceFloor || jmapFloorName))
			|| `Floor ${g.mapId}`;
		// Host-supplied floor label overrides (e.g. { 7659: 'Floor 1', 8837: 'Floor 2' }).
		// Takes precedence over all JMap-derived names so venue-specific map IDs
		// never appear in the UI.
		if (cfg.floorLabels?.[g.mapId]) {
			g.mapName = cfg.floorLabels[g.mapId];
		}
	}

	// Waypoint cache for wayfinding. Keyed by stringified externalId so the
	// itinerary API (which receives MapResource.externalId values) can
	// look up the JMap Waypoint object needed by wayfindBetweenWaypoints.
	// Populated alongside pin resolution — same floor/map traversal, no
	// extra API calls required.
	const waypointByExternalId = new Map<string, unknown>();

	// Tracks every mapId that drawStopNumbers has placed a label on.
	// Distinct from byMap (resource floors) because waypoints resolved via
	// the cross-map scan can live on floors not present in byMap. clearStopLabels
	// must clear all of these, not just the resource floors.
	const labelledMapIds = new Set<number>();

	// For each floor, look up units per resource so we can compute pin centres.
	const floors: FloorInfo[] = [];
	for (const g of byMap.values()) {
		const pins: PinInfo[] = [];
		const mapObj = mapsColl?.getById?.(g.mapId);

		for (const it of g.items) {
			// Resolve the JMap Waypoint object for this resource's externalId
			// ONCE — it anchors routes (wayfinding cache) and, for waypoint-kind
			// items, places the pin at the waypoint's own coordinate. Best-effort:
			// lookup failures just mean this pin can't anchor a route.
			const externalIdKey = it.res.externalId != null ? String(it.res.externalId) : null;
			const wpHit = externalIdKey ? lookupWaypoint(activeVenue, g.mapId, externalIdKey, jibLog) : null;
			if (wpHit && externalIdKey) waypointByExternalId.set(externalIdKey, wpHit.wp);

			// Place the pin per the resolution kind recorded in the grouping
			// loop — the priority order lives there, not here.
			switch (it.kind) {
				case 'coords':
					pins.push({ resource: it.res, worldX: it.res.worldX!, worldY: it.res.worldY! });
					break;
				case 'dest': {
					const unit = lookupUnitForResource(control, activeVenue, mapObj, destColl, it.dest!, it.res, jibLog);
					const c = unit ? unitCenterFromPoints(unit) : null;
					if (c) pins.push({ resource: it.res, worldX: c.x, worldY: c.y });
					break;
				}
				case 'waypoint': {
					// Only pin from an own-map waypoint: a cross-map fallback hit
					// is in ANOTHER map's coordinate frame, and drawing it on this
					// floor's canvas would misplace the pin (routes are fine — the
					// cached wp above re-projects through wayfinding).
					const c = wpHit?.onPreferredMap ? readWaypointCoord(wpHit.wp) : null;
					if (c) pins.push({ resource: it.res, worldX: c.x, worldY: c.y });
					else jibLog('minimap', `waypoint ${externalIdKey} not pinnable on map ${g.mapId} (missing or cross-map hit)`);
					break;
				}
			}
		}

		floors.push({ mapId: g.mapId, mapName: g.mapName, pins });
	}

	// Always include the kiosk's floor in the rendered floor list so the
	// floor-tab strip lets the user switch back to "you are here" even when
	// no destinations exist on that floor. Without this, cross-floor routes
	// from Floor 1 → Floor 2 would have only Floor 2 in `floors[]`, hiding
	// the tab strip entirely (consumer code renders it only when length>1).
	if (cfg.kioskCoordinate && !floors.some(f => f.mapId === cfg.kioskCoordinate!.mapId)) {
		const kMapId = cfg.kioskCoordinate.mapId;
		const kMapObj = mapsColl?.getById?.(kMapId) as
			| { name?: string; shortName?: string; floorName?: string }
			| null
			| undefined;
		const baseName = kMapObj?.name || kMapObj?.shortName || kMapObj?.floorName || floorBaseName(kMapId);
		const labeled = cfg.floorLabels?.[kMapId] ?? baseName;
		floors.push({ mapId: kMapId, mapName: labeled, pins: [] });
	}

	// Venue-wide floor list (opts.allFloors): every JMap map, not just the
	// ones carrying pins, in building order (level/elevation) — what a floor
	// selector wants. Without the flag keep the historical pins-desc order.
	if (opts.allFloors) {
		// Only maps that belong to a building floor: `activeVenue.maps` can also
		// hold a venue-level map (populate.venue creates one when the venue
		// payload carries a `map`), which is not a floor and must not become a
		// floor chip. If the buildings collection can't answer (older jmap
		// builds without getFloorByMap), fall back to listing every map.
		const canTellFloors = typeof buildingsColl?.getFloorByMap === 'function';
		for (const m of (mapsColl?.getAll?.() ?? []) as Array<{ id?: number }>) {
			if (typeof m.id !== 'number' || floors.some(f => f.mapId === m.id)) continue;
			if (canTellFloors && !floorMeta(m.id).isFloor) continue;
			floors.push({ mapId: m.id, mapName: cfg.floorLabels?.[m.id] ?? floorBaseName(m.id), pins: [] });
		}
		// Building order, keyed from ONE source every real floor has (mixing
		// keys puts "G" after "2"): level, else elevation, else a numeric
		// shortName, else mapId. Pin/kiosk floors on a non-floor map sort last.
		const isBuilding = (mapId: number) => !canTellFloors || floorMeta(mapId).isFloor;
		const numericShort = (fm: FloorMeta): number | null => {
			const n = fm.shortName != null ? Number(fm.shortName) : NaN;
			return Number.isFinite(n) ? n : null;
		};
		const building = floors.filter(f => isBuilding(f.mapId)).map(f => floorMeta(f.mapId));
		const keyOf = [(fm: FloorMeta) => fm.level, (fm: FloorMeta) => fm.elevation, numericShort]
			.find(src => building.every(fm => src(fm) != null));
		const key = (mapId: number) => (keyOf ? keyOf(floorMeta(mapId)) : null) ?? mapId;
		floors.sort((a, b) =>
			(Number(isBuilding(b.mapId)) - Number(isBuilding(a.mapId)))
			|| (key(a.mapId) - key(b.mapId))
			|| (a.mapId - b.mapId));
	} else {
		floors.sort((a, b) => (b.pins.length - a.pins.length) || (a.mapId - b.mapId));
	}
	// Dominant = most pins (first in list on ties); with no pins at all
	// (allFloors, empty resources) it is the first floor in building order.
	const dominantMapId = floors.reduce<FloorInfo | null>(
		(best, f) => (best == null || f.pins.length > best.pins.length ? f : best),
		null,
	)?.mapId ?? null;

	// --- View management -----------------------------------------------------

	let currentMapId: number | null = null;
	// Included in frameCurrentFloor bounds so the kiosk dot is never cropped.
	let lastSyntheticStartPos: { worldX: number; worldY: number; mapId: number } | null = null;
	// Frame the route ONCE per destination set. Re-anchors (GPS ticks) redraw the
	// route; re-framing each time would ratchet the zoom in as the user nears the
	// destination. Reset only when the destination set changes (lastDrawnSig).
	let hasFramedRoute = false;
	let lastDrawnSig: string | null = null;

	function setFloor(mapId: number, scheduleFraming = true): Promise<void> {
		if (mapId === currentMapId) return Promise.resolve();
		const mapObj = mapsColl?.getById?.(mapId);
		if (!mapObj || typeof control.showMap !== 'function') return Promise.resolve();
		try {
			control.showMap(mapObj);
			currentMapId = mapId;
		} catch (e) {
			jibLog('minimap', 'showMap threw', e);
			return Promise.resolve();
		}
		// After switch, frame the floor's pins. Returns a promise so the
		// caller can hold a loading overlay over the canvas until the new
		// floor is rendered + zoomed — without it the user sees the new
		// floor's default extent flash before the zoom snaps in.
		if (!scheduleFraming) return Promise.resolve();
		return new Promise<void>(resolve => {
			setTimeout(() => {
				frameCurrentFloor();
				resolve();
			}, MAP_SETTLE_MS);
		});
	}

	// Fit the current map view to a world rect. True when JMap's fit ran;
	// false when unavailable or it threw (logged under `tag`).
	function fitView(rect: UnitBounds, padding: number, tag: string): boolean {
		const stage = (control as Record<string, unknown>).stage as Record<string, unknown> | undefined;
		const view = stage?.currentMapView as {
			fitBoundsInView?: (opts: Record<string, unknown>) => unknown;
		} | undefined;
		if (typeof view?.fitBoundsInView !== 'function') return false;
		try {
			view.fitBoundsInView({ bounds: { ...rect }, padding, speed: 0 });
			return true;
		} catch (e) {
			jibLog('minimap', `fitBoundsInView (${tag}) threw`, e);
			return false;
		}
	}

	function centerOnWorld(world: { worldX: number; worldY: number; mapId: number }): void {
		if (currentMapId == null || world.mapId !== currentMapId) return;
		// 8x8 unit window around the point keeps the resource pin centred without
		// zooming all the way in past unit geometry. Padding mirrors frameCurrentFloor's
		// single-point branch so the view scale matches the auto-frame on open.
		const rect: UnitBounds = { x: world.worldX - 4, y: world.worldY - 4, width: 8, height: 8 };
		if (fitView(rect, 64, 'centerOnWorld')) opts.onViewChange?.();
	}

	function frameCurrentFloor(): void {
		const floor = floors.find(f => f.mapId === currentMapId);
		if (!floor) return;
		const syntheticPin = (lastSyntheticStartPos && lastSyntheticStartPos.mapId === currentMapId)
			? { worldX: lastSyntheticStartPos.worldX, worldY: lastSyntheticStartPos.worldY }
			: null;
		if (floor.pins.length === 0 && !syntheticPin) {
			// Nothing to frame. Under allFloors (venue browser / location picker)
			// fit the whole floor footprint so the user sees the floorplan rather
			// than JMap's default extent; legacy mounts keep the default extent
			// (kiosk-only floors were never framed before).
			if (opts.allFloors) frameWholeFloor();
			return;
		}
		const allPoints = syntheticPin ? [...floor.pins, syntheticPin] : floor.pins;
		const rect: UnitBounds | null = allPoints.length === 1
			? { x: allPoints[0].worldX - 4, y: allPoints[0].worldY - 4, width: 8, height: 8 }
			: rectFromPoints(allPoints);
		if (!rect) return;
		const span = Math.max(rect.width, rect.height);
		fitView(rect, Math.max(8, span * 1.5), 'frameCurrentFloor');
		opts.onViewChange?.();
	}

	// Building footprint per floor (union of the unit centres) — preferred
	// over the full map extent, which usually includes a lot of outdoor
	// surroundings that would leave the building small in the viewport.
	// Cached: the venue never changes, and resizes re-frame often.
	const footprintCache = new Map<number, UnitBounds | null>();
	function floorFootprint(mapId: number): UnitBounds | null {
		if (footprintCache.has(mapId)) return footprintCache.get(mapId) ?? null;
		const pts: Array<{ worldX: number; worldY: number }> = [];
		for (const u of unitsOn(mapId)) {
			const c = unitCenterFromPoints(u);
			if (c) pts.push({ worldX: c.x, worldY: c.y });
		}
		const size = floorSizeWorld(mapId);
		const rect = pts.length >= 2 ? rectFromPoints(pts)
			: size ? { x: 0, y: 0, width: size.width, height: size.height }
				: null;
		footprintCache.set(mapId, rect);
		return rect;
	}

	function frameWholeFloor(): void {
		if (currentMapId == null) return;
		const rect = floorFootprint(currentMapId);
		if (!rect) return;
		fitView(rect, Math.max(24, Math.max(rect.width, rect.height) * 0.15), 'frameWholeFloor');
		opts.onViewChange?.();
	}

	// Unit polygons of a floor (JMap "units" layer), [] when unavailable.
	function unitsOn(mapId: number): unknown[] {
		const mapObj = mapsColl?.getById?.(mapId);
		if (!mapObj || typeof control.getUnitsFromMap !== 'function') return [];
		try { return control.getUnitsFromMap(mapObj) ?? []; }
		catch (e) { jibLog('minimap', 'getUnitsFromMap threw', e); return []; }
	}

	function rectFromPoints(pins: Array<{ worldX: number; worldY: number }>): UnitBounds {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const p of pins) {
			if (p.worldX < minX) minX = p.worldX;
			if (p.worldY < minY) minY = p.worldY;
			if (p.worldX > maxX) maxX = p.worldX;
			if (p.worldY > maxY) maxY = p.worldY;
		}
		return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
	}

	function projectWorldToViewport(worldX: number, worldY: number): { x: number; y: number } | null {
		// Method lives on the stage (control.stage), not the controller itself.
		// Fall back to control.* in case a future build forwards it.
		const ctl = control as Record<string, unknown>;
		const stage = ctl.stage as { getViewportPointFromMapPoint?: (p: [number, number]) => [number, number] } | undefined;
		const fn = stage?.getViewportPointFromMapPoint
			?? (control.getViewportPointFromMapPoint as ((p: [number, number]) => [number, number]) | undefined);
		if (typeof fn !== 'function') return null;
		try {
			const target = stage?.getViewportPointFromMapPoint ? stage : control;
			const [vx, vy] = fn.call(target, [worldX, worldY]);
			if (!Number.isFinite(vx) || !Number.isFinite(vy)) return null;
			return { x: vx, y: vy };
		} catch {
			return null;
		}
	}

	// HTML pin overlays need to track the JMap view as the user pans/zooms.
	// We RAF-poll the view's transform and only fire onViewChange when it
	// actually changed — avoids 60 reprojections/sec/minimap when idle.
	let rafHandle: number | null = null;
	let disposed = false;
	let lastViewSig = '';
	function getViewSignature(): string {
		const ctl = control as Record<string, unknown>;
		const stage = ctl.stage as Record<string, unknown> | undefined;
		const view = stage?.currentMapView as {
			scale?: number;
			getPosition?: () => [number, number];
			container?: { x?: number; y?: number; scale?: { x: number; y: number } };
		} | undefined;
		if (!view) return '';
		// Pixi container exposes x/y/scale on the transform; that's what changes
		// when the user pans or pinches.
		const c = view.container as { x?: number; y?: number; scale?: { x?: number } } | undefined;
		const cx = c?.x ?? 0;
		const cy = c?.y ?? 0;
		const cs = c?.scale?.x ?? view.scale ?? 1;
		return `${cx.toFixed(2)}|${cy.toFixed(2)}|${cs.toFixed(4)}|${currentMapId ?? ''}`;
	}
	function tick(): void {
		if (disposed) return;
		const sig = getViewSignature();
		if (sig !== lastViewSig) {
			lastViewSig = sig;
			opts.onViewChange?.();
		}
		rafHandle = requestAnimationFrame(tick);
	}

	// Watch the container for size changes (typical cause: parent message
	// bubble grows during text streaming). The Controller doesn't expose a
	// resize method directly — the relevant API lives on `control.stage`
	// (and its renderer for the canvas framebuffer). Walk both so the canvas
	// element AND the pixel buffer match the new container dims.
	function resizeJmap(width: number, height: number): void {
		const ctl = control as Record<string, unknown>;
		const stage = ctl.stage as {
			resize?: (w: number, h: number) => unknown;
			renderer?: { resize?: (w: number, h: number) => unknown };
		} | undefined;
		try { stage?.resize?.(width, height); }
		catch (e) { jibLog('minimap', 'stage.resize threw', e); }
		try { stage?.renderer?.resize?.(width, height); }
		catch (e) { jibLog('minimap', 'stage.renderer.resize threw', e); }
	}

	let lastWidth = 0, lastHeight = 0;
	const resizeObserver = typeof ResizeObserver !== 'undefined'
		? new ResizeObserver(entries => {
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				if (width === 0 || height === 0) continue;
				if (Math.abs(width - lastWidth) < 1 && Math.abs(height - lastHeight) < 1) continue;
				lastWidth = width; lastHeight = height;
				resizeJmap(width, height);
				if (currentMapId != null) frameCurrentFloor();
			}
		})
		: null;
	resizeObserver?.observe(opts.container);

	function destroy(): void {
		disposed = true;
		if (rafHandle != null) cancelAnimationFrame(rafHandle);
		resizeObserver?.disconnect();
		try { control.destroy?.(); } catch (e) { jibLog('minimap', 'control.destroy threw', e); }
		try { disposeAuthShim?.(); } catch (e) { jibLog('minimap', 'auth shim dispose threw', e); }
	}

	// --- Wayfinding -----------------------------------------------------------
	//
	// Draws a routed line through the supplied externalIds in input order
	// (not TSP-optimised — callers want caller-driven ordering). With
	// `opts.startFromMapCenter` the first leg is implicit: nearest waypoint
	// to the current floor's geometric centre → externalIds[0]. Without it,
	// length<2 inputs are a no-op clear.
	//
	// Under the hood: wayfindBetweenWaypoints(from, to) returns an array of
	// segments (one per floor traversed); drawWayfindingPath expects that
	// whole array as its first arg (its internal `paths.map(seg =>
	// Line.createFromWaypoints(seg.points))` throws on a bare segment object).
	// Cross-floor segments only paint on the currently-shown floor — switching
	// floors via setFloor re-runs the draw, so the SDK's floor chips give the
	// user a way to see other floors' segments.
	//
	// Idempotent: clears prior route + stop labels before drawing. Set
	// limitConcurrentPaths=false on the controller so per-pair draws coexist.
	// Return value: drawn + missing === pairs (where pairs counts rendered
	// legs, including the synthetic centre→first leg when enabled). `drawn`
	// means at least one segment painted for that pair; `missing` covers
	// unknown waypoints, empty wayfind results, and drawWayfindingPath throws.
	const ITINERARY_LABEL_LAYER = 'Itinerary-Stops';

	// Single owner of the floor-size read (JMapPrivateSizeBag: the size lives
	// under the Map model's `_` private bag). Pure sync getter; null when the
	// map or its size metadata is unavailable.
	function floorSizeWorld(mapId: number): { width: number; height: number } | null {
		const mapObj = mapsColl?.getById?.(mapId) as JMapPrivateSizeBag | null | undefined;
		if (!mapObj) return null;
		const priv = mapObj._ ?? {};
		const w = priv.size?.width ?? priv.width;
		const h = priv.size?.height ?? priv.height;
		if (typeof w !== 'number' || typeof h !== 'number') return null;
		return { width: w, height: h };
	}

	// Returns the waypoint closest to the geometric centre of the current
	// floor map (size read via floorSizeWorld).
	function resolveMapCenterWaypoint(): unknown {
		if (currentMapId == null) return null;
		const mapObj = mapsColl?.getById?.(currentMapId);
		if (!mapObj) return null;
		const size = floorSizeWorld(currentMapId);
		if (!size) return null;
		const center: [number, number] = [size.width / 2, size.height / 2];
		const av = control.activeVenue as { getClosestWaypointToCoordinatesOnMap?: (c: [number, number], m: unknown) => unknown } | undefined;
		if (typeof av?.getClosestWaypointToCoordinatesOnMap !== 'function') return null;
		try {
			return av.getClosestWaypointToCoordinatesOnMap(center, mapObj) ?? null;
		} catch (e) {
			jibLog('minimap', 'getClosestWaypointToCoordinatesOnMap threw', e);
			return null;
		}
	}

	// Returns the waypoint nearest to a specific world coordinate on a given
	// map. Used for a fixed "kiosk / you-are-here" start point when the host
	// knows the exact location rather than wanting the geometric floor centre.
	function resolveCoordinateWaypoint(coord: { mapId: number; x: number; y: number }): unknown {
		const mapObj = mapsColl?.getById?.(coord.mapId);
		if (!mapObj) {
			jibLog('minimap', `resolveCoordinateWaypoint: mapId=${coord.mapId} not found`);
			return null;
		}
		const av = control.activeVenue as { getClosestWaypointToCoordinatesOnMap?: (c: [number, number], m: unknown) => unknown } | undefined;
		if (typeof av?.getClosestWaypointToCoordinatesOnMap !== 'function') {
			jibLog('minimap', 'resolveCoordinateWaypoint: getClosestWaypointToCoordinatesOnMap unavailable');
			return null;
		}
		try {
			return av.getClosestWaypointToCoordinatesOnMap([coord.x, coord.y], mapObj) ?? null;
		} catch (e) {
			jibLog('minimap', 'resolveCoordinateWaypoint threw', e);
			return null;
		}
	}

	// World coords of the nearest waypoint to `world` (the venue entry point for
	// an off-floor fix). Extracts coordinates from the snapped waypoint the same
	// way drawItinerary derives its syntheticStart.
	// Clamp the input into the floor's local bounds FIRST: a far-away fix projects
	// off-map and would snap to a distant OUTDOOR waypoint (long route leg).
	// Clamping to the footprint lands the snap on a building-EDGE waypoint instead.
	// `excludeIds`: resource externalIds (e.g. route destinations) the snap must
	// NOT land on — if the nearest waypoint coincides with one, return null so the
	// caller falls back to the raw fix (snapping onto the destination would collapse
	// the route to ~zero length). Keeps the pin geometry check inside the SDK.
	// Clamp a world coord into its floor's local footprint. A fix far outside the
	// venue projects off-map; clamping keeps it at the building edge so neither the
	// snap nor the fallback anchors out at the distant projection. No-op (returns
	// the input) when the floor's size metadata isn't available.
	function clampWorldToFloor(
		world: { worldX: number; worldY: number; mapId: number },
	): { worldX: number; worldY: number; mapId: number } {
		const size = floorSizeWorld(world.mapId);
		if (!size) return world;
		return {
			worldX: Math.max(0, Math.min(size.width, world.worldX)),
			worldY: Math.max(0, Math.min(size.height, world.worldY)),
			mapId: world.mapId,
		};
	}

	function nearestWaypointWorld(
		world: { worldX: number; worldY: number; mapId: number },
		excludeIds?: ReadonlySet<string>,
	): { worldX: number; worldY: number; mapId: number } | null {
		const { worldX, worldY } = clampWorldToFloor(world);
		const wp = resolveCoordinateWaypoint({ mapId: world.mapId, x: worldX, y: worldY }) as
			| { coordinates?: number[]; mapId?: number }
			| null;
		if (!wp || !Array.isArray(wp.coordinates) || wp.coordinates.length < 2 || wp.mapId == null) {
			return null;
		}
		// Waypoint.coordinates is [localX, localY] (Jibestream Local space, NOT
		// GeoJSON lng/lat) — same order drawItinerary uses to build syntheticStart.
		const snapped = { worldX: wp.coordinates[0], worldY: wp.coordinates[1], mapId: wp.mapId };
		if (excludeIds && excludeIds.size > 0) {
			// Compare against the destinations' WAYPOINT coords, not their pin/unit
			// centres — the snap returns a waypoint, and a tenant's routing waypoint
			// (at its door/path edge) is offset from its unit centre, so a pin-coord
			// check would essentially never match and the guard would be dead. Read
			// the same waypoint objects routing uses (waypointByExternalId).
			const EPS = 1; // map-local units; distinct waypoints aren't sub-unit close
			for (const id of excludeIds) {
				const wpObj = waypointByExternalId.get(id) as { coordinates?: number[]; mapId?: number } | undefined;
				if (!wpObj || !Array.isArray(wpObj.coordinates) || wpObj.coordinates.length < 2) continue;
				if (wpObj.mapId !== snapped.mapId) continue;
				if (Math.abs(wpObj.coordinates[0] - snapped.worldX) < EPS
					&& Math.abs(wpObj.coordinates[1] - snapped.worldY) < EPS) {
					return null;
				}
			}
		}
		return snapped;
	}

	function buildPathStyle(s: DrawItineraryOpts['style']): unknown {
		// Only build a custom style when the caller explicitly provided one.
		// Returning undefined lets drawWayfindingPath fall through to JMap's
		// built-in defaultPathStyle rather than always overriding it with blue.
		if (s == null) return undefined;
		if (typeof jmap.Style !== 'function') return undefined;
		try {
			return new jmap.Style({
				stroke: s.stroke ?? '#578ce0',
				strokeWidth: s.strokeWidth ?? 4,
				strokeOpacity: s.strokeOpacity ?? 1,
			});
		} catch (e) {
			jibLog('minimap', 'new jmap.Style threw', e);
			return undefined;
		}
	}

	// connectedIdx: set of seq indices that are the source or destination of
	// at least one drawn route leg. Only waypoints in this set receive a label
	// — prevents floating numbered pins with no connecting line (Bugbot LOW,
	// PR #18).
	function drawStopNumbers(
		waypoints: unknown[],
		startIndex: number,
		firstLabel: number,
		connectedIdx: Set<number>,
	): void {
		if (typeof control._getParsedMapView !== 'function') return;
		if (typeof jmap.Font !== 'function' || typeof control.jungle?.Text !== 'function') return;
		const TextCtor = control.jungle.Text;
		const FontCtor = jmap.Font;
		// Use a separate counter so skipped waypoints (missing coordinates,
		// unknown mapId, etc.) don't create gaps in the rendered label sequence.
		// Without this, a skip at position i=1 causes position i=2 to render
		// as "2" instead of "1" — only consecutive labels are correct.
		let labelOffset = 0;
		for (let i = startIndex; i < waypoints.length; i++) {
			// Only label waypoints adjacent to at least one drawn route leg.
			// A waypoint with no drawn inbound or outbound leg is unreachable
			// from the user's perspective — a floating pin with no line.
			if (!connectedIdx.has(i)) continue;
			const wp = waypoints[i] as { coordinates?: [number, number]; mapId?: number } | null;
			if (!wp || !Array.isArray(wp.coordinates) || wp.mapId == null) continue;
			const mapObj = mapsColl?.getById?.(wp.mapId);
			if (!mapObj) continue;
			try {
				const text = new TextCtor({
					text: String(firstLabel + labelOffset),
					point: [wp.coordinates[0], wp.coordinates[1]],
					width: 24,
					height: 0,
					rotation: 0,
					visible: true,
					center: true,
					scaleWithMap: false,
					hideOnOverflow: false,
					style: new FontCtor({
						fontSize: '20px',
						fontFamily: 'sans-serif',
						fontWeight: 'bold',
						fill: '#1f2937',
						stroke: '#ffffff',
						strokeThickness: 3,
						align: 'center',
					}),
				});
				const mv = control._getParsedMapView(mapObj);
				const layer = mv?.guaranteeMapLayer?.(ITINERARY_LABEL_LAYER);
				// Only advance the counter when addText actually fires.
				// If _getParsedMapView or guaranteeMapLayer returns undefined the
				// optional chain short-circuits and the text is never placed —
				// incrementing unconditionally would create the same label-numbering
				// gaps the labelOffset variable was introduced to prevent.
				if (layer) {
					layer.addText?.(text);
					labelledMapIds.add(wp.mapId);
					labelOffset++;
				}
			} catch (e) { jibLog('minimap', 'addText threw', e); }
		}
	}

	function clearStopLabels(): void {
		if (typeof control._getParsedMapView !== 'function' || !mapsColl?.getById) return;
		for (const mapId of labelledMapIds) {
			try {
				const mapObj = mapsColl.getById(mapId);
				if (!mapObj) continue;
				const mv = control._getParsedMapView(mapObj);
				const layer = mv?.getLayerByName?.(ITINERARY_LABEL_LAYER)
					?? mv?.guaranteeMapLayer?.(ITINERARY_LABEL_LAYER);
				layer?.clearTexts?.();
			} catch (e) { jibLog('minimap', 'clearTexts threw', e); }
		}
		labelledMapIds.clear();
	}

	function drawItinerary(
		externalIds: Array<string | number>,
		// Renamed from `opts` to `drawOpts` to avoid shadowing the outer
		// createMinimap `opts: CreateMinimapOpts` closure variable. The outer
		// `opts` is only used during setup (destructured into `cfg` on line 478),
		// but the shadow is a latent hazard for future edits (Bugbot LOW, PR #18).
		drawOpts?: DrawItineraryOpts,
	): {
		drawn: number;
		missing: number;
		syntheticStart?: { worldX: number; worldY: number; mapId: number };
	} {
		// Deferred, idempotent CDN load: the first time a route is drawn is the
		// earliest point veer auto-reroute could ever be needed. Pin-only mounts
		// never reach here, so they never fetch the third-party script. No-op
		// when autoReroute === false. The existing "loading in progress" guard
		// (navKitScriptInjected) makes repeat calls cheap.
		ensureNavigationKit();

		clearItinerary();

		// New destination set → allow one fresh framing; same set (re-anchor) keeps it.
		const drawnSig = externalIds.map(String).join('>');
		if (drawnSig !== lastDrawnSig) {
			hasFramedRoute = false;
			lastDrawnSig = drawnSig;
		}

		const startFromMapCenter = drawOpts?.startFromMapCenter ?? false;
		const startCoordinate = drawOpts?.startCoordinate ?? null;
		// Parens: `??` has lower precedence than `>`, so without them this is
		// `(drawOpts?.showStopNumbers ?? externalIds.length) > 1` — correct by
		// accident today but easy to break in a refactor. Spell it out.
		const showStopNumbers = drawOpts?.showStopNumbers ?? (externalIds.length > 1);

		// Three-tier priority for the synthetic start waypoint:
		//   1. startCoordinate  — explicit per-call coordinate (highest priority)
		//   2. cfg.kioskCoordinate — venue-level fixed kiosk
		//   3. startFromMapCenter  — floor geometric centre (fallback)
		// Each tier is attempted independently. Only when a higher-priority
		// source is absent OR its waypoint resolution fails does the next
		// tier run. This ensures a failed kiosk resolve (e.g. kiosk map not
		// yet loaded) still falls through to the geometric-centre path rather
		// than silently losing the start leg.
		const seq: Array<unknown> = [];
		// Tracks whether we prepended a synthetic start waypoint (any source).
		// Used downstream to (a) detect a degenerate single-destination route
		// when the start couldn't be resolved, and (b) skip labeling the
		// synthetic start so numbering begins at the first user destination.
		let syntheticStartPushed = false;

		if (startCoordinate != null) {
			// Tier 1: explicit per-call coordinate (highest priority, no fallback).
			// Caller supplied a specific point; silently substituting the kiosk
			// or the floor centre would be wrong.
			const startWp = resolveCoordinateWaypoint(startCoordinate);
			if (startWp) {
				seq.push(startWp);
				syntheticStartPushed = true;
			}
		} else if (startFromMapCenter) {
			// Tiers 2 + 3 are only relevant when the caller requests a synthetic
			// start (startFromMapCenter: true). cfg.kioskCoordinate is documented
			// as a venue-level replacement for the geometric centre — it is NOT
			// an always-on prepend; without startFromMapCenter the caller expects
			// a plain destination-list route (ResourceMinimap.svelte enforces
			// this via minStops = startFromMapCenter ? 1 : 2).
			if (cfg.kioskCoordinate != null) {
				// Tier 2: venue-level kiosk replaces the geometric centre.
				// If resolution fails (e.g. kiosk map not yet loaded), fall
				// through to tier 3 so the geometric centre is still tried.
				const startWp = resolveCoordinateWaypoint(cfg.kioskCoordinate);
				if (startWp) {
					seq.push(startWp);
					syntheticStartPushed = true;
				}
				// Fall through to tier 3 on resolve failure (startWp falsy).
			}
			if (!syntheticStartPushed) {
				// Tier 3: floor geometric centre — used when no kiosk is
				// configured OR when the kiosk resolve failed above.
				const centreWp = resolveMapCenterWaypoint();
				if (centreWp) {
					seq.push(centreWp);
					syntheticStartPushed = true;
				}
				// Fall through to destinations-only when centre also fails.
				// A degraded A→B→C render is better than no route at all.
			}
		}
		for (const eid of externalIds) {
			seq.push(waypointByExternalId.get(String(eid)));
		}

		const pairs = Math.max(0, seq.length - 1);
		// When the caller requested a synthetic start (startCoordinate,
		// kioskCoordinate, or startFromMapCenter) but resolution failed AND
		// there is only one user-supplied destination, seq=[dest] → pairs=0.
		// We can't draw a leg without two points, but returning
		// { drawn:0, missing:0 } falsely signals success. Return missing=1 so
		// callers know the expected start→dest leg was lost. (Multi-stop
		// fallback still has pairs>0 and doesn't hit this return.)
		if (pairs === 0) {
			// A synthetic start was requested when either: (a) an explicit
			// startCoordinate was supplied, or (b) startFromMapCenter is true
			// (which covers both the kiosk-coordinate and geometric-centre paths,
			// since cfg.kioskCoordinate only activates under startFromMapCenter).
			const startRequested = startCoordinate != null || startFromMapCenter;
			const missing = (startRequested && !syntheticStartPushed && seq.length === 1) ? 1 : 0;
			return { drawn: 0, missing };
		}

		// Capability check deferred until after pairs is computed so the
		// return value satisfies drawn + missing === pairs for all callers.
		if (typeof control.wayfindBetweenWaypoints !== 'function' ||
			typeof control.drawWayfindingPath !== 'function') {
			return { drawn: 0, missing: pairs };
		}

		control.limitConcurrentPaths = false;
		const style = buildPathStyle(drawOpts?.style);

		let drawn = 0;
		let missing = 0;
		// Track which seq indices are adjacent to at least one drawn route leg.
		// A waypoint is "connected" if it is the source (i) or destination (i+1)
		// of a leg that drew successfully. Only connected stops receive a label —
		// prevents floating numbered pins that have no connecting line, which
		// would confuse users (Bugbot LOW, PR #18).
		const connectedIdx = new Set<number>();
		// Rebuild the veer-check path for NavigationKit from this draw's legs.
		lastWayfindSegments = [];
		for (let i = 0; i < pairs; i++) {
			const from = seq[i];
			const to = seq[i + 1];
			if (!from || !to) { missing++; continue; }
			try {
				const segments = (control.wayfindBetweenWaypoints(from, to) ?? []) as unknown[];
				if (segments.length === 0) { missing++; continue; }
				try {
					if (style !== undefined) control.drawWayfindingPath(segments, style);
					else control.drawWayfindingPath(segments);
					drawn++;
					lastWayfindSegments.push(...segments); // accumulate for hasUserVeeredOffRoute
					connectedIdx.add(i);     // source of drawn leg
					connectedIdx.add(i + 1); // destination of drawn leg
				} catch (e) {
					jibLog('minimap', 'drawWayfindingPath threw', e);
					missing++;
				}
			} catch (e) {
				jibLog('minimap', 'wayfindBetweenWaypoints threw', e);
				missing++;
			}
		}

		if (showStopNumbers) {
			// Labels go on user-supplied stops only; the synthetic start at
			// seq[0] (when present) is intentionally unlabelled. Numbering
			// always starts at 1 from the caller's first destination.
			// Skip seq[0] when we prepended a synthetic start so numbering
			// begins at the user's first destination — regardless of WHICH
			// start path resolved it (startCoordinate, kioskCoordinate, or
			// map-centre fallback). Earlier this only checked startFromMapCenter,
			// which mis-labeled direct startCoordinate consumers (Bugbot PR #18).
			const labelStartIdx = syntheticStartPushed ? 1 : 0;
			drawStopNumbers(seq, labelStartIdx, 1, connectedIdx);
		}

		try { control.renderCurrentMapView?.(); } catch (e) { jibLog('minimap', 'renderCurrentMapView threw', e); }

		// Expose the synthetic start so the host can render a "you are here" overlay.
		let syntheticStart: { worldX: number; worldY: number; mapId: number } | undefined;
		if (syntheticStartPushed) {
			const startWp = seq[0] as { coordinates?: [number, number]; mapId?: number } | null;
			if (startWp && Array.isArray(startWp.coordinates) && startWp.mapId != null) {
				syntheticStart = {
					worldX: startWp.coordinates[0],
					worldY: startWp.coordinates[1],
					mapId: startWp.mapId,
				};
				// Keep closure copy so frameCurrentFloor includes it in bounds.
				lastSyntheticStartPos = syntheticStart;
				// Frame once (include the start dot); skip on re-anchors to keep the
				// user's current zoom (see hasFramedRoute).
				if (syntheticStart.mapId === currentMapId && !hasFramedRoute) {
					frameCurrentFloor();
					hasFramedRoute = true;
				}
			}
		}

		return { drawn, missing, syntheticStart };
	}

	// `resetFraming`: only for a GENUINE clear (route removed by the host), NOT the
	// pre-draw clear at the top of drawItinerary. Resetting the frame state there
	// would make the drawnSig check below always fire → re-frame every redraw →
	// the zoom ratchet we fixed. So a user-driven clear → redraw-same-stops cycle
	// re-frames (framing state forgotten), while a re-anchor redraw does not.
	function clearItinerary(resetFraming = false): void {
		try { control.clearWayfindingPath?.(); }
		catch (e) { jibLog('minimap', 'clearWayfindingPath threw', e); }
		clearStopLabels();
		lastSyntheticStartPos = null;
		// Drop the veer-check path too — otherwise hasUserVeeredOffRoute keeps
		// evaluating a route that's no longer drawn and bumps gpsOriginVersion
		// with no active itinerary. (drawItinerary rebuilds it right after.)
		lastWayfindSegments = [];
		if (resetFraming) { hasFramedRoute = false; lastDrawnSig = null; }
	}

	function updateUserPosition(
		coords: { latitude: number; longitude: number } | null,
	): { worldX: number; worldY: number; mapId: number } | null {
		// Null clears the host-side overlay. The SDK doesn't render the
		// dot itself — projection lives here, drawing lives in the host
		// component (parallel to the kiosk-dot pattern in PR #21).
		if (coords === null) {
			return null;
		}
		if (currentMapId == null) {
			jibLog('minimap', 'updateUserPosition: no current floor');
			return null;
		}
		if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
			jibLog('minimap', `updateUserPosition: non-finite coords lat=${coords.latitude} lng=${coords.longitude}`);
			return null;
		}
		// JMap's controller exposes convertCoordinate(point, from, to);
		// it internally passes activeVenue and dispatches to convert<From>To<To>.
		// Input order for EPSG:4326 is [lng, lat] — the underlying impl
		// reverses the venue's [lat, lng] storage internally, so callers feed
		// GeoJSON-order tuples. We build that tuple from the named fields
		// here so callers never have to think about lat-first vs lng-first.
		const point: [number, number] = [coords.longitude, coords.latitude];
		const ctl = control as {
			convertCoordinate?: (p: [number, number], from: string, to: string) => [number, number];
		};
		if (typeof ctl.convertCoordinate !== 'function') {
			jibLog('minimap', 'updateUserPosition: convertCoordinate unavailable on controller');
			return null;
		}
		let world: [number, number];
		try {
			world = ctl.convertCoordinate(point, 'Epsg4326', 'Local');
		} catch (e) {
			jibLog('minimap', 'convertCoordinate threw', e);
			return null;
		}
		if (!Array.isArray(world) || world.length < 2 || !Number.isFinite(world[0]) || !Number.isFinite(world[1])) {
			jibLog('minimap', `convertCoordinate returned bad point: ${JSON.stringify(world)}`);
			return null;
		}
		return { worldX: world[0], worldY: world[1], mapId: currentMapId };
	}

	// EXPERIMENTAL native dot — see MinimapInstance.setNativeUserLocation.
	function setNativeUserLocation(
		world: { worldX: number; worldY: number; mapId: number } | null,
	): boolean {
		const ctl = control as {
			updateUserLocation?: (opts: { position: [number, number]; confidencePercent?: number; width?: number; pulseVisible?: boolean }) => void;
			userLocation?: unknown;
		};
		if (typeof ctl.updateUserLocation !== 'function') {
			jibLog('minimap', 'setNativeUserLocation: updateUserLocation unavailable');
			return false;
		}
		// Null clears: JMap has no explicit clear, but a far-offscreen point or
		// re-init is the documented pattern; we no-op the clear and let the host
		// stop calling. Returning true keeps the host's branching simple.
		// Null clears the native dot. JMap has no documented clear, so hide the
		// userLocation display object if exposed; else fall back to a zero-width,
		// non-pulsing update so no marker is visible. (Used when a route ends and
		// the HTML overlay dot takes over — avoids two stacked location markers.)
		if (world === null) {
			const ul = ctl.userLocation as { visible?: boolean; renderable?: boolean } | undefined;
			if (ul && typeof ul === 'object') {
				if ('visible' in ul) ul.visible = false;
				if ('renderable' in ul) ul.renderable = false;
			}
			try {
				ctl.updateUserLocation({ position: [0, 0], confidencePercent: 0, width: 0, pulseVisible: false });
			} catch { /* best-effort */ }
			try { (control as { renderCurrentMapView?: () => void }).renderCurrentMapView?.(); }
			catch { /* best-effort */ }
			return true;
		}
		try {
			// Re-show in case a prior null-clear hid the display object.
			const ul = ctl.userLocation as { visible?: boolean; renderable?: boolean } | undefined;
			if (ul && typeof ul === 'object') {
				if ('visible' in ul) ul.visible = true;
				if ('renderable' in ul) ul.renderable = true;
			}
			ctl.updateUserLocation({
				position: [world.worldX, world.worldY],
				confidencePercent: 0.5,
				width: 10,
				pulseVisible: true,
			});
			// Do NOT log the world x/y or mapId: on every reliable fix this
			// would write a per-tick indoor movement trail to MapLogger.debug,
			// which a host may forward to telemetry (Sentry breadcrumbs, log
			// aggregation) and persist. Log presence only, never position.
			jibLog('minimap', 'setNativeUserLocation: native user location updated');
			return true;
		} catch (e) {
			jibLog('minimap', 'updateUserLocation threw', e);
			return false;
		}
	}

	function hasUserVeeredOffRoute(thresholdMm: number): boolean {
		if (lastWayfindSegments.length === 0) return false;
		// Resolve lazily: picks up a NavigationKit that finished loading after a
		// slow CDN (the one-shot load path would have lost it to its timeout).
		const kit = getNavigationKit();
		if (!kit) return false;
		try {
			return kit.hasUserVeeredOffRoute(lastWayfindSegments, thresholdMm) === true;
		} catch (e) {
			jibLog('minimap', 'hasUserVeeredOffRoute threw', e);
			return false;
		}
	}

	function subscribeUserLocationSettled(cb: () => void): () => void {
		type Dispatcher = {
			subscribe?: (ev: string, fn: (mo: unknown) => void) => unknown;
			unsubscribe?: (ev: string, fn: (mo: unknown) => void) => void;
		};
		// The dispatcher's home varies by bundled build: the jmap namespace, the
		// controller instance, or the controller's stage. Try each so auto-reroute
		// doesn't silently no-op when it isn't on `jmap`.
		const ctl = control as { dispatcher?: Dispatcher; stage?: { dispatcher?: Dispatcher } };
		const dispatcher: Dispatcher | undefined =
			(jmap as { dispatcher?: Dispatcher }).dispatcher
			?? ctl.dispatcher
			?? ctl.stage?.dispatcher;
		if (!dispatcher || typeof dispatcher.subscribe !== 'function') {
			jibLog('minimap', 'subscribeUserLocationSettled: dispatcher unavailable');
			return () => {};
		}
		const handler = (mo: unknown) => {
			// Only react to the user-location moving object (not route/asset anims).
			if (mo === (control as { userLocation?: unknown }).userLocation) cb();
		};
		dispatcher.subscribe('MOVING_OBJECT_ANIMATION_COMPLETE', handler);
		return () => {
			try { dispatcher.unsubscribe?.('MOVING_OBJECT_ANIMATION_COMPLETE', handler); }
			catch (e) { jibLog('minimap', 'user-location unsubscribe threw', e); }
		};
	}

	function worldToLatLng(
		worldX: number,
		worldY: number,
	): { latitude: number; longitude: number } | null {
		if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;
		const ctl = control as {
			convertCoordinate?: (p: [number, number], from: string, to: string) => [number, number];
		};
		if (typeof ctl.convertCoordinate !== 'function') return null;
		let pt: [number, number];
		try {
			pt = ctl.convertCoordinate([worldX, worldY], 'Local', 'Epsg4326');
		} catch (e) {
			jibLog('minimap', 'worldToLatLng convertCoordinate threw', e);
			return null;
		}
		if (!Array.isArray(pt) || pt.length < 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
			return null;
		}
		// convertCoordinate emits GeoJSON order [lng, lat] for Epsg4326.
		return { longitude: pt[0], latitude: pt[1] };
	}

	// True when the point falls inside [0,width] × [0,height] of the current floor.
	function isWorldInsideFloor(world: { worldX: number; worldY: number; mapId: number } | null): boolean {
		if (!world || world.mapId !== currentMapId) return false;
		const size = floorSizeWorld(currentMapId);
		if (!size) return false;
		return world.worldX >= 0 && world.worldX <= size.width
			&& world.worldY >= 0 && world.worldY <= size.height;
	}

	function resolveColleagueBookings(bookings: ColleagueBooking[]): ColleagueMarker[] {
		const out: ColleagueMarker[] = [];
		for (const b of bookings) {
			const ext = b.externalId;
			if (ext == null || ext === '') continue;
			// Reuse the same resolution path as pins: build a minimal
			// MapResource-shaped object and feed it through
			// resolveDestination + lookupUnitForResource. That way the
			// colleague overlay obeys the same waypoint-id → unit mapping
			// that already works for the pin layer.
			const res: MapResource = {
				externalId: ext,
				name: b.name,
			};
			const dest = resolveDestination(venue, res);
			if (!dest) continue;
			const mapId = dest.locations?.[0]?.mapId;
			if (!mapId) continue;
			const mapObj = mapsColl?.getById?.(mapId);
			const unit = lookupUnitForResource(control, activeVenue, mapObj, destColl, dest, res, jibLog);
			if (!unit) continue;
			const c = unitCenterFromPoints(unit);
			if (!c) continue;
			out.push({ booking: b, mapId, worldX: c.x, worldY: c.y });
		}
		return out;
	}

	// --- Location select (tap → space / amenity) -------------------------------
	//
	// Mirrors the main app's proven tap flow (cx_map handleInteractivity):
	// enableGenericTapHandler → e.localPoint → getClosestWaypointToCoordinatesOnMap
	// → waypoint.associations.{destinations,amenities}. Here the candidate set
	// is built explicitly per floor instead, so the nearest item is always of a
	// kind the host asked for (nearest corridor waypoint ≠ nearest room).

	type TapPoint = { worldX: number; worldY: number; mapId: number };
	type JModel = {
		id?: number;
		name?: string | null;
		externalId?: string | null;
		description?: string | null;
		keywords?: unknown[];
		tags?: unknown[];
		locations?: { getAll?: () => Array<{ mapId?: number; waypointIds?: number[] }> } | Array<{ mapId?: number; waypointIds?: number[] }>;
		_?: Record<string, unknown>;
		export?: () => unknown;
	};
	type JWaypoint = { id?: number; mapId?: number; _?: Record<string, unknown>; export?: () => unknown };

	// JMap has ONE generic-tap slot (each enableGenericTapHandler call replaces
	// it), so register with JMap once and fan out to our own listener set.
	const tapListeners = new Set<(tap: TapPoint) => void>();
	let genericTapArmed = false;
	function onTap(cb: (tap: TapPoint) => void): () => void {
		tapListeners.add(cb);
		if (!genericTapArmed && typeof control.enableGenericTapHandler === 'function') {
			try {
				control.enableGenericTapHandler((e) => {
					const p = readPoint(e?.localPoint);
					if (!p || currentMapId == null) return;
					const tap: TapPoint = { worldX: p.x, worldY: p.y, mapId: currentMapId };
					for (const l of tapListeners) {
						try { l(tap); } catch (err) { jibLog('minimap', 'tap listener threw', err); }
					}
				});
				genericTapArmed = true;
			} catch (e) {
				jibLog('minimap', 'enableGenericTapHandler threw', e);
			}
		}
		return () => { tapListeners.delete(cb); };
	}

	// JSON-safe deep copy (drops functions / cycles by failing to null). Every
	// value placed in MapSelection.raw is plain data, so a selection can be
	// JSON.stringify'd, structured-cloned (postMessage) and mutated by the host
	// without touching JMap's live objects.
	function jsonClone(v: unknown): unknown {
		if (v == null || typeof v !== 'object') return v ?? null;
		try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
	}

	// JSON snapshot of a JMap model. jmap's export() is already a JSON
	// round-trip of the model's payload bag; fall back to cloning the bag.
	function exportModel(m: unknown): Record<string, unknown> | null {
		if (!m || typeof m !== 'object') return null;
		const mm = m as JModel;
		try {
			const out = typeof mm.export === 'function' ? mm.export() : null;
			if (out && typeof out === 'object') return out as Record<string, unknown>;
		} catch { /* fall through to the raw bag */ }
		return mm._ && typeof mm._ === 'object' ? (jsonClone(mm._) as Record<string, unknown> | null) : null;
	}

	// A unit shape's meta is JMap's LIVE object (it back-references the shape's
	// geojson feature and style, and is circular), so never expose it directly:
	// copy the ids plus the feature's own properties.
	function exportUnitMeta(meta: unknown): Record<string, unknown> | null {
		if (!meta || typeof meta !== 'object') return null;
		const m = meta as { destinationIds?: unknown; waypointIds?: unknown; sourceData?: { properties?: unknown } };
		return {
			destinationIds: Array.isArray(m.destinationIds) ? m.destinationIds.filter(n => typeof n === 'number') : [],
			waypointIds: Array.isArray(m.waypointIds) ? m.waypointIds.filter(n => typeof n === 'number') : [],
			properties: jsonClone(m.sourceData?.properties ?? null),
		};
	}

	// Destination/amenity `locations` is a JMap collection in v4 (getAll()),
	// a plain array on older payloads, or only present under the raw `_` bag.
	function modelLocations(m: JModel): Array<{ mapId?: number; waypointIds?: number[] }> {
		const loc = m.locations;
		if (Array.isArray(loc)) return loc;
		if (loc && typeof loc.getAll === 'function') {
			try { return loc.getAll() ?? []; } catch { return []; }
		}
		const raw = m._?.locations;
		return Array.isArray(raw) ? (raw as Array<{ mapId?: number; waypointIds?: number[] }>) : [];
	}

	function waypointOnMap(mapObj: unknown, wpId: number): JWaypoint | null {
		const m = mapObj as { waypoints?: { getById?: (id: number) => unknown } } | null | undefined;
		try { return (m?.waypoints?.getById?.(wpId) as JWaypoint | undefined) ?? null; } catch { return null; }
	}

	// Per-floor unit index, built once per floor on first use (the venue is
	// immutable): each unit polygon's points flattened into typed arrays plus
	// its bounding box and area, so a tap rejects most units with four
	// comparisons and never allocates per vertex.
	interface UnitEntry {
		unit: unknown;
		meta: { destinationIds?: number[]; waypointIds?: number[] } | null;
		xs: Float64Array;
		ys: Float64Array;
		minX: number; minY: number; maxX: number; maxY: number;
		area: number;
	}
	const unitIndexCache = new Map<number, UnitEntry[]>();
	function unitIndex(mapId: number): UnitEntry[] {
		const hit = unitIndexCache.get(mapId);
		if (hit) return hit;
		const out: UnitEntry[] = [];
		for (const u of unitsOn(mapId)) {
			const shape = u as { points?: unknown; meta?: UnitEntry['meta'] };
			const pts = Array.isArray(shape.points) ? shape.points : [];
			const xs = new Float64Array(pts.length), ys = new Float64Array(pts.length);
			let n = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const p of pts) {
				const pt = readPoint(p);
				if (!pt) continue;
				xs[n] = pt.x; ys[n] = pt.y; n++;
				if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
				if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
			}
			if (n < 3) continue;
			// Shoelace area — the innermost of nested containing units wins.
			let sum = 0;
			for (let i = 0, j = n - 1; i < n; j = i++) sum += (xs[j] + xs[i]) * (ys[j] - ys[i]);
			out.push({ unit: u, meta: shape.meta ?? null, xs: xs.subarray(0, n), ys: ys.subarray(0, n), minX, minY, maxX, maxY, area: Math.abs(sum) / 2 });
		}
		unitIndexCache.set(mapId, out);
		return out;
	}

	// Ray-casting point-in-polygon (map-local frame — the same frame as
	// e.localPoint and the pin world coords), bbox-rejected first.
	function unitContains(e: UnitEntry, x: number, y: number): boolean {
		if (x < e.minX || x > e.maxX || y < e.minY || y > e.maxY) return false;
		const { xs, ys } = e;
		let inside = false;
		for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
			if ((ys[i] > y) !== (ys[j] > y) && x < ((xs[j] - xs[i]) * (y - ys[i])) / (ys[j] - ys[i]) + xs[i]) inside = !inside;
		}
		return inside;
	}

	// The destination a unit polygon belongs to: its destinationIds, or for a
	// waypoint-only unit the destination the venue indexes that waypoint
	// under. ONE rule for tap resolution and the outline highlight, so a room
	// that can be selected can also be outlined.
	function unitDestinationId(meta: UnitEntry['meta']): number | undefined {
		const wpId = meta?.waypointIds?.[0];
		return meta?.destinationIds?.[0] ?? (wpId != null ? venue.byWaypointId.get(wpId)?.id : undefined);
	}

	// Candidate index: every destination + amenity waypoint with its
	// coordinate, bucketed by floor in ONE pass over the venue on first use.
	// `desc` caches the host-filter view (built lazily, at most once).
	interface Candidate { kind: 'space' | 'amenity'; model: JModel; wp: JWaypoint; x: number; y: number; desc?: LocationCandidate }
	let candidateIndex: Map<number, Candidate[]> | null = null;
	function candidatesOn(mapId: number): Candidate[] {
		if (!candidateIndex) {
			const index = new Map<number, Candidate[]>();
			const add = (kind: 'space' | 'amenity', coll: { getAll?: () => unknown[] } | null): void => {
				let items: unknown[] = [];
				try { items = coll?.getAll?.() ?? []; } catch (e) { jibLog('minimap', `${kind} getAll threw`, e); }
				for (const m of items as JModel[]) {
					for (const loc of modelLocations(m)) {
						if (typeof loc.mapId !== 'number') continue;
						const mapObj = mapsColl?.getById?.(loc.mapId);
						for (const wpId of loc.waypointIds ?? []) {
							const wp = waypointOnMap(mapObj, wpId);
							const c = wp ? readWaypointCoord(wp) : null;
							if (!wp || !c) continue;
							let bucket = index.get(loc.mapId);
							if (!bucket) index.set(loc.mapId, bucket = []);
							bucket.push({ kind, model: m, wp, x: c.x, y: c.y });
						}
					}
				}
			};
			add('space', destColl as { getAll?: () => unknown[] } | null);
			add('amenity', getCollection(activeVenue, 'amenities'));
			candidateIndex = index;
		}
		return candidateIndex.get(mapId) ?? [];
	}

	// Jibestream custom properties of a destination/amenity — the CMS
	// "extensors" map ({ "Filter Category": "Office 1", … }), read from the raw
	// payload bag. Always a fresh JSON-safe object ({} when none).
	function modelProperties(model: JModel | null): Record<string, unknown> {
		const bag = model?._ as { extensors?: unknown; destinationExtensors?: unknown } | undefined;
		const ext = bag?.extensors ?? bag?.destinationExtensors;
		if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return {};
		return (jsonClone(ext) as Record<string, unknown> | null) ?? {};
	}

	// The identifying fields of an item — what the host's `accept` filter sees
	// and the base every MapSelection is built on (one derivation, not two).
	function describeCandidate(kind: SelectableKind, mapId: number, model: JModel | null, wp: JWaypoint | null): LocationCandidate {
		const isAmenity = kind === 'amenity';
		return {
			kind,
			mapId,
			name: model?.name ?? null,
			externalId: model?.externalId != null && model.externalId !== '' ? String(model.externalId) : null,
			destinationId: !isAmenity && typeof model?.id === 'number' ? model.id : null,
			amenityId: isAmenity && typeof model?.id === 'number' ? model.id : null,
			waypointId: typeof wp?.id === 'number' ? wp.id : null,
			keywords: Array.isArray(model?.keywords) ? model.keywords.map(String) : [],
			tags: Array.isArray(model?.tags) ? model.tags.map(String) : [],
			properties: modelProperties(model),
		};
	}
	function candidateDesc(c: Candidate, mapId: number): LocationCandidate {
		return c.desc ??= describeCandidate(c.kind, mapId, c.model, c.wp);
	}

	function buildSelection(
		kind: SelectableKind,
		world: TapPoint,
		item: { model: JModel | null; wp: JWaypoint | null; x: number; y: number; unitMeta?: unknown },
		distance: number,
	): MapSelection {
		const floor = floors.find(f => f.mapId === world.mapId);
		const fm = floorMeta(world.mapId);
		const raw: Record<string, unknown> = {};
		if (item.model) raw[kind === 'amenity' ? 'amenity' : 'destination'] = exportModel(item.model);
		if (item.wp) raw.waypoint = exportModel(item.wp);
		if (item.unitMeta) raw.unit = exportUnitMeta(item.unitMeta);
		const mmpp = mmPerUnit(world.mapId);
		return {
			...describeCandidate(kind, world.mapId, item.model, item.wp),
			floorName: floor?.mapName ?? cfg.floorLabels?.[world.mapId] ?? floorBaseName(world.mapId),
			floorShortName: fm.shortName,
			floorLevel: fm.level,
			venueId: cfg.venueId,
			worldX: item.x,
			worldY: item.y,
			tapWorldX: world.worldX,
			tapWorldY: world.worldY,
			distance,
			distanceMeters: mmpp != null ? (distance * mmpp) / 1000 : null,
			description: item.model?.description ?? null,
			raw,
		};
	}

	// Millimetres per map unit for a floor (JMap Map.mmPerPixel), or null.
	function mmPerUnit(mapId: number): number | null {
		const m = mapsColl?.getById?.(mapId) as { mmPerPixel?: unknown; _?: { mmPerPixel?: unknown } } | null | undefined;
		const v = m?.mmPerPixel ?? m?._?.mmPerPixel;
		return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
	}

	function resolveLocation(world: TapPoint, ropts: ResolveLocationOptions = {}): MapSelection | null {
		// Omitted → default kinds. An explicit [] means "nothing is selectable"
		// (every tap resolves to null), not "use the default".
		const selectable: SelectableKind[] = ropts.selectable ?? ['space', 'amenity'];
		if (selectable.length === 0) return null;
		// Snap cap: the tighter of the map-unit and the metre limits. Metres
		// convert through this floor's mmPerPixel; unknown scale → ignored.
		const mmpp = mmPerUnit(world.mapId);
		const metreCap = ropts.maxSnapMeters != null && mmpp != null
			? (ropts.maxSnapMeters * 1000) / mmpp
			: Infinity;
		const maxD = Math.min(ropts.maxSnapDistance ?? Infinity, metreCap);
		const mapObj = mapsColl?.getById?.(world.mapId);
		if (!mapObj) return null;
		const { worldX: tx, worldY: ty } = world;
		// Host filter (e.g. rooms-only via tags/keywords). A throwing filter
		// rejects that candidate rather than breaking the tap.
		const accepts = (desc: () => LocationCandidate): boolean => {
			if (!ropts.accept) return true;
			try { return !!ropts.accept(desc()); }
			catch (e) { jibLog('minimap', 'locationSelect.accept threw', e); return false; }
		};

		// 1. Tap inside a unit polygon → that space, distance 0. When polygons
		//    nest (a desk drawn inside an open-office unit) the INNERMOST
		//    (smallest-area) containing unit wins. A unit is only a candidate
		//    when it resolves to a named destination — via its destinationIds,
		//    or, for waypoint-only units, via the venue's waypoint → destination
		//    index. Unassigned floor area is skipped so step 2 wins instead.
		if (selectable.includes('space')) {
			let hit: { model: JModel; wp: JWaypoint | null; entry: UnitEntry } | null = null;
			for (const e of unitIndex(world.mapId)) {
				if ((hit && e.area >= hit.entry.area) || !unitContains(e, tx, ty)) continue;
				const wpId = e.meta?.waypointIds?.[0];
				const destId = unitDestinationId(e.meta);
				const model = destId != null ? ((destColl?.getById?.(destId) as JModel | undefined) ?? null) : null;
				if (!model) continue;
				const wp = wpId != null ? waypointOnMap(mapObj, wpId) : null;
				if (!accepts(() => describeCandidate('space', world.mapId, model, wp))) continue;
				hit = { model, wp, entry: e };
			}
			if (hit) {
				const c = (hit.wp ? readWaypointCoord(hit.wp) : null)
					?? { x: (hit.entry.minX + hit.entry.maxX) / 2, y: (hit.entry.minY + hit.entry.maxY) / 2 };
				return buildSelection('space', world, { model: hit.model, wp: hit.wp, x: c.x, y: c.y, unitMeta: hit.entry.meta }, 0);
			}
		}

		// 2. Nearest destination / amenity waypoint among the selectable kinds,
		//    within the cap (squared distances; the filter only runs on
		//    candidates that could still win).
		const maxD2 = maxD * maxD;
		let best: Candidate | null = null;
		let bestD2 = Infinity;
		for (const c of candidatesOn(world.mapId)) {
			if (!selectable.includes(c.kind)) continue;
			const d2 = (c.x - tx) ** 2 + (c.y - ty) ** 2;
			if (d2 > maxD2) continue;
			const wins = d2 < bestD2
				|| (d2 === bestD2 && best != null && selectable.indexOf(c.kind) < selectable.indexOf(best.kind));
			if (!wins || !accepts(() => candidateDesc(c, world.mapId))) continue;
			best = c;
			bestD2 = d2;
		}
		if (best) return buildSelection(best.kind, world, best, Math.sqrt(bestD2));

		// 3. Bare waypoint fallback (corridor tap far from any POI).
		if (selectable.includes('waypoint')) {
			const wp = resolveCoordinateWaypoint({ mapId: world.mapId, x: tx, y: ty }) as JWaypoint | null;
			const c = wp ? readWaypointCoord(wp) : null;
			if (wp && c && accepts(() => describeCandidate('waypoint', world.mapId, null, wp))) {
				const d = Math.hypot(c.x - tx, c.y - ty);
				if (d <= maxD) return buildSelection('waypoint', world, { model: null, wp, x: c.x, y: c.y }, d);
			}
		}

		// 4. Nothing within reach: the tapped spot itself, when 'point' is
		//    selectable (a picker's "somewhere on this floor, right here").
		if (selectable.includes('point') && accepts(() => describeCandidate('point', world.mapId, null, null))) {
			return buildSelection('point', world, { model: null, wp: null, x: tx, y: ty }, 0);
		}
		return null;
	}

	// Outline highlight for the selected space: every unit polygon on the
	// selection's floor that maps to its destination (unitDestinationId, or
	// any of a multi-unit destination's destinationIds). Restores the
	// previous highlight's original style first. No-op for items without a
	// polygon (amenities, points, destinations the venue drew without a
	// unit). Always re-applied — never skipped as "already highlighted" — and
	// styled on the floor's CURRENT shape objects, so it survives JMap
	// re-showing a floor; the view calls it again after each floor switch.
	// Redraws with ONE frame render (currentMapView.render) — not
	// renderCurrentMapView, which rebuilds every shape and label on the floor.
	let highlighted: unknown[] = [];
	function highlightSelection(sel: MapSelection | null, style: HighlightStyle = {}): void {
		for (const u of highlighted) {
			try { (u as { resetStyle?: () => void }).resetStyle?.(); }
			catch (e) { jibLog('minimap', 'resetStyle threw', e); }
		}
		highlighted = [];
		const destId = sel?.destinationId;
		const units = sel && destId != null
			? unitsOn(sel.mapId).filter(u => {
				const meta = (u as { meta?: UnitEntry['meta'] }).meta ?? null;
				return meta?.destinationIds?.includes(destId) || unitDestinationId(meta) === destId;
			})
			: [];
		if (units.length && typeof control.styleShapes === 'function' && typeof jmap.Style === 'function') {
			try {
				control.styleShapes(units, new jmap.Style({
					fill: style.fill ?? '#2563eb',
					stroke: style.stroke ?? '#1d4ed8',
					strokeWidth: style.strokeWidth ?? 2,
					opacity: style.opacity ?? 0.45,
				}));
				highlighted = units;
			} catch (e) {
				jibLog('minimap', 'highlightSelection threw', e);
			}
		}
		const stage = (control as Record<string, unknown>).stage as { currentMapView?: { render?: () => void } } | undefined;
		try { stage?.currentMapView?.render?.(); }
		catch (e) { jibLog('minimap', 'currentMapView.render threw', e); }
	}

	function listFloors(): FloorSummary[] {
		return floors.map(f => {
			const fm = floorMeta(f.mapId);
			return {
				mapId: f.mapId,
				name: f.mapName,
				shortName: fm.shortName,
				level: fm.level,
				hasPins: f.pins.length > 0,
			};
		});
	}

	// Continue guarding the armed auth-shim timer through to the successful
	// return: any throw during initial floor framing / settle must still
	// dispose the shim before propagating.
	try {
		// Show the opening floor (host's initialMapId when listed, else the
		// dominant one) + start the projection RAF.
		const firstMapId = opts.initialMapId != null && floors.some(f => f.mapId === opts.initialMapId)
			? opts.initialMapId
			: dominantMapId;
		if (firstMapId != null) setFloor(firstMapId, false);
		rafHandle = requestAnimationFrame(tick);

		// Wait for the renderer to settle, then frame to the pins before we
		// return. Caller's loading → ready transition then reveals the already-
		// zoomed view instead of the default extent + a delayed pan/zoom.
		if (firstMapId != null) {
			await new Promise<void>(resolve => setTimeout(resolve, MAP_SETTLE_MS));
			frameCurrentFloor();
		}
	} catch (e) {
		if (rafHandle != null) cancelAnimationFrame(rafHandle);
		resizeObserver?.disconnect();
		try { control.destroy?.(); } catch { /* best-effort teardown */ }
		try { disposeAuthShim?.(); } catch { /* best-effort teardown */ }
		throw e;
	}

	// Mount fully succeeded — now arm the background token refresh (deferred to
	// here so a failed mount never leaves a live timer).
	startAuthRefresh?.();

	return {
		state: { floors, dominantMapId, unresolved },
		setFloor,
		getCurrentMapId: () => currentMapId,
		projectWorldToViewport,
		worldToLatLng,
		nearestWaypointWorld,
		clampWorldToFloor,
		isWorldInsideFloor,
		resolveColleagueBookings,
		drawItinerary,
		clearItinerary,
		updateUserPosition,
		setNativeUserLocation,
		centerOnWorld,
		hasUserVeeredOffRoute,
		subscribeUserLocationSettled,
		onTap,
		resolveLocation,
		highlightSelection,
		listFloors,
		destroy,
	};
}

/**
 * Resolve a resource → JMap unit object via the most reliable available path:
 * waypoint id → destination → getUnitsFromDestination, with a getUnitsFromMap
 * + meta filter fallback.
 */
function lookupUnitForResource(
	control: JController,
	activeVenue: unknown,
	mapObj: unknown,
	destColl: { getById?: (id: number) => unknown } | null,
	dest: Destination,
	res: MapResource,
	jibLog: (stage: string, msg: string, extra?: unknown) => void,
): unknown {
	void activeVenue;
	if (typeof control.getUnitsFromDestination !== 'function') return null;

	const waypointId = Number(res.externalId);
	let sdkDest: unknown = null;
	// getDestinationByWaypointId is private on JMap's wayfinder — use
	// the destinations collection directly instead.
	if (destColl?.getById) {
		try { sdkDest = destColl.getById(dest.id) ?? null; }
		catch { /* fall through */ }
	}
	if (!sdkDest) return null;

	let units: unknown[] = [];
	try {
		const out = control.getUnitsFromDestination(sdkDest);
		if (Array.isArray(out)) units = out;
	} catch (e) {
		jibLog('minimap', 'getUnitsFromDestination threw', e);
	}

	if (units.length === 0 && mapObj && typeof control.getUnitsFromMap === 'function') {
		try {
			const mapUnits = control.getUnitsFromMap(mapObj) || [];
			units = mapUnits.filter(u => {
				const meta = (u as { meta?: { destinationIds?: number[]; waypointIds?: number[] } }).meta;
				if (!meta) return false;
				if (meta.destinationIds?.includes(dest.id)) return true;
				if (Number.isFinite(waypointId) && meta.waypointIds?.includes(waypointId)) return true;
				return false;
			});
		} catch (e) {
			jibLog('minimap', 'getUnitsFromMap fallback threw', e);
		}
	}

	return units[0] ?? null;
}
