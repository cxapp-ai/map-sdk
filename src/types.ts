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
	/**
	 * Explicit pin placement for POIs the destination index can't resolve.
	 * When `mapId` + `worldX` + `worldY` are all set, the pin is placed
	 * directly at that world coordinate on that floor — no destination or
	 * unit lookup. When only `mapId` is set alongside an `externalId` that is
	 * a Jibestream waypointId, the pin resolves through that floor's waypoint
	 * collection (amenities — restrooms, printers, exits — live there rather
	 * than in the destination index). Coordinates are in the OWN floor's
	 * world frame; a waypoint found only on another floor is route-usable
	 * but never pinned.
	 */
	mapId?: number;
	worldX?: number;
	worldY?: number;
	/**
	 * Host-side "added" state (e.g. the room is on the meeting). Draws the
	 * added pin — the same teardrop with a white plus, colour
	 * `--map-pin-added` — and keeps the pin visible under `pins: 'selected'`.
	 * Read live: changing it through `setResources` does not rebuild the map.
	 */
	added?: boolean;
	/**
	 * Fills the resource's unit polygon(s) with the free/busy colour, or the
	 * parent app's grey for 'unavailable' (`availabilityColors`). Absent =
	 * the unit keeps its venue style. Resources drawn without a unit polygon
	 * get no fill. Read live: changing it through `setResources` repaints
	 * without a rebuild. Fill only — every state stays selectable.
	 */
	availability?: 'free' | 'busy' | 'unavailable';
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
// Floors
// ---------------------------------------------------------------------------

