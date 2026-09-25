<script module lang="ts">
	// Shared across instances so a freshly-mounted map for the SAME venue
	// seeds from the last known fix without re-acquiring GPS from scratch.
	// Keyed by venueId: switching venues in the same SPA session must NOT
	// seed from the prior venue's fix, which would briefly misplace the user
	// dot, off-map distance, and GPS-origin route until a fresh fix arrives.
	// `reliable` records whether the cached fix passed the accuracy gate. A
	// newly-mounted instance seeds its venue in/out + away-chip decision from
	// any fix, but only places the on-map dot / GPS route from a reliable one.
	let sharedLastFix: {
		coords: { latitude: number; longitude: number };
		venueId: number | null;
		reliable: boolean;
	} | null = null;
</script>

<script lang="ts">
	// IndoorMap — the maximized map experience from nova-chat-sdk's
	// ResourceMinimap.svelte, without the popup chrome. Ported per
	// docs/REQUIREMENTS.md §3 (couplings 1-4, 7-12, 14): contexts/stores →
	// props, modal/portal/Escape/focus chrome deleted, the inline-vs-maximized
	// duplicated state collapsed to a single (maximized-behavior) view, and all
	// backend calls injected as plugins. CSS class names are kept from the
	// original (`rm-*`, including `rm-modal-card` for the root) for
	// diffability against the source component.
	import { onDestroy, tick, untrack } from 'svelte';
	import {
		createMinimap,
		type MinimapInstance,
		type FloorInfo,
		type PinInfo,
		type ColleagueMarker,
		type AvailabilityState,
	} from '../core/engine.js';
	import type {
		JibestreamConfig,
		MapResource,
		ColleagueBooking,
		BookingPlugin,
		ColleaguesPlugin,
		ImageLoaderPlugin,
		NavigationPlugin,
		GpsOptions,
		ItineraryOptions,
		MapStrings,
		MapTheme,
		MapLogger,
		MapBuilding,
		MapFloor,
		MapSelectionChange,
	} from '../types.js';
	import { DEFAULT_STRINGS } from '../strings.js';
	import { placeholderImageForType } from './placeholders.js';

	// ── Local pure helpers ported from nova-chat-sdk ──────────────────────

	// Ported from src/utils/calendar.ts (parseLocalYMD).
	function parseLocalYMD(s: string | undefined | null): Date | null {
		if (!s) return null;
		const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (!m) return null;
		const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
		d.setHours(0, 0, 0, 0);
		return Number.isNaN(d.getTime()) ? null : d;
	}

	function ymdToUnix(s: string | undefined | null): number | null {
		const d = parseLocalYMD(s);
		return d ? Math.floor(d.getTime() / 1000) : null;
	}

	// Ported from src/utils/initials.ts.
	function initials(name: string | null | undefined): string {
		if (!name) return '?';
		return name.split(/\s+/).filter(Boolean).map(p => p[0]).join('').toUpperCase().slice(0, 2) || '?';
	}

	/**
	 * Stable color for an initials-only avatar. Deterministic on the input
	 * string so the same colleague gets the same color across re-renders.
	 * Lightness is kept low enough that the white initials drawn on top stay
	 * readable across the whole hue wheel — at 48% the yellow-green band
	 * dropped to ~2:1 contrast. (Ported from src/services/colleagues.ts.)
	 */
	function colorForName(name: string): string {
		let h = 0;
		for (let i = 0; i < name.length; i++) {
			h = (h * 31 + name.charCodeAt(i)) >>> 0;
		}
		return `hsl(${h % 360}, 50%, 36%)`;
	}

	/**
	 * Safely read the (host-opaque) bookingContext's date window. The chat
	 * host threads `{startDate, endDate}` YMD strings through it; hosts that
	 * don't leave the colleague overlay on its "today" fallback.
	 */
	function ctxDates(r: MapResource): { startDate?: string; endDate?: string } {
		const c = r.bookingContext;
		if (!c || typeof c !== 'object') return {};
		const rec = c as Record<string, unknown>;
		return {
			startDate: typeof rec.startDate === 'string' ? rec.startDate : undefined,
			endDate: typeof rec.endDate === 'string' ? rec.endDate : undefined,
		};
	}

	// ── Props (the public contract — see src/types.ts) ────────────────────

	interface Props {
		/** Venue + auth (v1 provider: Jibestream). Required. */
		provider: JibestreamConfig;
		resources?: MapResource[];
		/**
		 * After the map loads, switch to this resource's floor and auto-select
		 * its pin so the details card is centred on open.
		 */
		focusResourceId?: string | number;
		/**
		 * Ordered list of resource externalIds to wayfind through. Caller's
		 * order is the visual order — no TSP. With `startFromMapCenter=false`
		 * (default), a length-1 input is a no-op clear and length≥2 routes
		 * between consecutive stops. With `startFromMapCenter=true`,
		 * a length-1 input renders a single leg from the floor centre to
		 * that destination. Pass `undefined` or `[]` to clear. Reactive.
		 */
		itinerary?: Array<string | number>;
		itineraryOptions?: ItineraryOptions;
		/**
		 * Auto-reroute (NavigationKit veer detection). Default true. When false,
		 * the third-party CDN script is never loaded. Threaded to the engine's
		 * createMinimap (seam S2).
		 */
		autoReroute?: boolean;
		/** Live "you are here" overlay. false/omitted = off. */
		gps?: boolean | GpsOptions;
		/**
		 * Whether carousel cards offer a "Book" action and a resource
		 * thumbnail. Default true (desks/rooms). Set false for location-only
		 * surfaces (amenity/wayfinding POIs — restrooms, coffee, exits): no
		 * Book button, no thumbnail, card text uses the full width.
		 */
		bookable?: boolean;
		/** 'omx' = the CX super app's map look (see MapSdkOptions.appearance). */
		appearance?: 'default' | 'omx';
		/** Card carousel; defaults from `appearance`. */
		showCards?: boolean;
		/** 'all' pins or only the 'selected' + `added` ones; defaults from `appearance`. */
		pins?: 'all' | 'selected';
		/** Tap a space to select it; defaults from `appearance`. */
		tapSelect?: boolean;
		/** Floor control (tabs, or the OMX pill); default true. */
		floorSelector?: boolean;
		/** Buildings the OMX selector offers. */
		buildings?: MapBuilding[];
		/** Zoom + compass buttons; defaults from `appearance`. */
		mapControls?: boolean;
		/** Booking-from-card plugin. Without it, Book buttons hide. */
		booking?: BookingPlugin;
		/** Colleague-avatar overlay plugin. Without it, the toggle hides. */
		colleagues?: ColleaguesPlugin;
		/** Auth-gated image resolver. Without it, image paths are used as-is. */
		images?: ImageLoaderPlugin;
		/** Native-navigation handoff. Without it, Navigate buttons hide. */
		navigation?: NavigationPlugin;
		strings?: Partial<MapStrings>;
		theme?: Partial<MapTheme>;
		logger?: MapLogger;
		/**
		 * Single outbound-event channel — names per MapEventCallbacks with the
		 * "on" prefix dropped and lowercased ("ready", "resourceselect",
		 * "floorchange", "bookrequested", "bookingstatechange",
		 * "navigaterequested", "error"). The mount layer fans it out to
		 * `options.on` callbacks and `mapsdk:*` DOM CustomEvents.
		 */
		emit: (name: string, detail: unknown) => void;
	}

	let {
		provider,
		resources = [],
		focusResourceId,
		itinerary,
		itineraryOptions,
		autoReroute = true,
		gps = false,
		bookable = true,
		appearance = 'default',
		showCards,
		pins,
		tapSelect,
		floorSelector = true,
		buildings,
		mapControls,
		booking,
		colleagues,
		images,
		navigation,
		strings,
		theme,
		logger,
		emit,
	}: Props = $props();

	// UI strings: host overrides merged over the English defaults.
	const t = $derived({ ...DEFAULT_STRINGS, ...(strings ?? {}) } as MapStrings);

	// Appearance preset → per-feature defaults (each option still overrides).
	const isOmx = $derived(appearance === 'omx');
	const cardsOn = $derived(showCards ?? !isOmx);
	const pinsMode = $derived(pins ?? (isOmx ? 'selected' : 'all'));
	const tapOn = $derived(tapSelect ?? isOmx);
	const controlsOn = $derived(mapControls ?? isOmx);

	// Buildings (OMX selector). Each is its own venue; the one on screen starts
	// as provider.venueId and follows setBuilding / the selector. A host change
	// of provider.venueId wins.
	const multiBuilding = $derived((buildings?.length ?? 0) > 0);
	let activeVenueId = $state<number | null>(untrack(() => provider.venueId ?? null));
	let lastProviderVenueId = untrack(() => provider.venueId ?? null);
	$effect(() => {
		const v = provider.venueId ?? null;
		if (v !== untrack(() => lastProviderVenueId)) {
			lastProviderVenueId = v;
			activeVenueId = v;
		}
	});
	const activeBuilding = $derived(buildings?.find(b => Number(b.venueId) === Number(activeVenueId)) ?? null);
	// The resources the engine maps: with buildings, those of the building on
	// screen (by buildingExternalId; resources without one are kept).
	const venueResources = $derived(
		multiBuilding
			? resources.filter(r => r.buildingExternalId == null || r.buildingExternalId === ''
				|| Number(r.buildingExternalId) === Number(activeVenueId))
			: resources,
	);
	const configuredRotation = $derived(
		Number(activeBuilding?.mapRotation ?? provider.mapRotation ?? 0) || null,
	);
	// Compass: north-up until the user (or a rotation change) says otherwise.
	let northUp = $state(false);
	// The resource each externalId currently names — `added` / `availability`
	// are read live from here, not from the build-time snapshot on PinInfo.
	const liveByExt = $derived(new Map(resources.map(r => [String(r.externalId ?? ''), r])));
	function live(pin: PinInfo): MapResource {
		return liveByExt.get(String(pin.resource.externalId ?? '')) ?? pin.resource;
	}

	// Host theme overrides, applied as --map-* custom properties on the root.
	// DEFAULT_THEME is deliberately NOT applied inline — every CSS usage keeps
	// its original fallback (see src/theme.ts for the per-usage nuances).
	//
	// SECURITY: tokens are applied via `element.style.setProperty(name, value)`
	// (see the $effect below) rather than string-concatenated into the inline
	// `style` attribute. setProperty writes a SINGLE declaration and cannot be
	// used to inject sibling declarations, so a tainted value (e.g. a
	// white-label token from tenant CMS config) can't smuggle in extra CSS
	// (full-viewport redress in fullscreen, `url()` exfil beacons). The key is
	// normalized to `--map-*`; null/undefined values are skipped.
	let rootEl: HTMLDivElement | undefined = $state();
	const themeTokens = $derived(
		Object.entries(theme ?? {})
			.filter(([, v]) => v != null)
			.map(([k, v]) => [k.startsWith('--') ? k : `--map-${k}`, String(v)] as const),
	);
	// Track which token names we set so a token REMOVED from the theme (an
	// update()) is cleared, not left stuck on the root from the prior apply.
	let appliedThemeNames: string[] = [];
	$effect(() => {
		const tokens = themeTokens;
		const el = rootEl;
		if (!el) return;
		const nextNames = tokens.map(([name]) => name);
		for (const name of appliedThemeNames) {
			if (!nextNames.includes(name)) el.style.removeProperty(name);
		}
		for (const [name, value] of tokens) {
			el.style.setProperty(name, value);
		}
		appliedThemeNames = nextNames;
	});

	// Image loader: injected plugin, or plain passthrough (the path/URL is
	// used directly as the <img src>).
	const loadImage = $derived(images?.load ?? (async (pathOrUrl: string) => pathOrUrl));

	// Live-GPS options (`gps`: bool | GpsOptions).
	const gpsEnabled = $derived(!!gps);
	const gpsOpts = $derived(typeof gps === 'object' && gps !== null ? gps : null);
	// Max GPS reading accuracy (metres) the live "you are here" overlay will
	// accept. Readings worse than this are dropped so the dot/arrow freezes at
	// the last reliable fix rather than jumping around on a noisy fix (e.g.
	// when indoor sky view is lost). Defaults to 30m, which is realistic for a
	// phone outdoors but routinely too strict for desktop WiFi-geolocation
	// (often 50–500m) — raise it (or pass a large value) to exercise the
	// overlay during desktop testing.
	const gpsAccuracyThresholdM = $derived(gpsOpts?.accuracyThresholdM ?? 30);
	// EXPERIMENTAL: render the user dot via JMap's native
	// `control.updateUserLocation` instead of the host HTML overlay. Off by
	// default — kept behind a flag pending browser verification under the
	// host-supplied-token controller. When true, the native dot is drawn IN
	// ADDITION to the DIY overlay so the two can be compared before the
	// overlay is removed.
	const useNativeUserDot = $derived(gpsOpts?.useNativeDot ?? false);
	const gpsMock = $derived(gpsOpts?.mock ?? null);

	// Venue lat/lng bounding box (from the provider config). When present it
	// drives a pure point-in-rectangle "at venue?" test and a bbox-centre
	// distance, both independent of the Jibestream map-load lifecycle — so the
	// away/indoor decision and the distance chip are correct the instant a GPS
	// fix lands, not gated on map auth/render. Absent → fall back to the
	// floor-projection heuristic (isWorldInsideFloor).
	const venueBounds = $derived(provider.venueBounds ?? null);
	// Venue centre for the off-venue distance chip. Prefers an explicit
	// `venueCenter` from config, then the bbox centre. Coupling #14: there is
	// NO built-in default venue — with neither configured the away chip hides.
	const venueCenter = $derived<{ latitude: number; longitude: number } | null>(
		provider.venueCenter
			? { latitude: provider.venueCenter.lat, longitude: provider.venueCenter.lng }
			: venueBounds
				? {
						latitude: (venueBounds.north + venueBounds.south) / 2,
						longitude: (venueBounds.west + venueBounds.east) / 2,
					}
				: null,
	);

	type LoadState = 'idle' | 'loading' | 'ready' | 'error';

	// Live-GPS overlay state: either an on-map dot at viewport pixels (`on`),
	// or an off-venue distance label (`off`).
	type UserOverlay =
		| { kind: 'on'; x: number; y: number }
		| { kind: 'off'; label: string };

	let load = $state<LoadState>('idle');
	let loadError = $state<string | null>(null);
	let mm: MinimapInstance | null = null;
	// Bumped whenever an instance is created/torn down so reactive effects
	// (e.g. wayfinding) re-run once the JMap controller is actually ready.
	// `mm` is a plain `let`, not `$state`, so it doesn't trigger reactivity
	// on its own.
	let instanceVersion = $state(0);
	let floors = $state<FloorInfo[]>([]);
	let venueName = $state('');
	let unresolved = $state(0);
	let selectedMapId = $state<number | null>(null);
	// True while a floor switch is in flight (showMap → settle → frame).
	// Drives the loading overlay so the user doesn't see the new floor's
	// default extent flash before the zoom snaps in.
	let switchingFloor = $state(false);

	// Tracking pin screen positions; recomputed every animation frame by the
	// onViewChange callback so HTML pin overlays glue to the underlying map.
	// $state.raw: these arrays/objects are REPLACED wholesale every animation
	// frame (projectPins/projectStart return fresh values); a deep proxy would
	// pay per-element wrapping cost for nothing.
	let positions = $state.raw<Array<{ pin: PinInfo; x: number; y: number } | null>>([]);
	// Screen position of the "you are here" / kiosk dot; updated by onViewChange.
	let startPos = $state.raw<{ x: number; y: number } | null>(null);
	// World coords of the resolved synthetic start (kiosk / map centre).
	let syntheticStart = $state<{ worldX: number; worldY: number; mapId: number } | null>(null);
	let userWorld = $state<{ worldX: number; worldY: number; mapId: number } | null>(null);
	let geolocationWatchId: number | null = null;
	// True only when a wayfinding route is active. Gates the destination pin so
	// it's NOT applied to every tenant in plain directory/browse mode.
	const routeActive = $derived((itinerary?.length ?? 0) > 0);
	// External ids that are actual route stops — a pin is the "destination" only
	// if it's one of these, not just any tenant pin while a route is active.
	const destIds = $derived(new Set((itinerary ?? []).map(String)));
	// Seeded from the module-shared fix so a newly-mounted instance has the
	// last known position immediately (no re-acquisition race) — but only
	// when the cached fix belongs to THIS venue. A fix from a different venue
	// (same SPA session) must not seed; we wait for a fresh fix instead.
	// One-time read at mount: the seed is a snapshot, not a reactive binding.
	// SECURITY: a gps:false mount must NOT seed from the shared cache — doing
	// so would render the previous (gps:true) user's position on a mount whose
	// caller declared location off (revoked consent / logged out on a shared
	// device). Gate the seed on gpsEnabled so gps:false starts location-blind.
	const seedVenueId = untrack(() => provider.venueId ?? null);
	const seedFix =
		untrack(() => gpsEnabled) && sharedLastFix && sharedLastFix.venueId === seedVenueId
			? sharedLastFix
			: null;
	const seedCoords = seedFix?.coords ?? null;
	let lastUserCoords = $state<{ latitude: number; longitude: number } | null>(seedCoords);
	// Latest fix that passed the accuracy gate. Drives everything that *places*
	// the user — the on-map dot, floor-switch reprojection, and the GPS-origin
	// route start — so a noisy fix freezes those at the last reliable position.
	// `lastUserCoords` (any accuracy) still drives the venue in/out + away-chip
	// decision, which must react to every fix. Seeded only from a reliable
	// cached fix so a fresh mount doesn't place the dot from a stale noisy one.
	let lastReliableCoords = $state<{ latitude: number; longitude: number } | null>(
		seedFix?.reliable ? seedFix.coords : null,
	);
	// Redraw nudge for the itinerary effect: bumped on first GPS fix, after a
	// floor-switch reprojection, and on a NavigationKit veer-detected reroute.
	let gpsOriginVersion = $state(0);
	// Veer threshold (map units) for NavigationKit.hasUserVeeredOffRoute. Tunable.
	const VEER_THRESHOLD_MM = 2000;
	// Delays the first route draw until GPS has had a chance to resolve, so
	// we don't race a kiosk draw against an incoming GPS redraw. Flips true on
	// first accepted fix or after GPS_SETTLE_TIMEOUT_MS (so slow/denied GPS
	// still draws from kiosk within the timeout). Pre-true only if a prior
	// instance for THIS venue already has a fix (see seedCoords).
	let gpsSettled = $state(seedCoords != null);
	const GPS_SETTLE_TIMEOUT_MS = 2500;
	// Live-GPS overlay: 'on' draws the you-are-here dot on the floor, 'off'
	// shows the distance-to-venue chip when the user is outside.
	let userOverlay = $state<UserOverlay | null>(null);

	// Colleague avatar overlay — opt-in via the "Show colleagues" toggle so we
	// only hit the host's colleague provider when the user asks for it.
	let colleaguesEnabled = $state(false);
	let colleaguesLoading = $state(false);
	let colleaguesError = $state<string | null>(null);
	// True once we've fetched colleague bookings for this map session,
	// regardless of how many came back. Kept separate from
	// `allColleagueMarkers.length` so a successful empty result doesn't
	// re-hit the provider on every toggle-on.
	let colleaguesFetched = $state(false);
	let allColleagueMarkers = $state<ColleagueMarker[]>([]);
	// $state.raw: replaced wholesale each frame by projectColleagues.
	let colleaguePositions = $state.raw<Array<{ marker: ColleagueMarker; x: number; y: number } | null>>([]);
	// Profile photos load lazily through the injected image loader. Keep a
	// local index of `loading | done` per colleague so the avatar renders the
	// initials fallback instantly and swaps in the photo when it lands.
	let avatarImages = $state<Record<string, { status: 'loading' | 'done'; url?: string }>>({});

	let container: HTMLDivElement | undefined = $state();

	let selectedPin = $state<PinInfo | null>(null);

	let bookingState = $state<{ status: 'idle' } | { status: 'pending' } | { status: 'success' } | { status: 'error'; message: string }>({ status: 'idle' });
	// Reset the pending UI if the host's booking flow never resolves. Without
	// this the card's Book button would sit at "Booking…" forever on a hang.
	let pinPendingTimer: ReturnType<typeof setTimeout> | null = null;
	const PIN_PENDING_TIMEOUT_MS = 30_000;
	function clearPinPendingTimer() {
		if (pinPendingTimer) { clearTimeout(pinPendingTimer); pinPendingTimer = null; }
	}
	// NOTE: navigation (swipe / pin-tap / card-tap) deliberately does NOT touch
	// bookingState. The Booking…/Booked/Try-again chrome is pinned to the booked
	// card via bookingCardExternalId/bookingCardName, so it already shows on the
	// right card regardless of selection. The booking outcome's lifecycle is
	// owned solely by bookCarouselCard (start), the onBook promise resolution /
	// confirmBooking() (success), the pin-pending timer (error) and tearDown
	// (reset) — clearing it on navigation would just drop a still-valid
	// Booked/error badge.

	// The in-flight booking's identity. Matches against
	// `pendingBookingName` (set by bookCarouselCard at send time) rather than
	// `selectedPin` — selectedPin can lag a swipe by a frame and stays at a
	// prior pin when the booked card has no resolved pin.
	let pendingBookingName = $state<string | undefined>(undefined);
	// externalId is the only unambiguous resource key — names collide across
	// floors/buildings ("Conference Room A" on two levels). We track it
	// alongside the name so confirmBooking() can match by id (and the carousel
	// can pin the Booking…/Booked chrome to the exact card) instead of by
	// name, which would mis-attribute or duplicate the badge.
	let pendingBookingExternalId = $state<string | undefined>(undefined);
	let bookingCardExternalId = $state<string | undefined>(undefined);
	// The resource name `bookingState` describes. `bookingState` is a single
	// shared store but conceptually belongs to one card; tying the booking
	// chrome (Booking… / Booked / Try again) to this name rather than to
	// `selectedPin` means a user can swipe to another card while a booking is
	// in flight without the pending UI jumping to the wrong card — and without
	// `selectByExternalId` having to clobber the in-flight `pending` state.
	let bookingCardName = $state<string | undefined>(undefined);
	// The booked resource itself — kept for `bookingstatechange` emissions.
	let bookingCardResource: MapResource | undefined = undefined;

	// Effective focus target. Seeded from the mount-time `focusResourceId`
	// prop, but the exported focusResource() writes it too, so a RUNTIME focus
	// survives a rebuild: the mount effect's auto-select and initial-floor pick
	// read `activeFocusId` (not the raw prop), which no longer snaps back to the
	// mount-time value after every rebuild. A genuine prop change (host passes a
	// new focusResourceId) still wins — synced below.
	let activeFocusId = $state<string | number | undefined>(focusResourceId);
	let lastFocusProp: string | number | undefined = focusResourceId;
	$effect(() => {
		// Only adopt the prop when the host actually changes it; an unrelated
		// parent re-render (same value) must not clobber a runtime focusResource().
		const incoming = focusResourceId;
		if (incoming !== untrack(() => lastFocusProp)) {
			lastFocusProp = incoming;
			activeFocusId = incoming;
		}
	});

	const sig = $derived(
		venueResources.map(r => `${r.externalId ?? ''}|${r.name ?? ''}`).sort().join(',')
		// venueId is included so a live venue switch (config swapped while mounted)
		// rebuilds the instance: teardown nulls the projected world coords, and the
		// new venue re-projects from scratch. lastUserCoords (the user's real lat/lng)
		// is venue-agnostic and intentionally NOT reset — only the projection is stale.
		//
		// floorLabels is DELIBERATELY NOT in the signature: it only renames
		// FloorInfo.mapName, so a late `update({provider:{floorLabels}})` is
		// applied IN PLACE via `floorLabel()` in the floor strip rather than
		// tearing down + re-initing the whole engine (a ≥1.3s rebuild for a
		// pure rename). kioskCoordinate stays in the signature (it changes the
		// synthetic route start / kiosk-first floor selection — a genuine rebuild).
		// `availability` / `added` are deliberately NOT in it: they repaint in
		// place. activeVenueId stands in for provider.venueId (the building on
		// screen, which the OMX selector can change).
		+ '|cfg:' + JSON.stringify({ v: activeVenueId, k: provider.kioskCoordinate }),
	);

	// Reactive floor-label overlay for the floor strip. The engine bakes
	// floorLabels into FloorInfo.mapName at build time; overlaying the CURRENT
	// provider.floorLabels here lets a late update() rename tabs without a
	// rebuild. Falls back to the engine-provided mapName when no override.
	function floorLabel(f: FloorInfo): string {
		return provider.floorLabels?.[f.mapId] ?? f.mapName;
	}

	// ── Mount / rebuild ────────────────────────────────────────────────────
	// Single view (the popup's maximized experience): tick + 2×RAF
	// container-size check, then createMinimap, then the 700ms settle
	// re-projection. Re-runs when the resource signature or venue config
	// changes; cleanup tears the instance down first.
	$effect(() => {
		// Track ONLY the stable signature string. `resources` is a new array
		// on every parent render, so reading `resources` directly here would
		// re-fire the effect — and remount the JMap controller — on every
		// host re-render.
		void sig;
		load = 'loading';
		loadError = null;
		// Snapshot the array once via untrack so we don't add `resources` as
		// an effect dep — the array reference changes on every parent render
		// even when sig is stable. Same for the provider config (its
		// render-affecting fields are already folded into sig).
		const snapshotResources = untrack(() => venueResources.slice());
		const cfg = untrack(() => ({ ...provider, venueId: activeVenueId ?? provider.venueId }));
		const omxLook = untrack(() => isOmx);
		const venuePicked = untrack(() => multiBuilding);
		const rotationAtMount = untrack(() => (northUp ? null : configuredRotation));
		const tapSelectOn = untrack(() => tapOn);
		let cancelled = false;
		// 700ms projection-settle timer (assigned in the async IIFE below). The
		// `cancelled` guard already stops its callback from touching a torn-down
		// instance, but we also clear the handle in cleanup so it doesn't linger
		// in the browser's timer queue after the effect re-runs/unmounts.
		let settleTimer: ReturnType<typeof setTimeout> | null = null;
		(async () => {
			try {
				await tick();
				if (cancelled) return;
				if (!container) {
					load = 'error';
					loadError = t.errorContainerNotMounted;
					return;
				}
				// Wait for the browser to compute layout — flex children
				// frequently still have 0x0 size after `await tick()` because
				// Svelte commits DOM mutations but doesn't force a style/layout
				// pass. JMap captures the container's viewport size at init,
				// so a 0x0 container produces a broken transform and every
				// projection returns NaN. Two raf ticks: one for layout, one
				// for paint. Bail if the container is still zero.
				await new Promise<void>(r => requestAnimationFrame(() => r()));
				await new Promise<void>(r => requestAnimationFrame(() => r()));
				if (cancelled) return;
				const rect = container.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) {
					load = 'error';
					loadError = t.errorContainerNoSize;
					return;
				}
				const inst = await createMinimap({
					container,
					resources: snapshotResources,
					cfg,
					logger: untrack(() => logger),
					// Seam S2: gate + defer NavigationKit (CDN) loading. Snapshot
					// via untrack — a change shouldn't reactively rebuild here.
					autoReroute: untrack(() => autoReroute),
					omx: omxLook,
					// The OMX selector lists every floor of the building.
					allFloors: omxLook,
					venueFromConfig: venuePicked,
					mapRotation: rotationAtMount,
					onSpaceTap: tapSelectOn
						? (ext) => untrack(() => handleSpaceTap(ext))
						: undefined,
					// Seam S1: route async post-init engine failures (e.g.
					// auth-refresh death) to the runtime error channel.
					onEngineError: (e) => emit('error', { message: e.message, cause: e.cause }),
					onViewChange: () => {
						// untrack: fired synchronously inside the itinerary $effect;
						// reactive reads here would cause effect_update_depth_exceeded.
						untrack(() => {
							if (!mm) return;
							positions = projectPins(mm, currentFloor());
							startPos = projectStart(mm, syntheticStart);
							refreshUserOverlay();
							if (colleaguesEnabled && allColleagueMarkers.length > 0) {
								colleaguePositions = projectColleagues(mm, currentFloor());
							}
						});
					},
				});
				if (cancelled) { inst.destroy(); return; }
				mm = inst;
				instanceVersion++;
				floors = inst.state.floors;
				venueName = inst.state.venueName;
				unresolved = inst.state.unresolved;
				if (selectedMapId == null) {
					let initialFloor: number | null = null;
					const focusId = untrack(() => activeFocusId);
					if (focusId !== undefined) {
						const target = String(focusId);
						for (const f of inst.state.floors) {
							if (f.pins.some(p => String(p.resource.externalId ?? '') === target)) {
								initialFloor = f.mapId;
								break;
							}
						}
					}
					// Kiosk-first rule: when an itinerary is being drawn AND a
					// kiosk coordinate is configured, prefer opening the kiosk's
					// floor so cross-floor routes always start on the floor with
					// the "you are here" marker. User can toggle to the
					// destination's floor via the floor tabs. Falls back to
					// dominantMapId when the kiosk's floor isn't in the floors
					// list (e.g. directory map with resources only on other floors).
					if (initialFloor == null) {
						const kioskMapId = cfg.kioskCoordinate?.mapId;
						const hasItinerary = (untrack(() => itinerary)?.length ?? 0) > 0;
						if (hasItinerary && kioskMapId != null && inst.state.floors.some(f => f.mapId === kioskMapId)) {
							initialFloor = kioskMapId;
						}
					}
					if (initialFloor == null) initialFloor = inst.state.dominantMapId;
					if (initialFloor != null) selectedMapId = initialFloor;
				}
				// setFloor BEFORE reproject (it may switch dominant→kiosk); the
				// helper projects against the floor we actually display. INVARIANT.
				if (selectedMapId != null) inst.setFloor(selectedMapId);
				reprojectUserWorld(inst);
				positions = projectPins(inst, currentFloor());
				startPos = projectStart(inst, syntheticStart);
				refreshUserOverlay();
				load = 'ready';
				emit('ready', null);

				// Auto-select the focused resource so its carousel card is
				// centred + its pin highlighted the moment the map opens.
				// Re-runs after the settle window below to catch a focusResourceId
				// whose pin wasn't yet in positions on the first attempt.
				const autoSelect = () => {
					const focusId = untrack(() => activeFocusId);
					if (focusId === undefined) return;
					// Select once (when nothing is selected yet). On the first run
					// the carousel card refs are usually still unbound, so the
					// scroll inside selectByExternalId no-ops — and the retry would
					// otherwise bail because selectedPin is now set. So when already
					// selected, just re-attempt the scroll: by the retry the refs
					// are bound and the focused card finally centres.
					if (!selectedPin) selectByExternalId(focusId, { scroll: true, source: 'focus' });
					else scrollCarouselToExternalId(focusId);
				};
				autoSelect();

				// JMap's view transform isn't ready synchronously after showMap;
				// the first projection above can return [null, null, ...] because
				// getViewportPointFromMapPoint reads a half-initialised transform.
				// The RAF poller normally catches this when fitBoundsInView fires
				// (~600ms after setFloor), BUT setFloor is a no-op when we land
				// on the floor createMinimap already showed → no view change →
				// poller never fires onViewChange → pins stay empty. Force one
				// re-projection past the settle window AND retry the auto-select
				// once the pins have real coords.
				settleTimer = setTimeout(() => {
					if (cancelled || !mm) return;
					positions = projectPins(mm, currentFloor());
					startPos = projectStart(mm, syntheticStart);
					refreshUserOverlay();
					autoSelect();
				}, 700);
			} catch (e) {
				if (cancelled) return;
				load = 'error';
				loadError = e instanceof Error ? e.message : String(e);
				logger?.warn?.('[map-sdk] map mount failed', e);
				emit('error', { message: loadError, cause: e });
			}
		})();
		return () => {
			cancelled = true;
			if (settleTimer) clearTimeout(settleTimer);
			tearDown();
		};
	});

	$effect(() => {
		// When the user picks a different floor, push it to the live instance
		// and hold a loading overlay until it has rendered + framed the new
		// floor. setFloor returns a promise that resolves after the settle +
		// frame.
		if (selectedMapId == null) return;
		const targetMapId = selectedMapId;
		// Skip the overlay flash on initial mount: when the instance is
		// already showing targetMapId, setFloor is a synchronous no-op and
		// the effect would otherwise flip switchingFloor true→false for one
		// frame for nothing.
		const needsSwitch = !!mm && mm.getCurrentMapId() !== targetMapId;
		if (!needsSwitch) return;
		switchingFloor = true;
		mm!.setFloor(targetMapId).finally(() => {
			// Guard against races: if the user clicked another chip mid-flight
			// the newer effect run will set switchingFloor=true again before
			// this resolves; checking against the current selectedMapId keeps
			// the overlay visible until the latest switch lands.
			if (selectedMapId === targetMapId) switchingFloor = false;
			// Re-project GPS against the new floor so the dot + GPS route-start
			// carry the active mapId (else projectStart filters them out and the
			// route stays anchored to the old floor). reprojectUserWorld also bumps
			// gpsOriginVersion, so the itinerary effect re-anchors immediately
			// rather than waiting for the next GPS tick.
			if (mm) reprojectUserWorld(mm);
			// Settled — honour any deferred recenter request from
			// selectByExternalId. Only if the just-landed floor is still the
			// selectedMapId (user may have chip-clicked away mid-switch).
			if (pendingRecenterAfterSwitch && selectedMapId === targetMapId) {
				pendingRecenterAfterSwitch = false;
				recenterOnSelected();
			}
		});
	});

	// Surface floor changes to the host. selectedMapId is the single source
	// of truth, so this covers chip taps, cross-floor selections, setFloor()
	// calls, and the initial floor pick alike; teardown's null reset is not a
	// floor change.
	let lastEmittedMapId: number | null = null;
	$effect(() => {
		const id = selectedMapId;
		untrack(() => {
			if (id != null && id !== lastEmittedMapId) {
				lastEmittedMapId = id;
				emit('floorchange', id);
			}
			if (id == null) lastEmittedMapId = null;
		});
	});

	function currentFloor(): FloorInfo | null {
		if (selectedMapId == null) return null;
		return floors.find(f => f.mapId === selectedMapId) ?? null;
	}

	function projectPins(
		inst: MinimapInstance,
		floor: FloorInfo | null,
	): Array<{ pin: PinInfo; x: number; y: number } | null> {
		if (!floor) return [];
		return floor.pins.map(p => {
			const pt = inst.projectWorldToViewport(p.worldX, p.worldY);
			if (!pt) return null;
			return { pin: p, x: pt.x, y: pt.y };
		});
	}

	function projectStart(
		inst: MinimapInstance | null,
		start: { worldX: number; worldY: number; mapId: number } | null,
	): { x: number; y: number } | null {
		if (!inst || !start) return null;
		const floor = untrack(() => currentFloor());
		if (!floor || floor.mapId !== start.mapId) return null;
		return inst.projectWorldToViewport(start.worldX, start.worldY);
	}

	// True when the user is away from the venue, matching the away-chip
	// definition (resolveUserOverlay): outside the bbox, or — with no bounds —
	// projected off the shown floor.
	function isUserAway(inst: MinimapInstance, world: { worldX: number; worldY: number; mapId: number }): boolean {
		const atVenue = isAtVenue(untrack(() => lastUserCoords));
		return atVenue === false || (atVenue == null && !inst.isWorldInsideFloor(world));
	}

	// When the user is away, snap their far position to the nearest venue waypoint
	// (a real entry point) so the route starts at the venue edge, not the distant
	// GPS point. Pass the route stops as excludeIds so the snap can't land on the
	// destination itself (which would collapse the route). When the snap returns
	// null (excluded, or no waypoint), fall back to the FOOTPRINT-CLAMPED fix — not
	// the raw projection — so we still anchor at the venue edge, never out at the
	// distant GPS point.
	function awayStartWorld(
		inst: MinimapInstance,
		world: { worldX: number; worldY: number; mapId: number },
	): { worldX: number; worldY: number; mapId: number } {
		return inst.nearestWaypointWorld(world, untrack(() => destIds))
			?? inst.clampWorldToFloor(world);
	}

	// The world position to DISPLAY the user dot at. When a route is active and
	// the user is away, snap to the nearest entrance (so the dot sits where the
	// path starts, not at the far GPS point). Otherwise the raw fix.
	function displayUserWorld(
		inst: MinimapInstance,
		world: { worldX: number; worldY: number; mapId: number } | null,
	): { worldX: number; worldY: number; mapId: number } | null {
		if (!world) return null;
		// untrack: called from the GPS watch / reproject (non-reactive), so read
		// itinerary without registering it as a dependency.
		const stops = untrack(() => itinerary) ?? [];
		if (stops.length > 0 && isUserAway(inst, world)) {
			return awayStartWorld(inst, world);
		}
		return world;
	}

	// Pure point-in-rectangle test against the venue bbox. No map dependency —
	// usable the instant a GPS fix arrives. Null bounds → null (caller falls
	// back to the floor-projection heuristic).
	function isAtVenue(
		coords: { latitude: number; longitude: number } | null,
	): boolean | null {
		const b = venueBounds;
		if (!b || !coords) return null;
		return (
			coords.latitude >= b.south &&
			coords.latitude <= b.north &&
			coords.longitude >= b.west &&
			coords.longitude <= b.east
		);
	}

	// Distance from the fix to the venue centre. Pure lat/lng math (no
	// worldToLatLng round-trip, no loaded floor needed), so it can't drift
	// with map state. Reuses the shared `venueCenter` derivation. Null when
	// the host configured neither venueCenter nor venueBounds (coupling #14:
	// no built-in default venue centre).
	function distanceToVenueCenterMeters(
		coords: { latitude: number; longitude: number } | null | undefined,
	): number | null {
		const center = venueCenter;
		if (!center || !coords) return null;
		return haversineMeters(coords, center);
	}

	function haversineMeters(
		a: { latitude: number; longitude: number },
		b: { latitude: number; longitude: number },
	): number | null {
		if (
			!Number.isFinite(a.latitude) || !Number.isFinite(a.longitude) ||
			!Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)
		) return null;
		const R = 6_371_000;
		const toRad = (d: number) => (d * Math.PI) / 180;
		const dLat = toRad(b.latitude - a.latitude);
		const dLng = toRad(b.longitude - a.longitude);
		const lat1 = toRad(a.latitude);
		const lat2 = toRad(b.latitude);
		const h =
			Math.sin(dLat / 2) ** 2 +
			Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
		return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
	}

	function formatDistance(m: number): string {
		// Round to 10 m, but floor at 10 — the chip only shows when the user is
		// OFF the venue, so it must never read "0m away" (a sub-5m fix would
		// round to 0). 10 m is the smallest "away" we'll claim.
		// The unit/word ("m away"/"km away") comes from MapStrings so hosts can
		// localise it; `{d}` is the numeric distance placeholder.
		const rounded = Math.max(10, Math.round(m / 10) * 10);
		if (rounded < 1000) return t.distanceAwayMeters.replace('{d}', String(rounded));
		return t.distanceAwayKilometers.replace('{d}', (m / 1000).toFixed(1));
	}

	// ┌─ REVIEWED & INTENTIONAL — canonical list; do NOT re-flag/re-add ──────────
	// │ These are deliberate, reviewed decisions (the recurring review hot-spots).
	// │ 1. No outdoor/second map — indoor-Jibestream only (Leaflet removed).
	// │ 2. The 'off' distance chip is the SOLE away cue, NOT route-gated — shows
	// │    whenever the user is away, route or not.
	// │ 3. No directional/edge-clamped arrow (descoped); the chip is the whole cue.
	// │ 4. The live 'you are here' dot is INDEPENDENT of the route's start —
	// │    youAreHereMarker (actual position) and routeStartMarker (route origin:
	// │    kiosk/centre on GPS-fallback) are SEPARATE; both can show. Don't hide
	// │    the dot when the route doesn't start from the fix (a reliable fix is a
	// │    valid position even if its waypoint can't path).
	// │ 5. The away chip renders OUTSIDE the load==='ready' / !switchingFloor gate
	// │    (it's map-independent WHEN venueBounds is set — pure lat/lng); only the
	// │    viewport-projected dot/pins stay inside the ready gate.
	// │ 6. AWAY is bbox-authoritative: in-bbox+off-floor → NOTHING (at venue, just
	// │    not on the shown floor); off-floor=away only when no bounds (see table).
	// └───────────────────────────────────────────────────────────────────────────
	//
	// Resolves the live-GPS overlay:
	//   - 'on'  → fix projects onto the shown floor → you-are-here dot at those
	//             pixels (needs instance + reliable-fix world; freezes on noisy fixes).
	//   - 'off' → user is away (outside bbox, or in-bbox off-plan) → distance chip.
	// WITH venueBounds the chip is a pure lat/lng bbox test, so it's computed AND
	// rendered map-free (outside the load==='ready' gate).
	function resolveUserOverlay(
		inst: MinimapInstance | null,
		world: { worldX: number; worldY: number; mapId: number } | null,
	): UserOverlay | null {
		// SECURITY: gps:false must render no location at all (dot OR away chip),
		// even if a stale coord lingered from a prior gps:true mount. Gate here
		// so the you-are-here marker and the "m away" chip both go dark.
		if (!untrack(() => gpsEnabled)) return null;
		const coords = untrack(() => lastUserCoords);
		if (!coords) return null;
		const atVenue = isAtVenue(coords); // pure bbox test; null when no bounds
		// Bundle inst+world so both are non-null together (no `!` assertions).
		const proj = inst && world ? { inst, world } : null;
		const onFloor = proj != null && proj.inst.isWorldInsideFloor(proj.world);

		// On-floor dot — needs the instance + a world projection on the shown floor.
		if (atVenue !== false && proj && onFloor) {
			const floor = untrack(() => currentFloor());
			if (floor && floor.mapId === proj.world.mapId) {
				const p = proj.inst.projectWorldToViewport(proj.world.worldX, proj.world.worldY);
				if (p) return { kind: 'on', x: p.x, y: p.y };
			}
			// On this floor's plan but not the floor currently shown: no dot,
			// and not "away" either, so render nothing.
			return null;
		}

		// AWAY is bbox-authoritative: outside the bbox = away; in-bbox-but-off-shown-
		// floor = "at venue" (no chip); no bounds = floor-projection heuristic.
		const away = atVenue === false || (atVenue == null && proj != null && !onFloor);
		if (!away) return null;

		// Coupling #14: no hardcoded default venue centre. Without an explicit
		// venueCenter or venueBounds-derivable centre (the shared `venueCenter`
		// derivation) the chip has no trustworthy anchor, so it hides entirely
		// rather than measuring a distance to a made-up point.
		if (venueCenter == null) return null;

		// Distance anchor differs by away-case to avoid a stale projection:
		//  - Outside bbox (atVenue===false): live coords → venue centre (proj.world
		//    is the last reliable fix and goes stale once the user leaves).
		//  - No-bounds heuristic (atVenue===null): snap proj.world to the nearest
		//    ENTRANCE waypoint so the chip agrees with where wayfinding begins.
		let meters: number | null = null;
		if (proj && atVenue !== false) {
			const entrance = proj.inst.nearestWaypointWorld(proj.world);
			if (entrance) {
				const entranceLatLng = proj.inst.worldToLatLng(entrance.worldX, entrance.worldY);
				if (entranceLatLng) meters = haversineMeters(coords, entranceLatLng);
			}
		}
		if (meters == null) meters = distanceToVenueCenterMeters(coords);
		const label = meters != null ? formatDistance(meters) : '';
		return label ? { kind: 'off', label } : null;
	}

	// Viewport pixels for an 'on'-floor overlay, else null — lets the template
	// draw the live GPS dot via the same youAreHereMarker snippet.
	function onMapPos(overlay: UserOverlay | null): { x: number; y: number } | null {
		return overlay?.kind === 'on' ? { x: overlay.x, y: overlay.y } : null;
	}

	// Recompute the GPS dot or off-map indicator from the latest world fix.
	// untrack: resolveUserOverlay reads reactive state (lastUserCoords) while
	// the itinerary $effect writes overlay state — tracking here would create
	// a read-write cycle (effect_update_depth_exceeded).
	function refreshUserOverlay() {
		userOverlay = untrack(() => resolveUserOverlay(mm, userWorld));
	}

	// SINGLE owner of "project the GPS fix onto the CURRENT floor". Stores the
	// user-world (dot + GPS route-start anchor), updates the native dot, bumps
	// gpsOriginVersion (re-anchor the route), and refreshes the overlay.
	// INVARIANT: user-world is projected ONLY through here, and ONLY after the
	// displayed floor is set — call this AFTER every setFloor() (mount or
	// floor-switch). Projecting before setFloor tags the world with the wrong
	// mapId, so the dot/route-start target a hidden floor (SDK #21 class).
	// Reliable fixes only — a noisy fix must not move the dot/route-start.
	function reprojectUserWorld(inst: MinimapInstance): void {
		// SECURITY: gps:false must not project or place the user at all.
		if (!untrack(() => gpsEnabled)) return;
		const coords = untrack(() => lastReliableCoords);
		if (!coords) return;
		const w = inst.updateUserPosition(coords);
		userWorld = w;
		if (w) {
			// Mirror the GPS handler's condition: when a route is active the native
			// dot drives veer reroute (and the HTML overlay is suppressed), so it
			// MUST follow a floor reproject — not only when useNativeUserDot is on.
			const routeActive = (untrack(() => itinerary)?.length ?? 0) > 0;
			if (untrack(() => useNativeUserDot) || routeActive) inst.setNativeUserLocation(displayUserWorld(inst, w));
			gpsOriginVersion++;
		}
		refreshUserOverlay();
	}

	function projectColleagues(
		inst: MinimapInstance,
		floor: FloorInfo | null,
	): Array<{ marker: ColleagueMarker; x: number; y: number } | null> {
		if (!floor) return [];
		return allColleagueMarkers.map(m => {
			// Avatars are per-floor: a colleague booked on Floor 2 should not
			// appear on Floor 1. Returning null keeps the array indices stable
			// with the same {#each} loop pattern used for pins.
			if (m.mapId !== floor.mapId) return null;
			const pt = inst.projectWorldToViewport(m.worldX, m.worldY);
			if (!pt) return null;
			return { marker: m, x: pt.x, y: pt.y };
		});
	}

	/**
	 * Derive a unix-second date window for the colleague-bookings fetch.
	 * Prefers `bookingContext.startDate` carried by any of the resources.
	 * Falls back to today if nothing else is available — the worst case
	 * there is "show today's colleagues" which is still a useful default.
	 */
	function dateRangeForColleagues(): { startUnix: number; endUnix: number } {
		for (const r of resources) {
			const { startDate, endDate } = ctxDates(r);
			if (!startDate) continue;
			const startUnix = ymdToUnix(startDate);
			const endBase = ymdToUnix(endDate || startDate);
			if (startUnix != null && endBase != null) {
				// End-of-day so a same-day booking with a 4pm end still falls
				// inside the window (endBase is local midnight of endDate).
				return { startUnix, endUnix: endBase + 86_399 };
			}
		}
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const startUnix = Math.floor(today.getTime() / 1000);
		return { startUnix, endUnix: startUnix + 86_399 };
	}

	// Per-person avatar key. The SDK's flat ColleagueBooking carries a single
	// display name (the chat host's firstName/lastName/id split stays host-
	// side); the waypoint externalId is the per-booking fallback so two
	// distinct nameless bookings still get distinct entries.
	function colleagueKey(b: ColleagueBooking): string {
		return b.name || String(b.externalId ?? 'unknown');
	}

	function colleagueName(b: ColleagueBooking): string {
		return b.name || t.showColleagues;
	}

	async function loadAvatarImages(markers: ColleagueMarker[], isCurrent: () => boolean): Promise<void> {
		const seen = new Set<string>();
		for (const m of markers) {
			const key = colleagueKey(m.booking);
			if (seen.has(key)) continue;
			seen.add(key);
			const existing = avatarImages[key];
			if (existing && (existing.status === 'done' || existing.status === 'loading')) continue;
			const photo = m.booking.photo;
			if (!photo) {
				// Mark as done with no url so the renderer can stop checking
				// — the fallback (initials circle) will show instead.
				avatarImages[key] = { status: 'done' };
				continue;
			}
			avatarImages[key] = { status: 'loading' };
			void loadImage(photo).then(url => {
				// Skip if the map instance changed mid-fetch; otherwise an
				// orphan entry from the prior session lands in the new
				// instance's empty avatarImages map.
				if (!isCurrent()) return;
				avatarImages[key] = { status: 'done', url: url ?? undefined };
			}).catch(() => {
				if (!isCurrent()) return;
				avatarImages[key] = { status: 'done' };
			});
		}
	}

	async function toggleColleagues(): Promise<void> {
		if (colleaguesEnabled) {
			// Turning off: keep cached markers around in memory in case the
			// user toggles back on, but clear the displayed positions and any
			// status banner (e.g. "no colleagues booked") so it doesn't hang
			// around after the user dismisses the overlay.
			colleaguesEnabled = false;
			colleaguesError = null;
			colleaguePositions = [];
			return;
		}
		if (!mm || !colleagues) return;
		// Cached run: we already fetched for this map session — replay the
		// stored markers (which may be `[]` for a campus with zero bookings)
		// instead of re-hitting the provider.
		if (colleaguesFetched) {
			colleaguePositions = projectColleagues(mm, currentFloor());
			colleaguesEnabled = true;
			if (allColleagueMarkers.length === 0) {
				colleaguesError = t.noColleagues;
			}
			return;
		}
		// Snapshot the live instance so we can identity-check on resume —
		// a teardown + rebuild mid-fetch swaps `mm` for a fresh instance, and
		// the stale continuation would otherwise write markers, error banners,
		// or the loading flag onto the new instance.
		const instance = mm;
		colleaguesLoading = true;
		colleaguesError = null;
		try {
			const range = dateRangeForColleagues();
			const bookings = await colleagues.fetch(range.startUnix, range.endUnix);
			if (mm !== instance) return;
			// Drop entries without a waypoint externalId — the feature is
			// strictly a "where on the floorplan" overlay, so an unpinnable
			// booking is skipped (rule ported from the chat's colleague parser).
			const pinnable = bookings.filter(b => b.externalId != null && String(b.externalId) !== '');
			const markers = instance.resolveColleagueBookings(pinnable);
			allColleagueMarkers = markers;
			colleaguesFetched = true;
			colleaguePositions = projectColleagues(instance, currentFloor());
			void loadAvatarImages(markers, () => mm === instance);
			colleaguesEnabled = true;
			if (markers.length === 0) {
				colleaguesError = t.noColleagues;
			}
		} catch (e) {
			if (mm !== instance) return;
			logger?.warn?.('[map-sdk] colleagues fetch failed', e);
			colleaguesError = t.colleaguesError;
		} finally {
			if (mm === instance) colleaguesLoading = false;
		}
	}

	// Whether a carousel card can hand off to the host's navigation surface.
	// Needs a resource externalId (the host's placemark id) AND the injected
	// navigation plugin — without a plugin the button is hidden rather than
	// silently no-opping on tap.
	function canNavigate(r: MapResource): boolean {
		return r.externalId != null && r.externalId !== '' && !!navigation;
	}

	// Hand the resource off to the host's navigation plugin (e.g. a native
	// live-map deeplink). The resource carries buildingExternalId so the host
	// can scope the placemark to the right building's venue.
	function navigateToResource(r: MapResource): void {
		if (!canNavigate(r)) return;
		emit('navigaterequested', r);
		navigation!.onNavigate(r);
	}

	function clickPin(pin: PinInfo) {
		// Pin tap drives the same path as a carousel swipe: scroll the carousel
		// to the matching card, which then triggers floor switch + re-centre via
		// `selectByExternalId`. No floating popup; the carousel IS the detail UI.
		// Pins without an externalId can't round-trip through `selectByExternalId`
		// (the lookup is keyed on it), so fall back to a direct selection so the
		// pin still highlights on tap.
		if (pin.resource.externalId == null) {
			setSelection(pin, 'tap');
			return;
		}
		selectByExternalId(pin.resource.externalId, { scroll: true });
	}

	// The single writer of `selectedPin`. `resourceselect` keeps its original
	// meaning (every selection of a resource, repeats included); `selectionchange`
	// fires once per actual change, with what caused it.
	function setSelection(
		pin: PinInfo | null,
		source: MapSelectionChange['source'],
		opts: { resourceSelect?: boolean } = {},
	): void {
		const prev = selectedPin;
		selectedPin = pin;
		if (pin && opts.resourceSelect !== false) emit('resourceselect', pin.resource);
		if (prev !== pin) {
			const resource = pin ? ($state.snapshot(live(pin)) as MapResource) : null;
			emit('selectionchange', { resource, source } satisfies MapSelectionChange);
		}
	}

	// Tap-to-select (engine onSpaceTap). A tapped space is on the floor on
	// screen, so there is no floor switch — and, like the parent app, the map
	// never pans or zooms. A background tap (null) clears the selection.
	function handleSpaceTap(ext: string | null): void {
		if (ext == null) {
			if (selectedPin) setSelection(null, 'tap');
			return;
		}
		const found = pinForExternalId(ext);
		if (!found) return;
		setSelection(found.pin, 'tap');
		if (cardsOn) scrollCarouselToExternalId(ext);
	}

	// ───────── Carousel state ─────────
	// One card per resource (in caller's order). Swiping the carousel selects
	// a card; that selection drives `selectedPin`, `selectedMapId` (floor
	// switch), and a `centerOnWorld` re-frame of the live map. Pin clicks
	// scroll the carousel to the matching card; both paths converge through
	// `selectByExternalId`.
	const cardRefs: Array<HTMLDivElement | undefined> = $state([]);
	let scrollEndTimer: ReturnType<typeof setTimeout> | null = null;
	// Carousel card thumbnails. Pre-fill with the type placeholder so the card
	// paints instantly, then swap in the host-resolved image as it lands.
	type ThumbState = { status: 'loading' | 'done'; url?: string };
	const thumbs = $state<Record<string, ThumbState>>({});

	function carouselKey(r: MapResource, i: number): string {
		if (r.externalId != null) return String(r.externalId);
		// No externalId — include the image path (or name) in the key so a later
		// list with the same indices but different resources doesn't reuse the
		// cached thumbnail from a stale slot.
		return `row-${i}|${r.image ?? r.name ?? ''}`;
	}

	async function loadThumb(r: MapResource, i: number): Promise<void> {
		const key = carouselKey(r, i);
		if (key in thumbs) return;
		const fallback = placeholderImageForType(r.type);
		if (!r.image) {
			thumbs[key] = { status: 'done', url: fallback };
			return;
		}
		thumbs[key] = { status: 'loading' };
		let photo: string | null = null;
		try {
			photo = await loadImage(r.image);
		} catch {
			// A throwing host loader degrades to the placeholder, same as a
			// null resolution.
			photo = null;
		}
		thumbs[key] = { status: 'done', url: photo ?? fallback };
	}

	$effect(() => {
		// Pre-load thumbnails for every carousel card. The image loader (or the
		// browser cache on the passthrough path) dedupes repeated paths.
		resources.forEach((r, i) => { void loadThumb(r, i); });
		// Prune entries for resources no longer in the list so a long-lived map
		// that cycles resource sets (handle.setResources) doesn't accumulate
		// stale data-URL thumbnails. untrack: writes to `thumbs` (also written
		// by loadThumb) must not re-trigger this effect.
		const live = new Set(resources.map((r, i) => carouselKey(r, i)));
		untrack(() => {
			for (const key of Object.keys(thumbs)) {
				if (!live.has(key)) delete thumbs[key];
			}
		});
	});

	// Pin lookup across ALL floors so the carousel can drive cross-floor
	// selection. Returns null when the resource didn't resolve to a unit
	// (unresolved count > 0 indicates how many fell through). Yields both the
	// pin and its floor in one scan so the caller doesn't re-walk `floors`.
	function pinForExternalId(extId: string | number | undefined | null): { pin: PinInfo; mapId: number } | null {
		if (extId == null) return null;
		const target = String(extId);
		for (const f of floors) {
			for (const p of f.pins) {
				if (String(p.resource.externalId ?? '') === target) return { pin: p, mapId: f.mapId };
			}
		}
		return null;
	}

	// Set when a cross-floor selection is in flight; the floor-switch effect's
	// `.finally` reads it and runs the recenter once `setFloor` has actually
	// settled. Avoids the fixed 700ms guess that races slow devices.
	let pendingRecenterAfterSwitch = $state(false);

	function recenterOnSelected(): void {
		const pin = selectedPin;
		if (!pin) return;
		const found = pinForExternalId(pin.resource.externalId);
		if (!found) return;
		const world = { worldX: pin.worldX, worldY: pin.worldY, mapId: found.mapId };
		mm?.centerOnWorld(world);
	}

	// Single selection path used by both pin click and carousel snap. Sets
	// `selectedPin` + (if needed) `selectedMapId` to trigger the floor-switch
	// effect, then re-centres the live map on the pin once the switch lands.
	// `opts.scroll` controls whether to programmatically scroll the carousel to
	// the selected card (true when triggered by a pin click; false when the
	// user is already mid-scroll on the carousel itself).
	function selectByExternalId(
		extId: string | number | undefined | null,
		opts: { scroll?: boolean; source?: MapSelectionChange['source'] } = {},
	): void {
		const source = opts.source ?? 'tap';
		const found = pinForExternalId(extId);
		if (!found) {
			// Resource is in the list but unresolved on the floorplan (e.g.
			// wrong venue). Clear the pin selection but still scroll so the
			// card is visible.
			setSelection(null, source);
			if (opts.scroll !== false) scrollCarouselToExternalId(extId);
			return;
		}
		setSelection(found.pin, source);
		const needsFloorSwitch = found.mapId !== selectedMapId;
		if (needsFloorSwitch) {
			// Defer the recenter to the floor-switch effect's `.finally`; it
			// awaits setFloor and reframes the floor first.
			pendingRecenterAfterSwitch = true;
			selectedMapId = found.mapId;
		} else {
			// Same floor — re-centre immediately.
			recenterOnSelected();
		}
		if (opts.scroll !== false) scrollCarouselToExternalId(extId);
	}

	function scrollCarouselToExternalId(extId: string | number | undefined | null): void {
		if (extId == null) return;
		const target = String(extId);
		const idx = resources.findIndex(r => String(r.externalId ?? '') === target);
		if (idx < 0) return;
		const card = cardRefs[idx];
		try {
			card?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
		} catch { /* ignore */ }
		// Quiet onCarouselScroll's debounce for the duration of the smooth
		// scroll. The map's centerOnWorld + JMap fitBoundsInView competes for
		// the main thread, so the carousel's scroll events can arrive in
		// bursts with >90 ms gaps. Without this gate, the debounce fires
		// mid-animation, picks whichever card is closest at that instant
		// (often an intermediate one), and briefly flickers `selectedPin`
		// to that wrong card before settling. 500 ms covers the smooth
		// scrollIntoView (~300 ms typical) with slack.
		suppressScrollDetectUntil = performance.now() + 500;
	}

	// Pointer-drag handler for BOTH mouse and touch. Native CSS scroll-snap is
	// `mandatory`, which requires a swipe past the card's halfway point or it
	// snaps back ("stuck" feel on small swipes). We take over: drive scrollLeft
	// ourselves while the pointer is down, and on release decide the target by
	// DIRECTION + a low distance threshold (so a ~30 px purposeful flick
	// commits to the next card). `touch-action: none` on the carousel keeps
	// the browser from also scrolling under us.
	type DragState = {
		container: HTMLDivElement;
		pointerId: number;
		pointerType: string;
		startX: number;
		startScrollLeft: number;
		moved: boolean;
		lastX: number;
	};
	let dragState: DragState | null = null;
	let isDragging = $state(false);
	const DRAG_THRESHOLD_PX = 6;
	// Absolute timestamp (performance.now()) before which onCarouselScroll's
	// debounced detection is suppressed. Set after each programmatic
	// scrollIntoView so the in-flight smooth scroll's intermediate positions
	// don't flicker `selectedPin` to whichever card is closest mid-animation.
	// Pointer-drag swipes (touch + mouse) commit directly from `pointerup`
	// and DON'T go through onCarouselScroll, so this suppression has no
	// effect on user gestures — it only quiets wheel/keyboard scroll handling
	// during the brief animation window.
	let suppressScrollDetectUntil = 0;
	// How many pixels of net finger movement counts as "swipe to next/prev"
	// rather than "snap back to current". Tuned for touch — small enough that a
	// purposeful flick advances, large enough that a stray jitter doesn't.
	const SWIPE_COMMIT_PX = 30;

	// Armed synchronously on a drag-end, read by `onCarouselClick` to swallow
	// the synthesized click the browser dispatches after pointerup. Without it
	// a swipe that ends with the pointer over a card's Book control fires that
	// control's onclick and sends a booking the user never intended.
	// `onCarouselPointerDown` already ignores drags that *start* on the Book
	// button; this covers drags that *end* there.
	let suppressNextClick = false;
	function onCarouselClick(e: MouseEvent): void {
		if (!suppressNextClick) return;
		suppressNextClick = false;
		e.preventDefault();
		e.stopPropagation();
	}

	function onCarouselPointerDown(e: PointerEvent, carousel: HTMLDivElement): void {
		// Clear any stale suppressor left by a previous swipe whose synthesized
		// click never fired (pointermove called preventDefault) — otherwise it
		// would swallow this gesture's eventual tap on Book / a card. pointerdown
		// always precedes that click, so resetting here is a safe clean slate.
		suppressNextClick = false;
		// Ignore drags that start on the Book / Navigate buttons so a click still
		// books / deeplinks rather than being captured as the start of a swipe.
		const target = e.target as HTMLElement | null;
		if (target?.closest('.rm-carousel-book') || target?.closest('.rm-carousel-nav')) return;
		dragState = {
			container: carousel,
			pointerId: e.pointerId,
			pointerType: e.pointerType,
			startX: e.clientX,
			startScrollLeft: carousel.scrollLeft,
			moved: false,
			lastX: e.clientX,
		};
		// Defer setPointerCapture until movement exceeds the drag threshold.
		// Capturing on pointerdown redirects the synthesised click event to
		// the container — which kills card taps (the click never reaches the
		// card's onclick). Once the user has clearly committed to a drag (past
		// threshold) we capture so the drag continues even if the cursor/finger
		// leaves the container.
	}

	function onCarouselPointerMove(e: PointerEvent): void {
		const s = dragState;
		if (!s || e.pointerId !== s.pointerId) return;
		const dx = e.clientX - s.startX;
		s.lastX = e.clientX;
		if (!s.moved && Math.abs(dx) >= DRAG_THRESHOLD_PX) {
			s.moved = true;
			isDragging = true;
			try { s.container.setPointerCapture(s.pointerId); } catch { /* ignore */ }
		}
		if (s.moved) {
			s.container.scrollLeft = s.startScrollLeft - dx;
			// `preventDefault` is harmless on mouse moves; on touch+pen it stops
			// the browser from synthesising scroll/zoom gestures that would
			// fight our manual scrollLeft updates.
			e.preventDefault();
		}
	}

	function onCarouselPointerEnd(e: PointerEvent): void {
		const s = dragState;
		if (!s || e.pointerId !== s.pointerId) return;
		const wasDragging = s.moved;
		if (wasDragging) {
			try { s.container.releasePointerCapture(s.pointerId); } catch { /* ignore */ }
		}
		isDragging = false;
		dragState = null;
		if (!wasDragging) return; // Pure tap — let the card's onclick fire.

		// Arm the click-suppressor synchronously: the browser dispatches the
		// click AFTER pointerup, so the capture handler below will see this set
		// and swallow it — preventing an accidental Book/select on swipe-end.
		suppressNextClick = true;

		// Decide the target card. The strip is scrolled live during the drag, so
		// the nearest card to the current centre reflects where the user actually
		// dragged to. selectedPin is frozen during the drag (onCarouselScroll is
		// gated on !isDragging), so a direction±1 step from it would ignore a LONG
		// drag that carried the strip several slots and snap to the wrong card.
		// Nearest when no prior selection OR the drag moved more than one slot;
		// otherwise a short purposeful flick (>= 30 px) advances exactly one card
		// (nearest-by-position alone feels sticky for small swipes).
		const netDx = s.lastX - s.startX;
		const center = s.container.scrollLeft + s.container.clientWidth / 2;
		let nearestIdx = 0;
		let bestDist = Infinity;
		for (let i = 0; i < cardRefs.length; i++) {
			const c = cardRefs[i];
			if (!c) continue;
			const cardCenter = c.offsetLeft + c.offsetWidth / 2;
			const dist = Math.abs(cardCenter - center);
			if (dist < bestDist) { bestDist = dist; nearestIdx = i; }
		}
		const currentTarget = selectedPin ? String(selectedPin.resource.externalId ?? '') : '';
		const fromIdx = resources.findIndex(r => String(r.externalId ?? '') === currentTarget);
		let targetIdx;
		if (fromIdx < 0 || Math.abs(nearestIdx - fromIdx) > 1) {
			targetIdx = nearestIdx;
		} else if (netDx <= -SWIPE_COMMIT_PX && fromIdx < resources.length - 1) {
			targetIdx = fromIdx + 1;
		} else if (netDx >= SWIPE_COMMIT_PX && fromIdx > 0) {
			targetIdx = fromIdx - 1;
		} else {
			targetIdx = nearestIdx;
		}
		const r = resources[targetIdx];
		if (r) selectByExternalId(r.externalId, { scroll: true });
	}

	function onCarouselScroll(carousel: HTMLDivElement): void {
		// Skip while the user is actively pointer-dragging: pointerup snaps to
		// the right card explicitly, so the debounce here would just fight the
		// drag.
		if (isDragging) return;
		// Skip while a programmatic smooth scroll is animating to a target
		// card (see scrollCarouselToExternalId for the rationale).
		if (performance.now() < suppressScrollDetectUntil) return;
		if (scrollEndTimer) clearTimeout(scrollEndTimer);
		scrollEndTimer = setTimeout(() => {
			scrollEndTimer = null;
			if (!carousel) return;
			const center = carousel.scrollLeft + carousel.clientWidth / 2;
			let bestIdx = -1;
			let bestDist = Infinity;
			for (let i = 0; i < cardRefs.length; i++) {
				const c = cardRefs[i];
				if (!c) continue;
				const cardCenter = c.offsetLeft + c.offsetWidth / 2;
				const dist = Math.abs(cardCenter - center);
				if (dist < bestDist) { bestDist = dist; bestIdx = i; }
			}
			if (bestIdx < 0) return;
			const r = resources[bestIdx];
			if (!r) return;
			const target = String(r.externalId ?? '');
			const currentSel = selectedPin ? String(selectedPin.resource.externalId ?? '') : '';
			if (target && target !== currentSel) {
				selectByExternalId(r.externalId, { scroll: false });
			}
		}, 90);
	}

	// Carousel can-book gate: book is offered when the host wired a booking
	// plugin, we have a resource name, and it isn't already reserved.
	function canBookCarousel(r: MapResource): boolean {
		// Mall/directory tenants are destinations, not reservable spaces —
		// they carry suite/address, not a booking flow. Keep suppressing Book
		// for them so a directory result never shows a bookable button.
		// `bookable` (prop, default true) is the per-mount switch for
		// location-only surfaces (amenity POIs) — no Book even with a plugin.
		return bookable && !!booking && r.type !== 'tenant' && !r.alreadyBooked && !!r.name;
	}

	// Book directly from a carousel card. Bypasses `selectedPin` because the
	// card may be momentarily mid-snap and `selectedPin` could lag the visible
	// card by a frame. The injected `booking.onBook` callback replaces the
	// chat's Bond hidden-prompt + confirmation-subscription pair; the SDK
	// keeps the single-flight / 30s-timeout / Try-again state machine.
	function bookCarouselCard(r: MapResource): void {
		// Only one booking can be in flight at a time (a single shared
		// bookingState / pendingBookingName). Starting a second while one is
		// pending would overwrite the pending match, so the first booking's
		// confirmation would no longer be recognised — surfacing a false
		// timeout/error on the wrong card while the original still completes.
		// The Book buttons are disabled during pending; this guards the
		// keyboard/programmatic path too.
		if (bookingState.status === 'pending') return;
		// Book buttons are hidden without the plugin; guard this path too.
		if (!booking) return;
		if (!r.name) {
			bookingState = { status: 'error', message: t.errorMissingResourceName };
			return;
		}
		// Sync selectedPin so the card visually highlights, but record the
		// expected resource identity explicitly so confirmation matches the
		// BOOKED card — not whatever pin happened to be selected last (which
		// lingers when the card has no resolved pin).
		const found = pinForExternalId(r.externalId);
		if (found) setSelection(found.pin, 'tap', { resourceSelect: false });
		pendingBookingName = r.name;
		bookingCardName = r.name;
		const extId = r.externalId != null ? String(r.externalId) : undefined;
		pendingBookingExternalId = extId;
		bookingCardExternalId = extId;
		bookingCardResource = r;
		bookingState = { status: 'pending' };
		emit('bookrequested', r);
		emit('bookingstatechange', { resource: r, status: 'pending' });
		clearPinPendingTimer();
		pinPendingTimer = setTimeout(() => {
			pinPendingTimer = null;
			if (bookingState.status === 'pending') {
				bookingState = { status: 'error', message: t.errorNoResponse };
				emit('bookingstatechange', { resource: r, status: 'failed' });
			}
		}, PIN_PENDING_TIMEOUT_MS);
		// bookingContext passes back to the host verbatim (opaque payload).
		void booking.onBook(r, r.bookingContext).then((result) => {
			// Stale guard: teardown or a later flow may have reassigned the
			// pending slot while the host promise was in flight.
			if (bookingState.status !== 'pending') return;
			if (pendingBookingExternalId !== extId || pendingBookingName !== r.name) return;
			if (result?.confirmed) {
				clearPinPendingTimer();
				pendingBookingName = undefined;
				pendingBookingExternalId = undefined;
				bookingState = { status: 'success' };
				emit('bookingstatechange', { resource: r, status: 'confirmed' });
			}
			// `{confirmed: false}` → stay pending: the host confirms
			// asynchronously via confirmBooking(id), or the 30s timer
			// surfaces "Try again".
		}).catch((e) => {
			if (bookingState.status !== 'pending') return;
			if (pendingBookingExternalId !== extId || pendingBookingName !== r.name) return;
			clearPinPendingTimer();
			bookingState = {
				status: 'error',
				message: e instanceof Error && e.message ? e.message : t.errorNoResponse,
			};
			emit('bookingstatechange', { resource: r, status: 'failed' });
		});
	}

	/**
	 * Flip the pending booking to Booked from an asynchronous host
	 * confirmation. Ports the chat's booking-created matcher: externalId is
	 * the unambiguous signal; the pending resource NAME is accepted as a
	 * fallback for hosts whose confirmation only carries the label.
	 */
	export function confirmBooking(id: string | number): void {
		if (bookingState.status !== 'pending') return;
		const key = String(id);
		const matched =
			(!!pendingBookingExternalId && pendingBookingExternalId === key)
			|| (!!pendingBookingName && pendingBookingName === key);
		if (matched) {
			clearPinPendingTimer();
			pendingBookingName = undefined;
			pendingBookingExternalId = undefined;
			bookingState = { status: 'success' };
			if (bookingCardResource) {
				emit('bookingstatechange', { resource: bookingCardResource, status: 'confirmed' });
			}
		}
	}

	/** Select + frame a resource's pin (and centre its carousel card). */
	export function focusResource(id: string | number): void {
		// Persist the runtime focus so a later rebuild re-asserts THIS resource,
		// not the mount-time focusResourceId prop (minor arch fix).
		activeFocusId = id;
		selectByExternalId(id, { scroll: true, source: 'focus' });
	}

	/** Switch floors by Jibestream mapId. */
	export function setFloor(mapId: number): void {
		pickFloor(mapId);
	}

	/** Drop the selection. A later rebuild does not re-select the last focus. */
	export function clearSelection(): void {
		activeFocusId = undefined;
		if (selectedPin) setSelection(null, 'clear');
	}

	export function getSelection(): MapResource | null {
		return selectedPin ? ($state.snapshot(live(selectedPin)) as MapResource) : null;
	}

	export function getFloors(): MapFloor[] {
		return floors.map(f => ({
			mapId: f.mapId,
			name: floorLabel(f),
			shortName: f.shortName,
			pinCount: f.pins.length,
		}));
	}

	export function getCurrentFloor(): number | null {
		return selectedMapId;
	}

	/** Switch building (a full rebuild on its venue). */
	export function setBuilding(venueId: number): void {
		const b = buildings?.find(x => Number(x.venueId) === Number(venueId));
		if (!b || Number(b.venueId) === Number(activeVenueId)) return;
		activeVenueId = Number(b.venueId);
		// A new building starts in its own orientation.
		northUp = false;
		emit('buildingchange', $state.snapshot(b));
	}

	function tearDown() {
		// A rebuild drops the selection; tell the host (after destroy() the
		// mount layer squelches this).
		if (selectedPin) emit('selectionchange', { resource: null, source: 'clear' } satisfies MapSelectionChange);
		mm?.destroy();
		mm = null;
		instanceVersion++;
		positions = [];
		syntheticStart = null;
		startPos = null;
		userWorld = null;
		userOverlay = null;
		floors = [];
		unresolved = 0;
		selectedMapId = null;
		selectedPin = null;
		load = 'idle';
		loadError = null;
		bookingState = { status: 'idle' };
		bookingCardName = undefined;
		bookingCardExternalId = undefined;
		bookingCardResource = undefined;
		pendingBookingName = undefined;
		pendingBookingExternalId = undefined;
		clearPinPendingTimer();
		// Cancel any pending carousel scroll-end debounce so its callback can't
		// fire selectByExternalId against the instance we just tore down.
		if (scrollEndTimer) { clearTimeout(scrollEndTimer); scrollEndTimer = null; }
		// Reset the colleague layer too — a rebuild should start with the
		// toggle off and no stale markers from the previous resource set's
		// date range.
		colleaguesEnabled = false;
		colleaguesLoading = false;
		colleaguesError = null;
		colleaguesFetched = false;
		allColleagueMarkers = [];
		colleaguePositions = [];
		avatarImages = {};
		// SECURITY: null the module-shared fix cache so a LATER mount on a shared
		// device (kiosk / logout→login SPA) can never seed from this user's last
		// position. The current instance's live coords (lastUserCoords /
		// lastReliableCoords) survive a rebuild; only the cross-instance seed is
		// cleared here. A fresh fix re-populates it via handleGpsFix.
		sharedLastFix = null;
	}

	// Shared handler for real geolocation fixes AND the mock fix. Drives
	// lastUserCoords, lastReliableCoords, the world projection, and gpsSettled.
	function handleGpsFix(coords: { latitude: number; longitude: number }, accuracy: number): void {
		gpsSettled = true;
		// Always update lastUserCoords so isAtVenue / the away chip work
		// regardless of accuracy. The accuracy gate below only governs
		// dot placement and route-start, not the venue in/out decision.
		//
		// `gpsAccuracyThresholdM` derives from the reactive `gps` option — this
		// handler re-reads it on EVERY fix, so a host changing the option after
		// mount takes effect on the next fix; the watch does not need to be
		// torn down and recreated.
		// Guard finiteness first: a null/NaN accuracy would coerce (null<=N
		// is 0<=N) and falsely pass the gate. Treat a non-finite accuracy as
		// UNreliable so it can't place the dot / anchor a GPS-origin route.
		const acc = accuracy;
		const reliable = Number.isFinite(acc) && acc <= untrack(() => gpsAccuracyThresholdM);
		lastUserCoords = coords;
		sharedLastFix = { coords, venueId: untrack(() => provider.venueId ?? null), reliable };
		// Project the world coord / move the dot ONLY for a reliable fix,
		// so the dot freezes at the last reliable position on a noisy one.
		const hadWorld = untrack(() => userWorld) != null;
		if (reliable) {
			lastReliableCoords = coords;
			// NavigationKit veer events only fire off the NATIVE user-location
			// move, so when a route is active push the fix via setNativeUserLocation
			// even if useNativeUserDot is off (lets the veer-watch effect fire).
			const routeActive = (untrack(() => itinerary)?.length ?? 0) > 0;
			if (mm) {
				// Keep userWorld as the RAW fix (drives the away chip + the
				// route-start away test). Only the DISPLAYED dot snaps to the
				// entrance when away, so the dot sits where the path starts.
				userWorld = mm.updateUserPosition(coords);
				if (untrack(() => useNativeUserDot) || routeActive) mm.setNativeUserLocation(displayUserWorld(mm, userWorld));
			}
		}
		// Recompute the overlay on EVERY fix and regardless of map
		// readiness: the away/distance chip is pure lat/lng, so it must
		// track noisy fixes and show before JMap loads. The dot ('on')
		// reads `world`, only updated above for reliable fixes.
		refreshUserOverlay();
		const haveWorld = untrack(() => userWorld) != null;
		if (!hadWorld && haveWorld) {
			gpsOriginVersion++;
		}
	}

	// Live GPS dot — opt-in via the `gps` option. Runs immediately on mount,
	// independent of JMap load. Requires HTTPS in non-localhost contexts;
	// silently no-ops otherwise.
	$effect(() => {
		// Without GPS (or a geolocation API), mark GPS settled so the
		// itinerary effect draws the kiosk/centre route immediately instead of
		// waiting out the settle window.
		if (!gpsEnabled) {
			gpsSettled = true;
			return;
		}
		// Fixed fake fix for desktop testing: feed one synthetic reading
		// through the same path as a real fix. Accuracy defaults to 5 m so the
		// mock passes any sane threshold.
		if (gpsMock) {
			const mock = gpsMock;
			const mockTimer = setTimeout(() => {
				handleGpsFix({ latitude: mock.lat, longitude: mock.lng }, mock.accuracy ?? 5);
			}, 0);
			return () => clearTimeout(mockTimer);
		}
		if (typeof navigator === 'undefined' || !navigator.geolocation) {
			gpsSettled = true;
			return;
		}
		if (untrack(() => geolocationWatchId) != null) return;

		const settleTimer = setTimeout(() => { gpsSettled = true; }, GPS_SETTLE_TIMEOUT_MS);

		geolocationWatchId = navigator.geolocation.watchPosition(
			(pos) => {
				clearTimeout(settleTimer);
				handleGpsFix(
					{ latitude: pos.coords.latitude, longitude: pos.coords.longitude },
					pos.coords.accuracy,
				);
			},
			(err) => {
				clearTimeout(settleTimer);
				gpsSettled = true;
				logger?.debug?.('[map-sdk] geolocation watch error', err.code, err.message);
				// Widen the error channel to runtime: WebView shells need the
				// denial/timeout signal (their native layer decides whether to
				// prompt for location). cause.code is the GeolocationPositionError
				// code (1=denied, 2=unavailable, 3=timeout).
				emit('error', { message: err.message || 'geolocation watch error', cause: { code: err.code } });
			},
			{
				enableHighAccuracy: true,
				maximumAge: 5_000,
				timeout: 10_000,
			},
		);

		return () => {
			clearTimeout(settleTimer);
			if (geolocationWatchId != null && navigator.geolocation) {
				navigator.geolocation.clearWatch(geolocationWatchId);
				geolocationWatchId = null;
			}
		};
	});

	// OOTB auto-reroute (NavigationKit): on each native user-location move, if the
	// user has veered off the drawn route, bump gpsOriginVersion → the itinerary
	// effect redraws from the new position. No movement-distance fallback.
	$effect(() => {
		void instanceVersion; // re-subscribe when an instance (re)mounts
		const inst = mm;
		if (!inst) return;
		const unsub = inst.subscribeUserLocationSettled(() => {
			if (inst.hasUserVeeredOffRoute(VEER_THRESHOLD_MM)) {
				untrack(() => { gpsOriginVersion++; });
			}
		});
		return unsub;
	});

	onDestroy(() => {
		// Defensive clearWatch in case the component unmounts before the
		// effect's cleanup registers.
		if (geolocationWatchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
			navigator.geolocation.clearWatch(geolocationWatchId);
			geolocationWatchId = null;
		}
		tearDown();
	});

	// Itinerary presentation options. The public contract (types.ts) also
	// declares `style` and `pathType`, but both are documented-inert in v1
	// (no engine style-preset support; pathType is a no-op in jmap.js v4), so
	// neither is threaded to the engine's drawItinerary.
	const itineraryStartFromMapCenter = $derived(itineraryOptions?.startFromMapCenter ?? false);
	const itineraryShowStopNumbers = $derived(itineraryOptions?.showStopNumbers);

	// Stable signature so the wayfinding effect only fires when itinerary
	// content or render-affecting opts change — not on every parent re-render
	// (which produces a new array reference even when contents are identical).
	// Tracks selectedMapId too because JMap only paints segments belonging to
	// the currently-shown floor; switching floors needs a redraw so the route
	// reappears. startFromMapCenter is in the signature because the synthetic
	// start is anchored to whichever floor is showing, so toggling it (or
	// switching floors) must redraw with a fresh centre waypoint.
	// `itineraryOptions.style`/`pathType` are deliberately NOT in the
	// signature: they are v1 no-ops (see above), so toggling them must not
	// trigger a redraw that renders identically. Re-add when they get wired.
	const itinerarySig = $derived(
		JSON.stringify(itinerary ?? [])
		+ '|' + (selectedMapId ?? '')
		+ '|' + (itineraryStartFromMapCenter ? '1' : '0')
		+ '|' + (itineraryShowStopNumbers ?? 'auto'),
	);

	// Wire itinerary prop → MinimapInstance.drawItinerary. Runs after load
	// completes so the JMap controller and waypoint cache exist. With
	// startFromMapCenter the minimum interesting length is 1 (centre → dest);
	// otherwise length<2 is a clear.
	$effect(() => {
		void itinerarySig;
		void instanceVersion;
		// Redraw the route when GPS resolves AND each time the user veers off
		// the drawn route (see gpsOriginVersion) so the path dynamically
		// re-anchors to the user's current position as they walk.
		void gpsOriginVersion;
		// Defer the first draw until GPS has settled (fix or timeout) so we
		// don't paint a kiosk route that then races a GPS redraw. Once settled
		// stays settled, so later itinerary changes redraw immediately.
		void gpsSettled;
		if (!untrack(() => gpsSettled)) return;
		const stops = untrack(() => (itinerary ?? []).slice());
		const startFromMapCenter = untrack(() => itineraryStartFromMapCenter);
		const showStopNumbers = untrack(() => itineraryShowStopNumbers);
		const minStops = startFromMapCenter ? 1 : 2;
		const inst = mm;
		if (!inst) return;
		if (stops.length < minStops) {
			// Genuine clear (route removed) → reset framing so a later redraw of
			// the same stops re-frames instead of keeping the prior zoom.
			try { inst.clearItinerary(true); } catch { /* best-effort */ }
			// Clear only the route's synthetic-start marker. The user overlay
			// (live dot / away chip) is independent of the route and stays.
			syntheticStart = null;
			startPos = null;
			return;
		}
		// GPS-origin routing (synthetic-start feature) only applies when the
		// caller set `startFromMapCenter`; otherwise the contract is a plain
		// consecutive-stop route and minStops enforces ≥2 stops. With a fix,
		// pass it as startCoordinate; with none, fall back to kiosk/centre
		// (the drawn:0 fallback below covers an unroutable snapped waypoint).
		const uw = untrack(() => userWorld);
		// Only anchor from the GPS fix if it's projected onto the floor being
		// drawn. A floor switch re-runs this effect (selectedMapId is in
		// itinerarySig) BEFORE the async setFloor+reprojectUserWorld updates
		// userWorld, so userWorld can briefly carry the PREVIOUS floor's mapId.
		// Anchoring from it then would start the route on the wrong floor;
		// instead fall back to kiosk/centre until reproject re-runs this effect
		// with userWorld on the selected floor. (Floor-settle race, SDK #21.)
		const userWorldOnSelectedFloor =
			uw != null && uw.mapId === untrack(() => selectedMapId);
		// Away from venue → start at the venue-edge entry (awayStartWorld), not
		// the distant GPS point. At venue (on floor) → start where they stand.
		let startCoordinate: { mapId: number; x: number; y: number } | undefined;
		if (startFromMapCenter && userWorldOnSelectedFloor) {
			const origin = isUserAway(inst, uw)
				? awayStartWorld(inst, uw)
				: uw;
			startCoordinate = { mapId: origin.mapId, x: origin.worldX, y: origin.worldY };
		}
		try {
			let result = inst.drawItinerary(stops, {
				startFromMapCenter,
				startCoordinate,
				showStopNumbers,
			});
			// Fall back to the kiosk/centre start (drop startCoordinate so the
			// startFromMapCenter tiers run) in two cases:
			//   1. drawn === 0 — start snapped to an unroutable waypoint
			//      (parking/courtyard, or a floor that can't path) → no line.
			//   2. start was requested but DIDN'T take: tier-1 has no
			//      fall-through, so a failed startCoordinate snap leaves
			//      syntheticStart null. With ≥2 destinations the inter-stop
			//      legs still draw (drawn > 0), so case 1 misses it and the
			//      route would silently lose its start leg.
			// Only meaningful when startFromMapCenter is set — that's the only
			// path that runs the kiosk/centre tiers; otherwise a plain
			// destination route is the intended (and only) fallback.
			// NOTE (by design): for an AWAY user whose clamped venue-edge start
			// is itself unroutable (rare — a disconnected edge waypoint), this
			// degrades to the kiosk/floor-centre start, NOT back to the far GPS
			// point. Both are INTERIOR, so the long-outdoor-leg bug can't recur;
			// we simply lose the perimeter-edge origin in that edge case. Trying
			// a different edge waypoint isn't worth the candidate-iteration
			// complexity — kiosk/centre is a valid, always-routable interior start.
			const gpsStartDropped =
				startCoordinate != null && startFromMapCenter && !result.syntheticStart;
			if (startCoordinate && (result.drawn === 0 || gpsStartDropped)) {
				result = inst.drawItinerary(stops, {
					startFromMapCenter,
					showStopNumbers,
				});
			}
			const synth = result?.syntheticStart ?? null;
			syntheticStart = synth;
			startPos = projectStart(inst, synth);
			// Surface a route that was requested (stops.length >= minStops above)
			// but painted nothing — every leg missing / unroutable. Previously
			// this failed silently. untrack: emit runs host callbacks and this is
			// inside an effect. (drawn === 0 after the kiosk/centre fallback.)
			if (result.drawn === 0) {
				untrack(() => emit('error', {
					message: 'itinerary draw produced no route',
					cause: { stage: 'drawItinerary', drawn: result.drawn, missing: result.missing },
				}));
			}
		} catch (e) {
			// drawItinerary may internally call clearItinerary() before
			// throwing, leaving the canvas cleared. Reset the overlay to
			// avoid an orphaned "you are here" dot with no route.
			syntheticStart = null;
			startPos = null;
			untrack(() => emit('error', {
				message: e instanceof Error ? e.message : String(e),
				cause: e,
			}));
		}
	});

	const showFloorChips = $derived(!isOmx && floorSelector && floors.length > 1);

	// Route active → native dot drives the auto-reroute move event; suppress the
	// HTML overlay dot so it's not doubled (useNativeUserDot's compare-double stays).
	const routeForcesNativeDot = $derived(!useNativeUserDot && (itinerary?.length ?? 0) > 0);

	// Falling edge of routeForcesNativeDot (route cleared while useNativeUserDot is
	// off): the HTML overlay dot returns, so clear the native dot — otherwise both
	// render, often at different spots after away-mode snapping. Only clears the
	// route-driven native dot; when useNativeUserDot is set the native dot is the
	// host's intended marker and is left alone.
	let prevRouteForcesNativeDot = false;
	$effect(() => {
		const forces = routeForcesNativeDot;
		untrack(() => {
			if (prevRouteForcesNativeDot && !forces) {
				mm?.setNativeUserLocation(null);
			}
			prevRouteForcesNativeDot = forces;
		});
	});

	function pickFloor(mapId: number) {
		selectedMapId = mapId;
	}

	// ── OMX: availability fills, rotation, map controls, floor picker ─────

	// Fills repaint in place whenever a resource's `availability` changes (it
	// is outside the rebuild signature) and after every (re)build.
	const availabilitySig = $derived(
		venueResources
			.map(r => (r.availability && r.externalId != null ? `${r.externalId}:${r.availability}` : ''))
			.filter(Boolean)
			.join(','),
	);
	// Fill colours: --map-available / --map-busy / --map-disabled /
	// --map-excluded, from `theme` or inherited from the host's CSS, as hex.
	function availabilityColors(): Partial<Record<AvailabilityState, string>> {
		const out: Partial<Record<AvailabilityState, string>> = {};
		if (!rootEl || typeof getComputedStyle !== 'function') return out;
		const cs = getComputedStyle(rootEl);
		for (const k of ['available', 'busy', 'disabled', 'excluded'] as const) {
			const v = cs.getPropertyValue(`--map-${k}`).trim();
			if (v) out[k] = v;
		}
		return out;
	}
	$effect(() => {
		void availabilitySig;
		void themeTokens;
		if (load !== 'ready') return;
		untrack(() => {
			if (!mm) return;
			const byExt = new Map<string, AvailabilityState>();
			for (const r of venueResources) {
				if (r.externalId != null && r.availability) byExt.set(String(r.externalId), r.availability);
			}
			mm.setAvailability(byExt, availabilityColors());
		});
	});

	// Rotation follows the building's CMS rotation (or north-up via the
	// compass). The engine starts rotated; this covers later changes.
	const effectiveRotation = $derived(northUp ? null : configuredRotation);
	$effect(() => {
		const rot = effectiveRotation;
		if (load !== 'ready') return;
		untrack(() => mm?.setRotation(rot));
	});
	const showNorthIcon = $derived(!configuredRotation || northUp);
	// cx_map onMapCompass: no CMS rotation → back to north + fit; otherwise
	// toggle north-up ⇄ the CMS rotation (the rotation change re-fits).
	function onCompass(): void {
		if (!configuredRotation) {
			mm?.frameFloor();
			return;
		}
		northUp = !northUp;
	}

	// Building/floor pill + selector (cx_map WPTopBar + BuildingsAndFloorsModal).
	let floorPickerOpen = $state(false);
	let floorPillEl: HTMLButtonElement | undefined = $state();
	let floorPickerEl: HTMLDivElement | undefined = $state();
	const currentFloorInfo = $derived(floors.find(f => f.mapId === selectedMapId) ?? null);
	const floorPillLabel = $derived.by(() => {
		const floorText = currentFloorInfo
			? (currentFloorInfo.shortName || floorLabel(currentFloorInfo))
			: '';
		const buildingText = activeBuilding?.name ?? '';
		return [buildingText, floorText].filter(Boolean).join(', ');
	});
	const showFloorPill = $derived(isOmx && floorSelector && (floors.length > 0 || multiBuilding));
	function openFloorPicker(): void {
		floorPickerOpen = true;
		void tick().then(() => {
			const target = floorPickerEl?.querySelector<HTMLElement>('[data-autofocus]') ?? floorPickerEl;
			target?.focus();
		});
	}
	function closeFloorPicker(): void {
		floorPickerOpen = false;
		void tick().then(() => floorPillEl?.focus());
	}
	function chooseFloor(mapId: number): void {
		pickFloor(mapId);
		closeFloorPicker();
	}
	function chooseBuilding(venueId: number): void {
		// The modal stays open: the new building's floors list once it loads.
		setBuilding(venueId);
	}
	// Esc closes; Tab stays inside the dialog.
	function onFloorPickerKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			closeFloorPicker();
			return;
		}
		if (e.key !== 'Tab' || !floorPickerEl) return;
		const focusable = Array.from(floorPickerEl.querySelectorAll<HTMLElement>('button:not([disabled])'));
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
	}
