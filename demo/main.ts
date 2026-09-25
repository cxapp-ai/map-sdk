/// <reference types="vite/client" />
/**
 * Demo harness for @cxapp-ai/map-sdk.
 *
 * Exercises the public surface: mountIndoorMap, fullscreen toggle, itinerary
 * draw/clear, a mock booking plugin (2s delay → confirmed), a GPS mock
 * toggle (remounts — `gps` is a mount option), focusResource, and a log
 * panel fed EXCLUSIVELY by the `mapsdk:*` DOM CustomEvents dispatched on the
 * container — proving the no-bundler-interop event path works.
 *
 * Credentials come from demo/.env.local (VITE_JIBESTREAM_*) — see
 * demo/README.md. Never commit secrets.
 */
import {
	mountIndoorMap,
	type IndoorMapHandle,
	type MapResource,
} from '@cxapp-ai/map-sdk';

const mapEl = document.getElementById('map') as HTMLElement;
const logEl = document.getElementById('log') as HTMLPreElement;
const btnFullscreen = document.getElementById('btn-fullscreen') as HTMLButtonElement;
const btnItinerary = document.getElementById('btn-itinerary') as HTMLButtonElement;
const btnGps = document.getElementById('btn-gps') as HTMLButtonElement;
const btnFocus = document.getElementById('btn-focus') as HTMLButtonElement;

function log(line: string): void {
	const ts = new Date().toISOString().slice(11, 23);
	logEl.textContent += `${ts}  ${line}\n`;
	logEl.scrollTop = logEl.scrollHeight;
}

// ── Env (demo-only; the SDK itself never reads env) ─────────────────────────

const env = import.meta.env;

function requireEnv(name: string): string {
	const v = env[name];
	if (!v) throw new Error(`Missing ${name} — copy the Jibestream demo creds into demo/.env.local (see demo/README.md)`);
	return String(v);
}

// ── Mock resources ──────────────────────────────────────────────────────────
// externalId must be a REAL Jibestream waypointId for the pin to resolve on
// your venue; ids that don't resolve still show in the carousel and count in
// the "N not shown on map" badge. Override with VITE_DEMO_WAYPOINT_IDS
// (comma-separated) to match your venue.

