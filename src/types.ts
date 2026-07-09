/**
 * Public contract of @cxapp-ai/map-sdk.
 *
 * Design decisions this file encodes (see docs/REQUIREMENTS.md §8 + decision log):
 *  - Backend-agnostic: the SDK performs NO backend calls of its own besides
 *    Jibestream tile/venue traffic. Everything else (booking, colleagues,
 *    images, venue resolution) is injected by the host or absent.
 *  - Framework-agnostic: consumers call `mountIndoorMap(container, options)`;
 *    Svelte is an internal implementation detail, compiled away.
 *  - Mobile + web: every host-bound signal is BOTH a callback in
 *    `options.on` AND a DOM CustomEvent `mapsdk:<name>` dispatched on the
 *    container (bubbling), so native WebView shells can listen without JS
 *    interop into the bundle.
 *  - Fullscreen and in-container are both supported: `mode` at mount time,
 *    `setFullscreen()` at runtime.
 */

// ---------------------------------------------------------------------------
// Provider / venue configuration
// ---------------------------------------------------------------------------

/** Server-minted Jibestream JACS token — the recommended auth mode. */
export interface JibestreamTokenAuth {
	/** Called whenever the SDK needs a (fresh) JACS bearer token. */
	getToken: () => Promise<{ accessToken: string; expiresInSeconds: number }>;
}

/**
 * Direct client-credentials auth. The secret ships to the browser — use only
 * for development/demos, never in production builds.
 */
export interface JibestreamClientAuth {
	clientId: string;
	clientSecret: string;
}

export type JibestreamAuth = JibestreamTokenAuth | JibestreamClientAuth;

/** {mapId, x, y} in Jibestream world coordinates. */
export interface MapCoordinate {
	mapId: number;
	x: number;
	y: number;
}

export interface LatLngBounds {
	north: number;
	south: number;
	east: number;
	west: number;
}

/**
 * Everything the SDK needs to reach a Jibestream venue. The host supplies all
 * of it — there are no baked-in defaults, no env reads, no fallback venue.
 */
export interface JibestreamConfig {
	/**
	 * Forward-compat provider discriminant. v1 implements Jibestream only, so
	 * this is optional and defaults to 'jibestream' when absent. A second map
	 * vendor is a v2 BREAKING change (the real abstraction seam is the internal
	 * `MinimapInstance`, not this config); the discriminant is added now so the
	 * v1 surface can be narrowed non-breakingly later. See docs/DECISIONS.md #5.
	 */
	kind?: 'jibestream';
	/** JACS API origin, e.g. "https://api.jibestream.com". */
	host: string;
	customerId: number;
	venueId: number;
	/**
	 * Required for service accounts without a default map profile — omitting
	 * it when required surfaces as a 401 ("Map profile query param must be
	 * present").
	 */
	mapProfileId?: number;
	auth: JibestreamAuth;

	// Presentation extras (all optional):
	/** mapId → human floor label, overrides venue data. */
	floorLabels?: Record<number, string>;
	/** Wayfinding start fallback when GPS is unavailable/off-venue. */
	kioskCoordinate?: MapCoordinate;
	/** Geo bounds used to decide "at venue" for the GPS overlay. */
	venueBounds?: LatLngBounds;
	/** Anchor for the off-venue "X m away" distance chip. */
	venueCenter?: { lat: number; lng: number };
}

// ---------------------------------------------------------------------------
// Resources (pins)
// ---------------------------------------------------------------------------

/**
 * A pinnable/bookable thing on the map. `externalId` is the Jibestream
 * waypointId — entries without one cannot be pinned (they still appear in the
 * carousel and count toward the unresolved-pin badge).
 */
export interface MapResource {
	externalId?: string | number;
	name: string;
	/** e.g. "room" | "desk" | "tenant" — drives placeholder art + copy. */
	type?: string;
	buildingName?: string;
	floorName?: string;
	/** The building's Jibestream venueId — required on multi-venue campuses. */
	buildingExternalId?: string | number;
	suite?: string;
	address?: string;
	features?: string[];
	/** Carried for host use (events pass the resource back); not rendered by the SDK UI. */
	capacity?: number;
	/** Image path/URL; resolved through `options.images.load` when provided. */
	image?: string;
	alreadyBooked?: boolean;
	/** Carried for host use (events pass the resource back); not rendered by the SDK UI. */
	reservationId?: string;
	/**
	 * Opaque host payload passed back verbatim to `booking.onBook` — carry
	 * whatever your backend needs (times, meetingId, resource ids…).
	 */
	bookingContext?: unknown;
}