</script>

<div bind:this={rootEl} class="rm-modal-card" class:rm-omx={isOmx}>
	<div class="rm-modal-canvas-wrap">
		<div bind:this={container} class="rm-canvas"></div>
		{#if load === 'ready' && !switchingFloor}
			{@render pinList(positions)}
			{@render routeStartMarker(startPos)}
			{@render youAreHereMarker(gpsEnabled && !routeForcesNativeDot ? onMapPos(userOverlay) : null)}
			{#if colleaguesEnabled}
				{@render colleagueAvatars(colleaguePositions)}
			{/if}
			{#if colleagues}
				<button
					type="button"
					class="rm-colleagues-toggle"
					class:rm-colleagues-toggle-active={colleaguesEnabled}
					aria-pressed={colleaguesEnabled}
					onclick={toggleColleagues}
					disabled={colleaguesLoading}
				>
					{#if colleaguesLoading}
						<span class="rm-colleagues-spinner" aria-hidden="true"></span>
					{:else}
						<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
							<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
							<circle cx="9" cy="7" r="4"/>
							<path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
							<path d="M16 3.13a4 4 0 0 1 0 7.75"/>
						</svg>
					{/if}
					<span>{colleaguesEnabled ? t.hideColleagues : t.showColleagues}</span>
				</button>
				{#if colleaguesError}
					<div class="rm-colleagues-status" role="status">{colleaguesError}</div>
				{/if}
			{/if}
			{#if unresolved > 0}
				<div class="rm-unresolved" aria-live="polite">{unresolved} {t.notShownOnMap}</div>
			{/if}
		{:else if load === 'error'}
			<div class="rm-loading-overlay rm-modal-error">
				<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
				</svg>
				<span class="rm-loading-text">{loadError ?? t.mapFailedToLoad}</span>
			</div>
		{:else}
			<div class="rm-loading-overlay" aria-live="polite">
				<div class="rm-spinner"></div>
				<span class="rm-loading-text">{t.loadingMap}</span>
			</div>
		{/if}
		<!-- Away chip rendered outside the ready-gate on purpose — REVIEWED #5.
		     gps:false hides it entirely (no location rendered without consent). -->
		{@render userOffMapIndicator(gpsEnabled ? userOverlay : null)}
		{#if cardsOn && load === 'ready' && resources.length > 0}
			{@render resourceCarousel()}
		{/if}
		{#if load === 'ready' && controlsOn}
			{@render mapControlButtons()}
		{/if}
		{#if showFloorPill}
			{@render floorPill()}
		{/if}
		{#if floorPickerOpen && showFloorPill}
			{@render floorPicker()}
		{/if}
	</div>
	{#if showFloorChips}
		{@render floorStrip()}
	{/if}
</div>

{#snippet youAreHereMarker(pos: { x: number; y: number } | null)}
	{#if pos}
		<div
			class="rm-here"
			style="transform: translate3d({pos.x}px, {pos.y}px, 0) translate(-50%, -50%);"
			aria-label={t.youAreHere}
			role="img"
		>
			<span class="rm-here-halo"></span>
			<span class="rm-here-dot"></span>
		</div>
	{/if}
{/snippet}

{#snippet routeStartMarker(pos: { x: number; y: number } | null)}
	{#if pos}
		<div
			class="rm-start"
			style="transform: translate3d({pos.x}px, {pos.y}px, 0) translate(-50%, -50%);"
			aria-label={t.routeStart}
			role="img"
		></div>
	{/if}
{/snippet}

{#snippet userOffMapIndicator(overlay: UserOverlay | null)}
	<!-- Sole away cue, not route-gated — REVIEWED #2 on resolveUserOverlay. -->
	{#if overlay?.kind === 'off' && overlay.label}
		<div class="rm-user-faraway" role="img" aria-label={t.userFarawayLabel.replace('{d}', overlay.label)}>
			<span class="rm-user-faraway-label">{overlay.label}</span>
		</div>
	{/if}
{/snippet}

{#snippet pinList(items: Array<{ pin: PinInfo; x: number; y: number } | null>)}
	{#each items as item}
		{@const selected = !!item && !!selectedPin && item.pin === selectedPin}
		{@const added = !!item && !!live(item.pin).added}
		{#if item && isOmx && (pinsMode === 'all' || selected || added)}
			<!-- The parent app's pin (cx_map assets/location_on.svg, 40×40, box
			     bottom-centre on the point, like its addComponent pins). Not
			     interactive: a tap goes through to the space underneath, which
			     tap-select resolves — exactly as in the parent app. Navy with a
			     white dot = selected; brand blue with a white check = on the
			     host's list (added); navy with a check = both. -->
			<div
				class="rm-omx-pin"
				class:rm-omx-pin-selected={selected}
				class:rm-omx-pin-added={added}
				style="transform: translate3d({item.x}px, {item.y}px, 0) translate(-20px, -40px);"
				aria-hidden="true"
			>
				<svg viewBox="0 0 40 40" width="40" height="40">
					<path fill="currentColor" d="M19.9999 35.8492C15.8055 32.2147 12.6602 28.8324 10.5641 25.7021C8.46798 22.5715 7.41992 19.6975 7.41992 17.08C7.41992 13.2339 8.66395 10.1201 11.152 7.73875C13.6403 5.35737 16.5896 4.16667 19.9999 4.16667C23.4102 4.16667 26.3595 5.35737 28.8478 7.73875C31.3359 10.1201 32.5799 13.2339 32.5799 17.08C32.5799 19.6975 31.5319 22.5715 29.4358 25.7021C27.3396 28.8324 24.1944 32.2147 19.9999 35.8492Z"/>
					{#if added}
						<path d="M15.2 17.3l3.2 3.2 6.4-6.6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
					{:else}
						<circle cx="20" cy="17" r="5" fill="#fff"/>
					{/if}
				</svg>
			</div>
		{:else if item && !isOmx && (pinsMode === 'all' || selected || added)}
			{@const isDest = routeActive && destIds.has(String(item.pin.resource.externalId ?? ''))}
			<button
				type="button"
				class="rm-pin"
				class:rm-pin-selected={!!selectedPin && item.pin === selectedPin}
				class:rm-pin-dest={isDest}
				style="transform: translate3d({item.x}px, {item.y}px, 0) translate(-50%, -100%);"
				aria-label={isDest ? `${t.destinationPrefix} ${item.pin.resource.name ?? ''}` : `${t.pinPrefix} ${item.pin.resource.name ?? ''}`}
				onclick={() => clickPin(item.pin)}
			>
				<!-- Brand-blue teardrop location pin for every tenant (directory +
				     wayfinding share one pin shape). currentColor ← --map-primary;
				     the route destination (rm-pin-dest) renders a touch larger. -->
				<svg class="rm-pin-teardrop-icon" viewBox="0 0 24 30" width="22" height="28" aria-hidden="true">
					<path d="M12 1C6 1 1.5 5.5 1.5 11.3 1.5 19 12 29 12 29s10.5-10 10.5-17.7C22.5 5.5 18 1 12 1Z"
						fill="currentColor" stroke="#fff" stroke-width="2"/>
					<circle cx="12" cy="11" r="3.4" fill="#fff"/>
				</svg>
			</button>
		{/if}
	{/each}
{/snippet}

{#snippet colleagueAvatars(items: Array<{ marker: ColleagueMarker; x: number; y: number } | null>)}
	{#each items as item}
		{#if item}
			{@const key = colleagueKey(item.marker.booking)}
			{@const photo = avatarImages[key]}
			{@const name = colleagueName(item.marker.booking)}
			<div
				class="rm-avatar"
				style="transform: translate3d({item.x}px, {item.y}px, 0) translate(-50%, -50%);"
				title={name}
				aria-label={name}
			>
				{#if photo?.url}
					<img class="rm-avatar-img" src={photo.url} alt={name} />
				{:else}
					<div class="rm-avatar-fallback" style="background-color: {colorForName(name)};">
						{initials(item.marker.booking.name)}
					</div>
				{/if}
			</div>
		{/if}
	{/each}
{/snippet}

{#snippet floorStrip()}
	<div class="rm-floor-select">
		{#each floors as f (f.mapId)}
			<button
				type="button"
				class="rm-floor-tab"
				class:rm-floor-tab-active={f.mapId === selectedMapId}
				onclick={() => pickFloor(f.mapId)}
				aria-pressed={f.mapId === selectedMapId}
			>
				{floorLabel(f)}
			</button>
		{/each}
	</div>
{/snippet}

<!-- cx_map Spaces.vue zoom stack + compass (bottom-right). -->
{#snippet mapControlButtons()}
	<button type="button" class="rm-omx-compass" aria-label={t.compass} onclick={onCompass}>
		{#if showNorthIcon}
			<svg viewBox="0 0 27 27" width="27" height="27" fill="none" aria-hidden="true">
				<path fill="currentColor" d="M17.5882 20.6934L17.428 10.9879L9.10292 5.99647L9.26307 15.702L17.5882 20.6934ZM15.2774 13.8626C15.1336 14.3992 14.8236 14.805 14.3473 15.08C13.871 15.355 13.3645 15.4206 12.8279 15.2768C12.2913 15.133 11.8855 14.823 11.6105 14.3467C11.3355 13.8704 11.2699 13.3639 11.4137 12.8273C11.5575 12.2907 11.8675 11.8849 12.3438 11.6099C12.8201 11.3349 13.3266 11.2693 13.8632 11.4131C14.3998 11.5569 14.8056 11.8669 15.0806 12.3432C15.3556 12.8195 15.4212 13.3259 15.2774 13.8626ZM26.2246 16.7959C25.7472 18.5775 24.9605 20.1611 23.8645 21.5469C22.7685 22.9327 21.4856 24.0498 20.0159 24.8984C18.5462 25.7469 16.9373 26.2993 15.1892 26.5556C13.4411 26.8119 11.6762 26.7013 9.89463 26.2239C8.11304 25.7466 6.52935 24.9599 5.14358 23.8639C3.75781 22.7679 2.64066 21.485 1.79213 20.0153C0.943602 18.5456 0.391195 16.9367 0.134909 15.1886C-0.121377 13.4405 -0.0108317 11.6756 0.466546 9.89402C0.943923 8.11242 1.73062 6.52873 2.82663 5.14296C3.92264 3.75719 5.20549 2.64004 6.67518 1.79151C8.14488 0.94298 9.75378 0.390576 11.5019 0.134289C13.25 -0.121996 15.0149 -0.0114504 16.7965 0.465927C18.5781 0.943305 20.1618 1.73 21.5475 2.82601C22.9333 3.92202 24.0505 5.20487 24.899 6.67456C25.7475 8.14426 26.2999 9.75316 26.5562 11.5013C26.8125 13.2494 26.7019 15.0143 26.2246 16.7959ZM23.6488 16.1057C24.4137 13.2508 24.0616 10.551 22.5924 8.00628C21.1232 5.46153 18.9611 3.80668 16.1063 3.04173C13.2514 2.27677 10.5516 2.6289 8.0069 4.09811C5.46215 5.56732 3.8073 7.72935 3.04235 10.5842C2.27739 13.439 2.62952 16.1388 4.09873 18.6836C5.56794 21.2283 7.72997 22.8832 10.5848 23.6481C13.4397 24.4131 16.1395 24.061 18.6842 22.5918C21.229 21.1225 22.8838 18.9605 23.6488 16.1057Z"/>
			</svg>
		{:else}
			<svg viewBox="0 0 27 27" width="27" height="27" fill="none" aria-hidden="true">
				<path fill="currentColor" d="M7.33333 19.3333L16.6667 16.6667L19.3333 7.33333L10 10L7.33333 19.3333ZM13.3333 15.3333C12.7778 15.3333 12.3056 15.1389 11.9167 14.75C11.5278 14.3611 11.3333 13.8889 11.3333 13.3333C11.3333 12.7778 11.5278 12.3056 11.9167 11.9167C12.3056 11.5278 12.7778 11.3333 13.3333 11.3333C13.8889 11.3333 14.3611 11.5278 14.75 11.9167C15.1389 12.3056 15.3333 12.7778 15.3333 13.3333C15.3333 13.8889 15.1389 14.3611 14.75 14.75C14.3611 15.1389 13.8889 15.3333 13.3333 15.3333ZM13.3333 26.6667C11.4889 26.6667 9.75556 26.3167 8.13333 25.6167C6.51111 24.9167 5.1 23.9667 3.9 22.7667C2.7 21.5667 1.75 20.1556 1.05 18.5333C0.35 16.9111 0 15.1778 0 13.3333C0 11.4889 0.35 9.75556 1.05 8.13333C1.75 6.51111 2.7 5.1 3.9 3.9C5.1 2.7 6.51111 1.75 8.13333 1.05C9.75556 0.35 11.4889 0 13.3333 0C15.1778 0 16.9111 0.35 18.5333 1.05C20.1556 1.75 21.5667 2.7 22.7667 3.9C23.9667 5.1 24.9167 6.51111 25.6167 8.13333C26.3167 9.75556 26.6667 11.4889 26.6667 13.3333C26.6667 15.1778 26.3167 16.9111 25.6167 18.5333C24.9167 20.1556 23.9667 21.5667 22.7667 22.7667C21.5667 23.9667 20.1556 24.9167 18.5333 25.6167C16.9111 26.3167 15.1778 26.6667 13.3333 26.6667ZM13.3333 24C16.2889 24 18.8056 22.9611 20.8833 20.8833C22.9611 18.8056 24 16.2889 24 13.3333C24 10.3778 22.9611 7.86111 20.8833 5.78333C18.8056 3.70556 16.2889 2.66667 13.3333 2.66667C10.3778 2.66667 7.86111 3.70556 5.78333 5.78333C3.70556 7.86111 2.66667 10.3778 2.66667 13.3333C2.66667 16.2889 3.70556 18.8056 5.78333 20.8833C7.86111 22.9611 10.3778 24 13.3333 24Z"/>
			</svg>
		{/if}
	</button>
	<div class="rm-omx-zoom">
		<button type="button" aria-label={t.zoomIn} onclick={() => mm?.zoomBy(0.2)}>
			<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z"/></svg>
		</button>
		<span class="rm-omx-zoom-divider" aria-hidden="true"></span>
		<button type="button" aria-label={t.zoomOut} onclick={() => mm?.zoomBy(-0.2)}>
			<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19,13H5V11H19V13Z"/></svg>
		</button>
	</div>
{/snippet}

<!-- cx_map WPTopBar's combined building + floor pill (mdi-domain, label,
     chevron). Opens the selector. -->
{#snippet floorPill()}
	<button
		bind:this={floorPillEl}
		type="button"
		class="rm-omx-floor-pill"
		aria-haspopup="dialog"
		aria-expanded={floorPickerOpen}
		aria-label={`${t.buildingsAndFloors}: ${floorPillLabel}`}
		onclick={openFloorPicker}
	>
		<svg class="rm-omx-floor-pill-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
			<path fill="currentColor" d="M18,15H16V17H18M18,11H16V13H18M20,19H12V17H14V15H12V13H14V11H12V9H20M10,7H8V5H10M10,11H8V9H10M10,15H8V13H10M10,19H8V17H10M6,7H4V5H6M6,11H4V9H6M6,15H4V13H6M6,19H4V17H6M12,7V3H2V21H22V7H12Z"/>
		</svg>
		<span class="rm-omx-floor-pill-label">{floorPillLabel || t.buildingsAndFloors}</span>
		<svg class="rm-omx-floor-pill-chevron" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
			<path fill="currentColor" d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
		</svg>
	</button>
{/snippet}

<!-- cx_map BuildingsAndFloorsModal (browse mode): building chips, then the
     building's floors in Jibestream's order. Scoped to the map, not the page. -->
{#snippet floorPicker()}
	<div
		class="rm-omx-picker-backdrop"
		role="presentation"
		onclick={(e) => { if (e.target === e.currentTarget) closeFloorPicker(); }}
	>
		<div
			bind:this={floorPickerEl}
			class="rm-omx-picker"
			role="dialog"
			aria-modal="true"
			aria-labelledby="rm-omx-picker-title"
			tabindex="-1"
			onkeydown={onFloorPickerKeydown}
		>
			<div class="rm-omx-picker-head">
				<h2 id="rm-omx-picker-title" class="rm-omx-picker-title">{t.buildingsAndFloors}</h2>
				<button type="button" class="rm-omx-picker-close" aria-label={t.close} data-autofocus onclick={closeFloorPicker}>
					<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
						<path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
					</svg>
				</button>
			</div>
			<!-- Always rendered, like cx_map: one chip for a single building
			     (its venue name when the host passes no `buildings`). -->
			<div class="rm-omx-picker-buildings" role="group" aria-label={t.buildings}>
				{#if multiBuilding}
					{#each buildings ?? [] as b (b.venueId)}
						{@const active = Number(b.venueId) === Number(activeVenueId)}
						<button
							type="button"
							class="rm-omx-picker-building"
							class:rm-omx-picker-building-active={active}
							aria-pressed={active}
							onclick={() => chooseBuilding(b.venueId)}
						>{b.name}</button>
					{/each}
				{:else if venueName}
					<button type="button" class="rm-omx-picker-building rm-omx-picker-building-active" aria-pressed="true">{venueName}</button>
				{/if}
			</div>
			<div class="rm-omx-picker-floors" role="group" aria-label={t.floors}>
				{#if load !== 'ready'}
					<div class="rm-omx-picker-loading" aria-live="polite">
						<div class="rm-spinner"></div>
					</div>
				{:else}
					{#each floors as f (f.mapId)}
						{@const active = f.mapId === selectedMapId}
						<button
							type="button"
							class="rm-omx-picker-floor"
							class:rm-omx-picker-floor-active={active}
							aria-pressed={active}
							onclick={() => chooseFloor(f.mapId)}
						>
							{#if f.shortName}
								<span class="rm-omx-picker-floor-short">{f.shortName}</span>
							{/if}
							<span class="rm-omx-picker-floor-name">{floorLabel(f)}</span>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/snippet}

{#snippet resourceCarousel()}
	{@const single = resources.length <= 1}
	<div
		class="rm-carousel {single ? 'rm-carousel-single' : ''}"
		class:rm-carousel-dragging={isDragging}
		role="group"
		aria-label={t.suggestedSpaces}
		onclickcapture={onCarouselClick}
		onscroll={(e) => {
			if (single) return;
			onCarouselScroll(e.currentTarget as HTMLDivElement);
		}}
		onpointerdown={(e) => {
			if (single) return;
			onCarouselPointerDown(e, e.currentTarget as HTMLDivElement);
		}}
		onpointermove={onCarouselPointerMove}
		onpointerup={onCarouselPointerEnd}
		onpointercancel={onCarouselPointerEnd}
	>
		{#each resources as r, i (carouselKey(r, i))}
			{@const key = carouselKey(r, i)}
			{@const thumb = thumbs[key]}
			{@const isSelected = !!selectedPin && String(selectedPin.resource.externalId ?? '') === String(r.externalId ?? '')}
			{@const canBook = canBookCarousel(r)}
			{@const isBookingCard = bookingCardExternalId != null
				? (r.externalId != null && String(r.externalId) === bookingCardExternalId)
				: (bookingCardName != null && (r.name ?? '') === bookingCardName)}
			<div
				class="rm-carousel-card"
				class:rm-carousel-card-active={isSelected} class:rm-carousel-card-nothumb={!bookable}
				bind:this={
					() => cardRefs[i],
					(el) => {
						cardRefs[i] = el;
					}
				}
				data-index={i}
				role="button"
				tabindex="0"
				onclick={() => selectByExternalId(r.externalId, { scroll: true })}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						selectByExternalId(r.externalId, { scroll: true });
					}
				}}
			>
				{#if bookable}
					<div class="rm-carousel-thumb">
						{#if thumb?.url}
							<img src={thumb.url} alt={r.name ?? ''} loading="lazy" />
						{:else}
							<div class="rm-carousel-thumb-skel"></div>
						{/if}
					</div>
				{/if}
				<div class="rm-carousel-info">
					<div class="rm-carousel-head">
						<div class="rm-carousel-name">{r.name ?? '—'}</div>
						<div class="rm-carousel-actions">
							{#if canNavigate(r)}
								<button
									type="button"
									class="rm-carousel-nav"
									aria-label={t.navigate}
									onclick={(e) => { e.stopPropagation(); navigateToResource(r); }}
								>
									<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
										<polygon points="3 11 22 2 13 21 11 13 3 11"/>
									</svg>
									<span>{t.navigate}</span>
								</button>
							{/if}
							{#if isBookingCard && bookingState.status === 'success'}
								<span class="rm-carousel-status rm-carousel-success">{t.booked}</span>
							{:else if isBookingCard && bookingState.status === 'error'}
								<button type="button" class="rm-carousel-book" onclick={(e) => { e.stopPropagation(); bookCarouselCard(r); }}>
									{t.tryAgain}
								</button>
							{:else if canBook}
								<button
									type="button"
									class="rm-carousel-book"
									disabled={bookingState.status === 'pending'}
									onclick={(e) => { e.stopPropagation(); bookCarouselCard(r); }}
								>
									{isBookingCard && bookingState.status === 'pending' ? t.booking : t.book}
								</button>
							{/if}
						</div>
					</div>
					<div class="rm-carousel-meta">
						{#if r.floorName}<span>F {r.floorName}</span>{/if}
						{#if r.floorName && r.buildingName}<span class="rm-carousel-meta-sep">·</span>{/if}
						{#if r.buildingName}<span>{r.buildingName}</span>{/if}
					</div>
					<!-- Mall/directory tenants carry suite/address instead of a
					     floor label; keep them visible on the carousel card. -->
					{#if r.suite || r.address}
						<div class="rm-carousel-meta">
							<span>{r.suite ?? ''}{r.suite && r.address ? ' · ' : ''}{r.address ?? ''}</span>
						</div>
					{/if}
					{#if r.features?.length}
						<div class="rm-carousel-features">
							<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true" class="rm-carousel-sparkle">
								<path d="M12 2l1.7 4.6L18 8l-4.3 1.4L12 14l-1.7-4.6L6 8l4.3-1.4L12 2zm6 11l1 2.5L21.5 16 19 17l-1 2.5L17 17l-2.5-1L17 15l1-2zm-13.5.5l.8 2L7 16l-1.7.5-.8 2-.8-2L2 16l1.7-.5.8-2z"/>
							</svg>
							<span class="rm-carousel-feats-text">{r.features.slice(0, 3).join(', ')}</span>
						</div>
					{/if}
				</div>
			</div>
		{/each}
	</div>
{/snippet}

<style>
	.rm-canvas {
		position: absolute;
		inset: 0;
		/* Explicit size, not just inset-derived: createMinimap sets INLINE
		   `position: relative` on this element (JMap wants a positioned
		   container; the engine only checks the inline style, so it can't see
		   the class's `absolute`). The inline value overrides the class, and a
		   relative box gets no size from `inset` — so the SECOND mount into
		   this same div (rebuilds via handle.setResources / a venue swap)
		   measured 0-height and bailed with "Map container has no size".
		   width/height keep the div sized under either position value. */
		width: 100%;
		height: 100%;
	}
	/* "You are here" self-indicator overlay */
	.rm-here {
		position: absolute;
		/* left/top stay 0; per-frame position + centering are written to the
		   inline `transform` (translate3d + translate(-50%,-50%)) so a pan/zoom
		   frame never invalidates layout. */
		left: 0;
		top: 0;
		width: 16px;
		height: 16px;
		pointer-events: none;
		z-index: 20;
	}
	.rm-here-dot {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		background: #1d6ef5;
		border: 3px solid #fff;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
	}
	.rm-here-halo {
		position: absolute;
		inset: -6px;
		border-radius: 50%;
		background: rgba(29, 110, 245, 0.22);
		animation: rm-pulse 2s ease-out infinite;
	}
	@keyframes rm-pulse {
		0%   { transform: scale(1);   opacity: 0.7; }
		70%  { transform: scale(1.6); opacity: 0; }
		100% { transform: scale(1.6); opacity: 0; }
	}
	/* Route origin (kiosk / map centre) — a hollow ring, visually distinct
	   from the solid pulsing "you are here" GPS dot so both can show at once
	   (e.g. a GPS-origin route that fell back to the kiosk start). */
	.rm-start {
		position: absolute;
		/* left/top 0; position + centering via inline transform (layout-free). */
		left: 0;
		top: 0;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #fff;
		border: 4px solid #1d6ef5;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
		pointer-events: none;
		z-index: 19;
	}
	/* Distance chip shown when user is outside the venue boundary. */
	.rm-user-faraway {
		position: absolute;
		top: 8px;
		left: 50%;
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		padding: 3px 8px;
		border-radius: 999px;
		background: rgba(29, 110, 245, 0.92);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
		pointer-events: none;
		z-index: 22;
	}
	.rm-user-faraway-label {
		font-size: 10px;
		font-weight: 600;
		line-height: 1;
		color: #fff;
		white-space: nowrap;
	}
	.rm-unresolved {
		position: absolute;
		top: 8px;
		right: 8px;
		font-size: 11px;
		font-weight: 600;
		padding: 4px 8px;
		border-radius: 999px;
		background: rgba(0,0,0,0.55);
		color: #fff;
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		z-index: 3;
	}
	.rm-pin {
		position: absolute;
		/* left/top 0; position + centering (tip at point) via inline transform. */
		left: 0;
		top: 0;
		width: 36px;
		height: 36px;
		border: none;
		background: transparent;
		padding: 0;
		cursor: pointer;
		z-index: 5;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	/* Brand-blue teardrop location pin (all tenants). currentColor ← token. */
	.rm-pin-teardrop-icon {
		color: var(--map-primary, #0070F0);
		filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35));
		width: 28px;
		height: 36px;
	}
	/* Route destination renders a touch larger + above other pins. */
	.rm-pin-dest { z-index: 6; }
	.rm-pin-dest .rm-pin-teardrop-icon { width: 34px; height: 43px; }

	/* Colleague avatar overlay — layered above pins so they remain the
	   visually dominant marker for the currently-relevant resource. */
	.rm-avatar {
		position: absolute;
		/* left/top 0; position + centering via inline transform (layout-free). */
		left: 0;
		top: 0;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: #fff;
		box-shadow: 0 0 0 2px #fff, 0 2px 8px rgba(0,0,0,0.25);
		z-index: 6;
		overflow: hidden;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		pointer-events: auto;
	}
	.rm-avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.rm-avatar-fallback {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 11px;
		font-weight: 700;
		color: #fff;
		letter-spacing: 0.02em;
	}

	.rm-colleagues-toggle {
		position: absolute;
		left: 16px;
		/* Top-left, not bottom-left: the resource carousel spans the full width
		   along the bottom (z-index 30) and covers a bottom-left toggle in
		   multi-card mode. Top-left is clear (unresolved badge is top-right). */
		top: 16px;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 14px;
		border-radius: 999px;
		background: rgba(255,255,255,0.92);
		color: #0f172a;
		border: 1px solid rgba(15, 23, 42, 0.08);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		z-index: 8;
		box-shadow: 0 4px 16px rgba(0,0,0,0.18);
		backdrop-filter: blur(6px);
		-webkit-backdrop-filter: blur(6px);
		transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
	}
	.rm-colleagues-toggle:hover:not(:disabled) { background: #fff; }
	.rm-colleagues-toggle:active:not(:disabled) { transform: scale(0.98); }
	.rm-colleagues-toggle:disabled {
		opacity: 0.7;
		cursor: progress;
	}
	.rm-colleagues-toggle-active {
		background: var(--map-primary, #6366f1);
		color: #fff;
		border-color: var(--map-primary, #6366f1);
	}
	.rm-colleagues-toggle-active:hover:not(:disabled) {
		background: var(--map-primary, #6366f1);
		filter: brightness(1.05);
	}
	.rm-colleagues-spinner {
		display: inline-block;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid rgba(15, 23, 42, 0.18);
		border-top-color: var(--map-primary, #6366f1);
		animation: rm-spin 0.8s linear infinite;
	}
	.rm-colleagues-toggle-active .rm-colleagues-spinner {
		border-color: rgba(255,255,255,0.35);
		border-top-color: #fff;
	}
	.rm-colleagues-status {
		position: absolute;
		left: 16px;
		/* Sits just below the toggle (now top-left). */
		top: 60px;
		padding: 6px 12px;
		border-radius: 999px;
		background: rgba(15, 23, 42, 0.78);
		color: #fff;
		font-size: 12px;
		font-weight: 500;
		z-index: 8;
		backdrop-filter: blur(4px);
		-webkit-backdrop-filter: blur(4px);
		pointer-events: none;
	}

	/* Floor strip is a solid surface above the canvas — belt-and-suspenders so
	   nothing shows through beneath the buttons. */
	.rm-floor-select {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 8px 12px;
		border-top: 1px solid rgba(0,0,0,0.08);
		position: relative;
		z-index: 11;
		background: #fff;
	}
	.rm-floor-tab {
		flex: 1;
		min-height: 36px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 6px 12px;
		border-radius: 6px;
		background: transparent;
		border: 1px solid var(--map-border, rgba(0,0,0,0.1));
		font: inherit;
		font-size: 13px;
		font-weight: 500;
		color: var(--map-text-muted, #64748b);
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		touch-action: manipulation;
		transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
	}
	.rm-floor-tab:hover {
		background: var(--map-surface, rgba(0,0,0,0.04));
		color: var(--map-text, #0f172a);
	}
	.rm-floor-tab-active {
		background: var(--map-primary, #6366f1);
		border-color: var(--map-primary, #6366f1);
		color: #fff;
		font-weight: 600;
	}
	.rm-floor-tab:focus-visible {
		outline: 2px solid var(--map-primary, #6366f1);
		outline-offset: 2px;
	}

	.rm-loading-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		/* Opaque cover so the JMap canvas underneath is hidden while the
		   map renders + frames. Without this the previous semi-transparent
		   tint let users see the default-extent map flash before zoom. */
		background: var(--map-bg, #ffffff);
		color: var(--map-text-muted, #64748b);
		font-size: 12px;
		z-index: 6;
	}
	.rm-modal-error {
		color: #b91c1c;
		background: rgba(239, 68, 68, 0.06);
	}
	.rm-spinner {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		border: 2px solid var(--map-border, rgba(0,0,0,0.18));
		border-top-color: var(--map-primary, #6366f1);
		animation: rm-spin 0.8s linear infinite;
	}
	.rm-loading-text { font-weight: 500; }

	/* Root — the popup's `.rm-modal-card`, kept by name, minus the modal
	   wrapper/backdrop/close chrome. Fills the host container edge-to-edge
	   (the host/wrapper owns sizing and fullscreen). Safe-area insets keep
	   the floor strip clear of the notch + home indicator when the host
	   goes fullscreen on mobile. */
	.rm-modal-card {
		position: relative;
		background: #fff;
		width: 100%;
		height: 100%;
		border-radius: 0;
		padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		font-family: var(--map-font-family, system-ui, -apple-system, sans-serif);
	}
	.rm-modal-canvas-wrap {
		position: relative;
		flex: 1;
		min-height: 0; /* let it fill the flex card fully (taller fullscreen) */
		/* Clip pins/markers at the wrap edge so bottom-row pins don't bleed over
		   the floor strip below it. */
		overflow: hidden;
		/* Isolate marker layout/style recalcs from the rest of the document:
		   markers move via transform (layout-free) inside this container. */
		contain: layout style;
		background: var(--map-surface-elevated, rgba(0,0,0,0.04));
	}
	@keyframes rm-spin { to { transform: rotate(360deg); } }

	/* ─── Resource carousel (in-map; replaces the floating pin popup) ───
	   Layered as an absolute overlay along the bottom of the map canvas so it
	   floats over the floorplan rather than introducing a separate bar.
	   Background stays transparent — each card carries its own surface so the
	   map remains visible between/around them. z-index sits above pins so the
	   pins never poke through a card. */
	.rm-carousel {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 12px;
		display: flex;
		gap: 12px;
		overflow-x: auto;
		overflow-y: hidden;
		scroll-snap-type: x mandatory;
		scroll-behavior: smooth;
		-webkit-overflow-scrolling: touch;
		/* `pan-y` lets the page still scroll vertically when the user touches
		   the carousel and drags up/down, but reserves HORIZONTAL gestures for
		   our JS swipe handler (otherwise the browser's native horizontal scroll
		   competes with the manual scrollLeft updates we make from pointermove,
		   and `scroll-snap-type: x mandatory` snaps small swipes back). */
		touch-action: pan-y;
		overscroll-behavior-inline: contain;
		scrollbar-width: none;
		-ms-overflow-style: none;
		background: transparent;
		z-index: 30;
		/* Vertical padding for soft card shadow; horizontal padding computed so
		   the first AND last cards can centre-snap, and bumped above 24px so
		   on mobile the card never visually hugs the screen border. */
		padding: 12px max(24px, calc(50% - 260px));
	}
	.rm-carousel.rm-carousel-dragging {
		scroll-snap-type: none;
		cursor: grabbing;
	}
	.rm-carousel::-webkit-scrollbar { display: none; }
	.rm-carousel-single {
		overflow-x: hidden;
		justify-content: center;
	}
	.rm-carousel-card {
		flex: 0 0 auto;
		box-sizing: border-box;
		/* Width: a generous viewport-relative target on small screens (so the
		   card dominates with a peek of neighbours) capped at 520 px on wide
		   screens. The `max-width: calc(100% - 40px)` clamp is the SAFETY
		   NET — it caps the card to the container width minus 40 px so the
		   card never grazes the container's edges. Without this, on a 375 px
		   phone where the canvas is only ~327 px wide, the 82 vw card
		   (307 px) plus the carousel's horizontal padding totals more than
		   the canvas, so the card visibly overflowed. */
		width: min(82vw, 520px);
		max-width: calc(100% - 40px);
		min-width: 200px;
		scroll-snap-align: center;
		scroll-snap-stop: always;
		display: grid;
		grid-template-columns: 72px 1fr;
		align-items: center;
		/* (non-bookable cards drop the 72px thumbnail column — see
		   .rm-carousel-card-nothumb below) */
		gap: 12px;
		padding: 12px;
		background: var(--map-surface-elevated, #fff);
		border: 1px solid var(--map-border, rgba(0,0,0,0.08));
		border-radius: 16px;
		box-shadow: 0 6px 18px rgba(0,0,0,0.14);
		cursor: grab;
		transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
		text-align: left;
		user-select: none;
		-webkit-user-select: none;
		-webkit-tap-highlight-color: transparent;
	}
	/* No thumbnail (non-bookable POIs): drop the reserved 72px image column so
	   the info — and the name — uses the full card width instead of being
	   crammed into the empty thumbnail cell. */
	.rm-carousel-card-nothumb { grid-template-columns: 1fr; }
	.rm-carousel-single .rm-carousel-card {
		width: min(90vw, 480px);
		cursor: default;
	}
	.rm-carousel-card:focus-visible {
		outline: 2px solid var(--map-accent, #1d6ef5);
		outline-offset: 2px;
	}
	.rm-carousel-card-active {
		border-color: var(--map-accent, #1d6ef5);
		box-shadow: 0 2px 14px rgba(29,110,245,0.22);
	}
	.rm-carousel-thumb {
		width: 72px;
		height: 72px;
		border-radius: 12px;
		overflow: hidden;
		background: rgba(0,0,0,0.06);
		flex-shrink: 0;
	}
	.rm-carousel-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.rm-carousel-thumb-skel {
		width: 100%;
		height: 100%;
		background: linear-gradient(90deg, rgba(0,0,0,0.04), rgba(0,0,0,0.09), rgba(0,0,0,0.04));
		background-size: 200% 100%;
		animation: rm-thumb-skel 1.2s ease-in-out infinite;
	}
	@keyframes rm-thumb-skel {
		0%   { background-position: 200% 0; }
		100% { background-position: -200% 0; }
	}
	.rm-carousel-info {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.rm-carousel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		min-width: 0;
	}
	.rm-carousel-name {
		font-size: 15px;
		font-weight: 600;
		color: var(--map-text, #0f172a);
		line-height: 1.2;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1 1 auto;
		min-width: 0;
	}
	.rm-carousel-meta {
		display: inline-flex;
		gap: 5px;
		align-items: center;
		font-size: 13px;
		color: var(--map-text-muted, #64748b);
	}
	.rm-carousel-meta-sep { opacity: 0.6; }
	.rm-carousel-features {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 2px;
		font-size: 12px;
		color: var(--map-accent, #1d6ef5);
		min-width: 0;
	}
	.rm-carousel-sparkle { flex-shrink: 0; }
	.rm-carousel-feats-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* Book is a text-link styled action in the card header (matches the
	   "Book" caption in the spec). Solid button look is reserved for the
	   error/retry state. */
	.rm-carousel-book {
		flex-shrink: 0;
		padding: 4px 6px;
		font-size: 15px;
		font-weight: 600;
		color: var(--map-accent, #1d6ef5);
		background: transparent;
		border: 0;
		border-radius: 6px;
		cursor: pointer;
		white-space: nowrap;
		-webkit-tap-highlight-color: transparent;
	}
	.rm-carousel-book:hover:not(:disabled) { background: rgba(29,110,245,0.08); }
	.rm-carousel-book:disabled { opacity: 0.6; cursor: progress; }
	/* Right-side action group in the card header — keeps Navigate and Book
	   side by side without either pushing the name's ellipsis around. */
	.rm-carousel-actions {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	/* Navigate hands off to the host's navigation plugin. Same text-link
	   treatment as Book, with a leading direction arrow. */
	.rm-carousel-nav {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px;
		font-size: 15px;
		font-weight: 600;
		color: var(--map-accent, #1d6ef5);
		background: transparent;
		border: 0;
		border-radius: 6px;
		cursor: pointer;
		white-space: nowrap;
		-webkit-tap-highlight-color: transparent;
	}
	.rm-carousel-nav:hover { background: rgba(29,110,245,0.08); }
	.rm-carousel-nav svg { flex-shrink: 0; }
	.rm-carousel-status {
		flex-shrink: 0;
		font-size: 12px;
		font-weight: 600;
		padding: 4px 10px;
		border-radius: 999px;
		white-space: nowrap;
	}
	.rm-carousel-success { color: #059669; background: rgba(5,150,105,0.1); }

	/* Selected map pin — bigger so it reads as the "active" marker without
	   competing chromatically with the unselected pins. Inner white dot is
	   preserved so the pin still scans as a pin shape, not a flat circle. */
	.rm-pin-selected { z-index: 7; }
	/* Selected pin (carousel selection) — enlarge the teardrop so the focused
	   card's pin stands out, paired with the pulsing halo below. This mirrors
	   the `.rm-pin-dest` sizing. */
	.rm-pin-selected .rm-pin-teardrop-icon {
		width: 38px;
		height: 48px;
		filter: drop-shadow(0 4px 8px rgba(15,23,42,0.5));
	}
	/* Halo pulse around the selected pin. Uses `rm-pulse-selected` (not the
	   shared `rm-pulse`) because the shared keyframes set `transform: scale(...)`
	   alone, which would override our centering `translate(-50%, -50%)` and
	   pull the halo to the button's top-left. Keyframes bake the translate in
	   so the halo stays centred on the dot through the whole animation. */
	.rm-pin-selected::before {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		width: 56px;
		height: 56px;
		border-radius: 50%;
		background: rgba(15,23,42,0.22);
		animation: rm-pulse-selected 2s ease-out infinite;
		pointer-events: none;
	}
	@keyframes rm-pulse-selected {
		0%   { transform: translate(-50%, -50%) scale(1);   opacity: 0.7; }
		70%  { transform: translate(-50%, -50%) scale(1.6); opacity: 0; }
		100% { transform: translate(-50%, -50%) scale(1.6); opacity: 0; }
	}
	/* ─── appearance 'omx': the CX super app's map (cx_map Spaces.vue) ───
	   Values are the parent app's. Tokens: --map-brand (its --main, #0066DA),
	   --map-pin-selected (#1D2739), --map-pin-added (--map-brand), and the
	   fill colours --map-available/-busy/-disabled/-excluded (read by JS). */
	.rm-omx {
		font-family: var(--map-font-family, 'Open Sans', 'Segoe UI', system-ui, sans-serif);
	}
	.rm-omx .rm-modal-canvas-wrap,
	.rm-omx .rm-loading-overlay {
		background: #E6EFFB;
	}
	.rm-omx-pin {
		position: absolute;
		left: 0;
		top: 0;
		width: 40px;
		height: 40px;
		pointer-events: none;
		z-index: 5;
		color: var(--map-pin-added, var(--map-brand, #0066DA));
		filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.2));
	}
	.rm-omx-pin svg { display: block; }
	/* Declared after the added rule: selected + added keeps the navy body. */
	.rm-omx-pin-selected {
		color: var(--map-pin-selected, #1D2739);
		z-index: 6;
	}

	/* Zoom stack + compass: 24px from the right, like the parent app. */
	.rm-omx-zoom {
		position: absolute;
		right: 24px;
		bottom: 28px;
		z-index: 12;
		width: 46px;
		display: flex;
		flex-direction: column;
		background: #fff;
		border-radius: 22px;
		box-shadow: 0 4px 14px rgba(16, 24, 40, 0.16);
		overflow: hidden;
	}
	.rm-omx-zoom button {
		width: 46px;
		height: 46px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: none;
		background: transparent;
		color: var(--map-brand, #0066DA);
		cursor: pointer;
		padding: 0;
		-webkit-tap-highlight-color: transparent;
	}
	.rm-omx-zoom button:hover { background: #f5f9ff; }
	.rm-omx-zoom-divider {
		height: 1px;
		margin: 0 8px;
		background: #e5ebf3;
	}
	.rm-omx-compass {
		position: absolute;
		right: 25px;
		bottom: 130px;
		z-index: 12;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		border: none;
		background: #fff;
		box-shadow: 0 4px 14px rgba(16, 24, 40, 0.16);
		color: var(--map-brand, #0066DA);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
		transition: transform 0.15s ease, background-color 0.15s ease;
		-webkit-tap-highlight-color: transparent;
	}
	.rm-omx-compass:hover { background: #F4F8FD; transform: scale(1.04); }
	.rm-omx-zoom button:focus-visible,
	.rm-omx-compass:focus-visible,
	.rm-omx-floor-pill:focus-visible,
	.rm-omx-picker-close:focus-visible {
		outline: 2px solid var(--map-brand, #0066DA);
		outline-offset: 2px;
	}
	/* Rows and chips keep a border / sit in a clipping scroller: cx_map draws
	   their ring inside, so it never reads as a double border. */
	.rm-omx-picker-floor:focus-visible,
	.rm-omx-picker-building:focus-visible {
		outline: 2px solid var(--map-brand, #0066DA);
		outline-offset: -2px;
	}

	/* Building + floor pill (cx_map WPTopBar). */
	.rm-omx-floor-pill {
		position: absolute;
		top: 24px;
		left: 24px;
		z-index: 12;
		max-width: calc(100% - 48px);
		height: 44px;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 0 16px;
		border-radius: 999px;
		border: 1px solid #E5E7EB;
		background: #fff;
		box-shadow: 0 2px 8px rgba(16, 24, 40, 0.06);
		font: inherit;
		font-size: 14px;
		font-weight: 600;
		color: #1D2739;
		cursor: pointer;
		transition: background-color 0.15s ease, box-shadow 0.15s ease;
		-webkit-tap-highlight-color: transparent;
	}
	.rm-omx-floor-pill:hover {
		background: #F5F7FA;
		box-shadow: 0 3px 12px rgba(16, 24, 40, 0.1);
	}
	.rm-omx-floor-pill-icon { flex: none; color: var(--map-brand, #0066DA); }
	.rm-omx-floor-pill-chevron { flex: none; color: #98a2b3; }
	.rm-omx-floor-pill-label {
		min-width: 0;
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Buildings and Floors selector (cx_map BuildingsAndFloorsModal), scoped
	   to the map area rather than the page. */
	.rm-omx-picker-backdrop {
		position: absolute;
		inset: 0;
		z-index: 30;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: rgba(17, 24, 39, 0.52);
	}
	.rm-omx-picker {
		width: min(477px, 100%);
		max-height: 100%;
		display: flex;
		flex-direction: column;
		gap: 24px;
		padding: 24px;
		border-radius: 10px;
		background: #fff;
		box-shadow: 0 24px 54px rgba(0, 0, 0, 0.22);
		overflow: hidden;
		outline: none;
	}
	.rm-omx-picker-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		min-height: 34px;
		padding: 0 2px;
	}
	/* Balances the close button so the title centres on the card. */
	.rm-omx-picker-head::before {
		content: '';
		width: 24px;
		flex-shrink: 0;
	}
	.rm-omx-picker-title {
		flex: 1;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 20px;
		font-weight: 400;
		line-height: 30px;
		color: #1D2739;
		text-align: center;
	}
	.rm-omx-picker-close {
		flex-shrink: 0;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		border: none;
		background: transparent;
		color: #6B7178;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		padding: 0;
	}
	.rm-omx-picker-close:hover { background: #F4F6F8; }
	.rm-omx-picker-buildings {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		scrollbar-width: none;
		flex: none;
	}
	.rm-omx-picker-buildings::-webkit-scrollbar { display: none; }
	.rm-omx-picker-building {
		flex: none;
		min-width: 48px;
		min-height: 48px;
		padding: 8px 12px;
		border-radius: 30px;
		border: none;
		background: #ECF0F4;
		font: inherit;
		font-size: 16px;
		font-weight: 600;
		line-height: 137.5%;
		color: #1D2739;
		white-space: nowrap;
		cursor: pointer;
	}
	.rm-omx-picker-building-active {
		background: #E6F1FE;
		color: var(--map-brand, #0066DA);
	}
	.rm-omx-picker-floors {
		display: flex;
		flex-direction: column;
		gap: 16px;
		min-height: 0;
		overflow-y: auto;
		/* Room for the rows' focus ring inside the scroller. */
		padding: 3px;
		margin: -3px;
	}
	.rm-omx-picker-floor {
		display: flex;
		align-items: center;
		gap: 9px;
		width: 100%;
		padding: 12px;
		border-radius: 8px;
		border: 1px solid #B1BBC7;
		background: #fff;
		font: inherit;
		font-size: 16px;
		font-weight: 600;
		line-height: 22px;
		color: #1D2739;
		text-align: left;
		cursor: pointer;
		transition: border-color 0.15s ease;
	}
	.rm-omx-picker-floor:hover,
	.rm-omx-picker-floor-active {
		border-color: var(--map-brand, #0066DA);
	}
	.rm-omx-picker-floor-short {
		flex: none;
		width: 40px;
		height: 40px;
		border-radius: 8px;
		background: #ECF0F4;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 16px;
		font-weight: 600;
		line-height: 22px;
		color: #1D2739;
		overflow: hidden;
	}
	.rm-omx-picker-floor-active .rm-omx-picker-floor-short {
		background: var(--map-brand, #0066DA);
		color: #fff;
	}
	.rm-omx-picker-floor-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.rm-omx-picker-loading {
		display: flex;
		justify-content: center;
		padding: 24px 0;
	}
	/* Small map areas (a task-pane minimap): the parent app's 24px insets
	   and 24px dialog padding would crowd the floor plan. */
	@media (max-width: 480px) {
		.rm-omx-floor-pill { top: 12px; left: 12px; max-width: calc(100% - 24px); }
		.rm-omx-zoom { right: 12px; bottom: 12px; }
		.rm-omx-compass { right: 13px; bottom: 114px; }
		.rm-omx-picker-backdrop { padding: 12px; }
		.rm-omx-picker { padding: 16px; gap: 16px; }
		.rm-omx-picker-floors { gap: 8px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.rm-omx-compass,
		.rm-omx-floor-pill,
		.rm-omx-picker-floor { transition: none; }
	}
</style>