const waypointIds: string[] = String(env.VITE_DEMO_WAYPOINT_IDS ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
if (waypointIds.length === 0) waypointIds.push('101', '102', '103');

const todayYMD = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local tz

const resources: MapResource[] = waypointIds.map((id, i) => ({
	externalId: id,
	name: `Demo ${i % 2 === 0 ? 'Room' : 'Desk'} ${String.fromCharCode(65 + i)}`,
	type: i % 2 === 0 ? 'room' : 'desk',
	floorName: 'L1',
	features: i % 2 === 0 ? ['TV', 'Whiteboard'] : ['Monitor'],
	capacity: i % 2 === 0 ? 6 : undefined,
	// Opaque payload — passed back verbatim to booking.onBook.
	bookingContext: { startDate: todayYMD, startTime: '09:00', endTime: '10:00', demo: true },
}));

// ── Event log: mapsdk:* CustomEvents on the container ───────────────────────

const EVENT_NAMES = [
	'ready',
	'resourceselect',
	'floorchange',
	'bookrequested',
	'bookingstatechange',
	'navigaterequested',
	'fullscreenchange',
	'selectionchange',
	'buildingchange',
	'error',
] as const;

function summarize(detail: unknown): string {
	if (detail == null) return '';
	if (typeof detail !== 'object') return JSON.stringify(detail);
	const d = detail as Record<string, unknown>;
	const r = (d.resource ?? detail) as Record<string, unknown>;
	const bits: string[] = [];
	if (typeof r.name === 'string') bits.push(`name=${r.name}`);
	if (r.externalId != null) bits.push(`externalId=${String(r.externalId)}`);
	if (typeof d.status === 'string') bits.push(`status=${d.status}`);
	if (typeof d.message === 'string') bits.push(`message=${d.message}`);
	return bits.length ? bits.join(' ') : JSON.stringify(detail);
}

let fullscreen = false;
for (const name of EVENT_NAMES) {
	// Listeners attach ONCE on the host container and survive remounts —
	// the SDK dispatches on the container, bubbling + composed.
	mapEl.addEventListener(`mapsdk:${name}`, (e) => {
		const detail = (e as CustomEvent).detail;
		log(`mapsdk:${name}  ${summarize(detail)}`);
		if (name === 'fullscreenchange') {
			fullscreen = !!detail;
			btnFullscreen.textContent = fullscreen ? 'Exit fullscreen (or press Esc)' : 'Enter fullscreen';
		}
	});
}

// ── Mount / remount ──────────────────────────────────────────────────────────

let handle: IndoorMapHandle | null = null;
let gpsMockOn = false;
let itineraryOn = false;

function mountMap(): void {
	handle?.destroy();
	fullscreen = false;
	itineraryOn = false;
	btnFullscreen.textContent = 'Enter fullscreen';
	btnItinerary.textContent = 'Draw itinerary';

	handle = mountIndoorMap(mapEl, {
		provider: {
			host: String(env.VITE_JIBESTREAM_HOST || 'https://api.jibestream.com'),
			customerId: Number(requireEnv('VITE_JIBESTREAM_CUSTOMER_ID')),
			venueId: Number(requireEnv('VITE_JIBESTREAM_VENUE_ID')),
			mapProfileId: env.VITE_JIBESTREAM_MAP_PROFILE_ID
				? Number(env.VITE_JIBESTREAM_MAP_PROFILE_ID)
				: undefined,
			// Dev-only client-credentials auth. Production hosts pass
			// auth: { getToken } and mint JACS tokens server-side.
			auth: {
				clientId: requireEnv('VITE_JIBESTREAM_CLIENT_ID'),
				clientSecret: requireEnv('VITE_JIBESTREAM_CLIENT_SECRET'),
			},
		},
		resources,
		focusResourceId: resources[0]?.externalId,
		mode: 'container',
		// GPS mock: a single synthetic fix (desktop testing aid). Set
		// VITE_DEMO_MOCK_LAT/LNG near your venue so the dot lands on-floor.
		gps: gpsMockOn
			? {
					mock: {
						lat: Number(env.VITE_DEMO_MOCK_LAT ?? 37.7626),
						lng: Number(env.VITE_DEMO_MOCK_LNG ?? -121.9682),
						accuracy: 5,
					},
					accuracyThresholdM: 100,
				}
			: false,
		// Mock booking plugin: 2s "backend" delay, then confirmed. The card
		// shows Booking… → Booked; watch mapsdk:bookingstatechange in the log.
		booking: {
			onBook: async (resource, ctx) => {
				log(`[host] booking.onBook(${resource.name}) ctx=${JSON.stringify(ctx)} — confirming in 2s`);
				await new Promise((r) => setTimeout(r, 2000));
				return { confirmed: true, reservationId: `demo-${Date.now()}` };
			},
		},
		// Host navigation stub so the Navigate button shows (in a CX WebView
		// you'd pass cxaiNavigationPlugin() ?? undefined instead).
		navigation: {
			onNavigate: (resource) => log(`[host] navigation.onNavigate(${resource.name})`),
		},
		logger: console,
		on: {
			// Callback path (in addition to the CustomEvents logged above).
			onReady: () => log('[callback] onReady'),
			onError: (e) => log(`[callback] onError: ${e.message}`),
		},
	});
}

// ── Toolbar ──────────────────────────────────────────────────────────────────

btnFullscreen.addEventListener('click', () => handle?.setFullscreen(!fullscreen));

// The SDK ships no fullscreen chrome — the host owns exit affordances.
window.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && fullscreen) handle?.setFullscreen(false);
});

btnItinerary.addEventListener('click', () => {
	if (!handle) return;
	itineraryOn = !itineraryOn;
	if (itineraryOn) {
		const stops = waypointIds.slice(0, 2);
		handle.setItinerary(stops, { showStopNumbers: true });
		btnItinerary.textContent = 'Clear itinerary';
		log(`[host] setItinerary([${stops.join(', ')}])`);
	} else {
		handle.setItinerary(null);
		btnItinerary.textContent = 'Draw itinerary';
		log('[host] setItinerary(null)');
	}
});

btnGps.addEventListener('click', () => {
	gpsMockOn = !gpsMockOn;
	btnGps.textContent = `GPS mock: ${gpsMockOn ? 'on' : 'off'}`;
	log(`[host] GPS mock ${gpsMockOn ? 'on' : 'off'} — remounting (gps is a mount option)`);
	mountMap();
});

btnFocus.addEventListener('click', () => {
	const id = resources[1]?.externalId;
	if (id == null || !handle) return;
	handle.focusResource(id);
	log(`[host] focusResource(${id})`);
});

// ── Go ───────────────────────────────────────────────────────────────────────

try {
	mountMap();
} catch (e) {
	const msg = e instanceof Error ? e.message : String(e);
	const errDiv = document.createElement('div');
	errDiv.style.cssText = 'padding:24px;font-size:14px;color:#b91c1c;';
	errDiv.textContent = msg;
	mapEl.replaceChildren(errDiv);
	log(`[host] mount failed: ${msg}`);
}