export interface ColleagueBooking {
	name: string;
	/** Waypoint externalId of the colleague's booked resource. */
	externalId: string | number;
	floorName?: string;
	buildingName?: string;
	/** Photo path/URL; resolved through `options.images.load` when provided. */
	photo?: string;
}

// ---------------------------------------------------------------------------
// Plugins (all optional; omitting one hides its UI, exactly like today)
// ---------------------------------------------------------------------------

export interface BookingResult {
	confirmed: boolean;
	/** Accepted for host bookkeeping; not currently surfaced by the SDK UI or events. */
	reservationId?: string;
}

export interface BookingPlugin {
	/**
	 * Invoked when the user taps Book on a resource card. The SDK owns the
	 * pending UI (single-flight, 30 s timeout, "Try again"); resolve
	 * `{confirmed: true}` to flip the card to Booked, or use
	 * `handle.confirmBooking()` later for asynchronous confirmation flows.
	 */
	onBook: (resource: MapResource, ctx: unknown) => Promise<BookingResult>;
}

export interface ColleaguesPlugin {
	/** Fetch colleague bookings for the given unix-seconds window. */
	fetch: (startUnix: number, endUnix: number) => Promise<ColleagueBooking[]>;
}

export interface ImageLoaderPlugin {
	/**
	 * Resolve a resource/colleague image reference to a displayable URL
	 * (object URL, data URI, or plain URL). Return null to fall back to
	 * placeholder art. Use this for auth-gated image backends.
	 */
	load: (pathOrUrl: string) => Promise<string | null>;
}

export interface NavigationPlugin {
	/**
	 * Invoked when the user taps Navigate on a resource card. Hosts with a
	 * native turn-by-turn surface deep-link here; omit the plugin to hide the
	 * button. (The legacy `window.__cxaicommand` bridge ships as an optional
	 * helper — see `cxaiNavigationPlugin()` — it is not auto-detected.)
	 */
	onNavigate: (resource: MapResource) => void;
}

export interface GpsOptions {
	/** Max accepted GPS accuracy in metres (default 30). */
	accuracyThresholdM?: number;
	/**
	 * EXPERIMENTAL: also draw JMap's native location dot IN ADDITION to the
	 * SDK's HTML overlay dot, so the two can be compared — it does not replace
	 * the overlay. (Independently of this flag, the SDK always switches to the
	 * native dot and hides the HTML dot while an itinerary is active.)
	 */
	useNativeDot?: boolean;
	/** Fixed fake fix for desktop testing. */
	mock?: { lat: number; lng: number; accuracy?: number };
}

// ---------------------------------------------------------------------------
// Itinerary / wayfinding
// ---------------------------------------------------------------------------

export interface ItineraryOptions {
	/**
	 * Path styling preset. NOT WIRED in v1: both presets currently render
	 * JMap's built-in default path style ('dashed' has no engine support yet);
	 * the option is accepted for forward compatibility only.
	 */
	style?: 'default' | 'dashed';
	/** Draw numbered stop labels (canvas-drawn, starts at 1). */
	showStopNumbers?: boolean;
	/** Start the route from map centre instead of GPS/kiosk. */
	startFromMapCenter?: boolean;
	/**
	 * Restrict path types (documented no-op in jmap.js v4; kept for parity).
	 * Note the engine matches path-type NAMES ('Elevator'/'Stairs'/…), so a
	 * numeric id would not restrict anything even if a future jmap.js honours
	 * the restriction — treat this field as inert.
	 */
	pathType?: number;
}

// ---------------------------------------------------------------------------
// Theming / strings / logging
// ---------------------------------------------------------------------------

/**
 * Theme tokens, applied as `--map-*` CSS custom properties on the SDK root.
 * Defaults reproduce the current popup appearance exactly (the hardcoded
 * fallback palette — the chat popup never consumed host theme vars).
 */
export type MapTheme = Record<string, string>;

/** UI strings; defaults are English. Keys defined in src/strings.ts. */
export type MapStrings = Record<string, string>;