/** One floor of the venue, as listed by `handle.getFloors()`. */
export interface FloorSummary {
	mapId: number;
	/** Label as shown in the floor selector (current floorLabels override applied). */
	name: string;
	/** Jibestream Floor.shortName — usually a string ("L3", "44"); null when unset. */
	shortName: string | number | null;
	/** Jibestream Floor.level (building order) when present. */
	level: number | null;
	/** True when at least one of the mounted resources pins on this floor. */
	hasPins: boolean;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Map-tap selection (`MapSdkOptions.tapSelect`). */
export interface TapSelectOptions {
	/**
	 * What a map tap (or Enter / Space on a focused pin) may select:
	 * resource types (matched against `MapResource.type`, case-insensitive,
	 * e.g. 'room', 'desk') plus the special value 'amenity' for Jibestream
	 * amenities (restrooms, etc.). A pin whose type is not listed ignores
	 * Enter / Space.
	 * Default: every host resource regardless of type, no amenities.
	 * [] = nothing selectable.
	 */
	selectable?: string[];
	/**
	 * Cap for "nearest thing" when the tap is not inside a selectable room
	 * polygon. Default: no cap. Ignored on floors whose venue data carries no
	 * scale (Jibestream `mmPerPixel`).
	 */
	maxSnapMeters?: number;
}

/**
 * The one selected item on the map — a host resource (its pin is drawn
 * selected) or, with `tapSelect`, a Jibestream amenity at one of its
 * locations (a dark marker there; `jibestream.amenityId` + `waypointId` say
 * which). Plain JSON-safe data: every payload is a fresh copy.
 */
export interface MapSelection {
	/** 'map' = the user tapped the map, a pin or a card; 'host' = `focusResource()` / `focusResourceId`. */
	source: 'map' | 'host';
	kind: 'resource' | 'amenity';
	/** The CURRENT host resource (live `resources[]` entry by externalId); null for an amenity. */
	resource: MapResource | null;
	/** `resource.externalId` (the Jibestream waypoint id) as a string; null for an amenity. */
	externalId: string | null;
	name: string;
	mapId: number;
	/** Current floor label (`floorLabels` win). */
	floorName: string | null;
	/** Where the item is drawn: the resource pin / the amenity position. */
	worldX: number;
	worldY: number;
	/**
	 * The map tap that resolved it: `inside` = the tap fell inside the
	 * resource's unit polygon; `distanceMeters` = tap → item (0 inside, null
	 * when the floor has no scale). Null for pin, card and host selections.
	 */
	tap: { worldX: number; worldY: number; distanceMeters: number | null; inside: boolean } | null;
	/**
	 * What Jibestream has on the item; null when nothing resolves (e.g. a
	 * resource placed by explicit coordinates). `externalId` here is the
	 * Jibestream CMS externalId, NOT the host id. `properties` are the CMS
	 * extensors. `raw` holds JSON copies of the matched models (`unit` only
	 * for a tap inside the unit polygon).
	 */
	jibestream: {
		destinationId: number | null;
		amenityId: number | null;
		waypointId: number | null;
		name: string | null;
		description: string | null;
		externalId: string | null;
		category: string | null;
		keywords: string[];
		properties: Record<string, unknown>;
		raw: { destination?: unknown; amenity?: unknown; waypoint?: unknown; unit?: unknown };
	} | null;
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
	 * The selected item changed (see `MapSelection`): fires when a
	 * different resource or amenity becomes selected, and with null when the
	 * selection is cleared (`clearSelection()`, selecting a resource that
	 * has no pin, a rebuild). Re-selecting the same item does not fire again.
	 * An item is a resource (by externalId) or an amenity at one location
	 * (amenity id + waypoint): a second restroom of the same amenity is a
	 * different item. `onResourceSelect` keeps firing on every resource
	 * selection as before.
	 */
	onSelectionChange: (selection: MapSelection | null) => void;
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
	/**
	 * Whether carousel cards offer a "Book" action and a resource thumbnail.
	 * Default true (desks/rooms). Set false for location-only surfaces
	 * (amenity/wayfinding POIs — restrooms, coffee, exits): cards show name +
	 * details only, no Book button, no thumbnail. Booking also requires the
	 * `booking` plugin — `bookable` is the per-mount switch on top of it.
	 */
	bookable?: boolean;
	booking?: BookingPlugin;
	colleagues?: ColleaguesPlugin;
	images?: ImageLoaderPlugin;
	navigation?: NavigationPlugin;
	/**
	 * Render the resource card carousel. Default true. Set false for a
	 * map-only surface (hosts that render their own list); pins still render
	 * and `resourceselect` still fires on pin taps.
	 */
	showCards?: boolean;
	/**
	 * Floor selector visibility. Omitted (default): shown only when more than
	 * one floor is listed — the historical behaviour. true always shows it
	 * (even single-floor); false never does (drive floors via `setFloor`).
	 */
	showFloorSelector?: boolean;
	/**
	 * How floors are picked. 'tabs' (default): one tab per floor, the
	 * historical row. 'dropdown': a compact picker (native select plus
	 * previous/next buttons). 'auto': tabs for up to 6 floors, the dropdown
	 * beyond that.
	 */
	floorSelectorStyle?: 'tabs' | 'dropdown' | 'auto';
	/**
	 * Floor order in the selector / `getFloors()`. 'pins' (default): most
	 * pins first, then mapId — the historical order. 'building': Jibestream
	 * Floor level, then elevation, then a numeric shortName, then mapId.
	 * `allFloors` implies 'building'.
	 */
	floorOrder?: 'pins' | 'building';
	/**
	 * List EVERY building floor of the venue in the floor selector /
	 * `getFloors()`, not just floors that carry a resource pin (venue-level
	 * maps that belong to no building floor are left out), in building order
	 * (see `floorOrder`). Also allows mounting with no `resources` at all (a
	 * bare venue browser); a pin-less floor is framed to its full footprint.
	 * Default false.
	 */
	allFloors?: boolean;
	/**
	 * Floor to open on: a Jibestream mapId, when it is one of the listed
	 * floors, or `{ resource: externalId }` = the floor that resource's pin
	 * is on (the resource is not selected). Ignored when it matches no
	 * listed floor / no placed resource. Read once at (re)build. Wins over
	 * the kiosk floor pick and over `focusResourceId`: a focused resource on
	 * another floor is still selected (card + `resourceselect`), but the map
	 * stays on this floor until the user switches. Default: the floor with
	 * the most pins (the first listed floor under `allFloors` with no
	 * resources).
	 */
	initialFloor?: number | { resource: string | number };
	/**
	 * Which resource pins are drawn. 'all' (default): every pin.
	 * 'selected': only the selected resource's pin plus resources with
	 * `added: true`.
	 */
	pins?: 'all' | 'selected';
	/**
	 * Map-tap selection. Off by default (the map ignores canvas taps). When
	 * on, a tap selects — without recentring or zooming — the innermost
	 * selectable resource whose unit polygon contains it, else the nearest
	 * selectable resource pin or amenity (within `maxSnapMeters`), else
	 * nothing (the selection stays). A tap outside the building (the
	 * floor's Jibestream Boundary outline) selects nothing. Taps register on
	 * pointerup, with no double-tap wait. Pins are not hit targets in this
	 * mode (`pointer-events: none`), so a tap on a pin resolves by what is
	 * under it; a pin focused with the keyboard still selects on Enter /
	 * Space. `true` = defaults (every resource, no amenities). See
	 * `onSelectionChange` / `getSelection()`.
	 */
	tapSelect?: boolean | TapSelectOptions;
	/**
	 * Pin artwork for resource pins and the amenity marker. 'teardrop'
	 * (default): the SDK's pin (white outline; the selected pin grows and
	 * pulses). 'material': the parent app's Material "location_on" pin — a
	 * 40 px box with the tip on the point, a soft shadow, no outline or halo,
	 * and the same size when selected (the colour tokens tell the states
	 * apart). Same colour tokens either way.
	 */
	pinShape?: 'teardrop' | 'material';
	/**
	 * Unit fill colours for `MapResource.availability`. Hex only ('#rrggbb'
	 * or '#rgb' — JMap styles can't read CSS variables). Defaults match the
	 * parent app: free '#00D302', busy '#DF2E07', unavailable '#c2c2c2'.
	 */
	availabilityColors?: { free?: string; busy?: string; unavailable?: string };
	/**
	 * On a container resize keep the zoom and the world point at the centre
	 * of the view (pan only) instead of re-framing the floor's pins. A
	 * container that collapses to zero size and opens again comes back to
	 * the view it had; a focus while it had no size is framed once it opens.
	 * The first layout still frames the floor. Default false (every resize
	 * re-frames the floor).
	 */
	keepViewOnResize?: boolean;
	strings?: Partial<MapStrings>;
	theme?: Partial<MapTheme>;
	logger?: MapLogger;
	on?: Partial<MapEventCallbacks>;
}

export interface IndoorMapHandle {
	/**
	 * Replace the pinned resource set.
	 *
	 * SIGNATURE-GATED: the engine rebuilds only when the set of
	 * `externalId|name` pairs changes. A rebuild is a FULL engine reload —
	 * the JMap controller is destroyed and recreated, floor/pin/pan/booking/
	 * selection state resets, `onReady` (and `mapsdk:ready`) re-fires, the
	 * venue/building data is re-fetched, and there is a ~1.3s settle before
	 * the map is interactive again. Without a rebuild, the fields read live
	 * apply in place: `added`, `availability`, `type` (tap filtering) and the
	 * card fields (`features`, `alreadyBooked`, …) — cards, pin variants and
	 * unit fills update without a reload. Placement (`mapId`, `worldX`/
	 * `worldY`, `buildingExternalId`, and `floorName` as the fallback floor
	 * label) is read only at build, so changing only those moves nothing
	 * until the next rebuild. Call once with the final set rather than
	 * repeatedly.
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
	 * Floors currently listed in the floor selector, in display order: every
	 * building floor under `allFloors`; otherwise the floors that carry pins
	 * plus the `provider.kioskCoordinate` floor when one is set. Current
	 * floorLabels applied. Empty until `ready`.
	 */
	getFloors(): FloorSummary[];
	/**
	 * Jibestream mapId of the floor this resource's pin is on in the current
	 * build (by host externalId, as `focusResource`), or null when it has no
	 * pin, the map is (re)building, or it was destroyed.
	 */
	getResourceMapId(externalId: string | number): number | null;
	/** The current selection (a fresh plain copy, live resource fields), or null. */
	getSelection(): MapSelection | null;
	/**
	 * Clear the selection (the selected pin returns to normal, the amenity
	 * marker goes). Emits `selectionchange(null)` when something was selected.
	 * Also drops the `focusResource()` / `focusResourceId` target, so a later
	 * rebuild does not select it again.
	 */
	clearSelection(): void;
	/**
	 * Late-arriving config (e.g. floorLabels fetched after mount).
	 *
	 * REBUILD SEMANTICS — not every patch is cheap:
	 *  - `provider.floorLabels` applies IN PLACE (renames floor labels only; no
	 *    reload).
	 *  - `provider.kioskCoordinate` / `provider.venueBounds` / `venueCenter`
	 *    and a resource-set change (see `setResources`) trigger a FULL engine reload: controller
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