export interface MapLogger {
	debug?: (...args: unknown[]) => void;
	info?: (...args: unknown[]) => void;
	warn?: (...args: unknown[]) => void;
	error?: (...args: unknown[]) => void;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Every callback here is also dispatched as a bubbling DOM CustomEvent on the
 * mount container: name `mapsdk:<lowercased key without "on">`, payload in
 * `event.detail` — e.g. `onResourceSelect` ⇄ `mapsdk:resourceselect`.
 */
export interface MapEventCallbacks {
	onReady: () => void;
	onResourceSelect: (resource: MapResource) => void;
	onFloorChange: (mapId: number) => void;
	onBookRequested: (resource: MapResource) => void;
	onBookingStateChange: (state: {
		resource: MapResource;
		status: 'pending' | 'confirmed' | 'failed';
	}) => void;
	onNavigateRequested: (resource: MapResource) => void;
	onFullscreenChange: (fullscreen: boolean) => void;
	/**
	 * Error channel. Fires on: mount failure (unsized/unmounted container,
	 * venue-load rejection), geolocation denial/failure (`cause` carries the
	 * `GeolocationPositionError`; read `(cause as GeolocationPositionError).code`
	 * — 1=PERMISSION_DENIED, 2=POSITION_UNAVAILABLE, 3=TIMEOUT), background
	 * auth-refresh failure (mid-session token expiry), and failed or empty
	 * itinerary draws (no stops resolved on the map). `cause` is the underlying
	 * error/event where one exists; `message` is always host-displayable.
	 */
	onError: (error: { message: string; cause?: unknown }) => void;
}

// ---------------------------------------------------------------------------
// Mount options + handle
// ---------------------------------------------------------------------------

export interface MapSdkOptions {
	/** Venue + auth. Required. (v1 provider: Jibestream; the engine sits behind this seam so other providers can be added.) */
	provider: JibestreamConfig;
	resources?: MapResource[];
	/** Auto-select this resource's pin on open (the popup's focus behavior). */
	focusResourceId?: string | number;
	/** Ordered stop externalIds to draw a multi-stop route on open. */
	itinerary?: Array<string | number>;
	itineraryOptions?: ItineraryOptions;
	/**
	 * 'container' (default): fill the given element, host owns chrome.
	 * 'fullscreen': SDK fixes itself over the viewport (position:fixed,
	 * inset:0) and locks body scroll until `setFullscreen(false)`/destroy.
	 */
	mode?: 'container' | 'fullscreen';
	/** Live "you are here" overlay. false/omitted = off. */
	gps?: boolean | GpsOptions;
	/**
	 * Load Jibestream NavigationKit for veer-detected auto-reroute during
	 * active wayfinding. Loads a script from cdn.jibestream.com on first
	 * itinerary draw. Set false to never contact the CDN. Default true.
	 */
	autoReroute?: boolean;
	booking?: BookingPlugin;
	colleagues?: ColleaguesPlugin;
	images?: ImageLoaderPlugin;
	navigation?: NavigationPlugin;
	strings?: Partial<MapStrings>;
	theme?: Partial<MapTheme>;
	logger?: MapLogger;
	on?: Partial<MapEventCallbacks>;
}

export interface IndoorMapHandle {
	/**
	 * Replace the pinned resource set.
	 *
	 * REBUILD: this performs a FULL engine reload — the JMap controller is
	 * destroyed and recreated, floor/pin/pan/booking/selection state resets,
	 * `onReady` (and `mapsdk:ready`) re-fires, the venue/building data is
	 * re-fetched, and there is a ~1.3s settle before the map is interactive
	 * again. Not a cheap in-place diff. Call once with the final set rather
	 * than repeatedly.
	 */
	setResources(resources: MapResource[]): void;
	/** Draw (or clear, with null) a multi-stop route. */
	setItinerary(ids: Array<string | number> | null, opts?: ItineraryOptions): void;
	/** Switch floors by Jibestream mapId. */
	setFloor(mapId: number): void;
	/** Select + frame a resource's pin. */
	focusResource(id: string | number): void;
	/** Flip a pending/booked state from an async host confirmation. */
	confirmBooking(id: string | number): void;
	setFullscreen(fullscreen: boolean): void;
	/**
	 * Late-arriving config (e.g. floorLabels fetched after mount).
	 *
	 * REBUILD SEMANTICS — not every patch is cheap:
	 *  - `provider.floorLabels` applies IN PLACE (renames floor labels only; no
	 *    reload).
	 *  - `provider.kioskCoordinate` / `provider.venueBounds` / `venueCenter`
	 *    and any resource change trigger a FULL engine reload: controller
	 *    destroyed + recreated, state (floor/pin/pan/booking/selection) reset,
	 *    `onReady` re-fires, venue data re-fetched, ~1.3s settle.
	 *  - `strings` / `theme` apply in place.
	 * Batch config changes into a single `update()` call to avoid stacking
	 * reloads.
	 */
	update(patch: {
		provider?: Partial<Pick<JibestreamConfig, 'floorLabels' | 'kioskCoordinate' | 'venueBounds' | 'venueCenter'>>;
		strings?: Partial<MapStrings>;
		theme?: Partial<MapTheme>;
	}): void;
	/**
	 * Mandatory teardown — stops the RAF projection loop, ResizeObserver,
	 * geolocation watch, JMap controller, and the auth refresh timer.
	 */
	destroy(): void;
}
