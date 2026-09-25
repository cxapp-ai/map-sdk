/// <reference types="vite/client" />
/**
 * appearance: 'omx' harness — the CX super app's map in a task-pane layout,
 * with a room list standing in for the Outlook add-in's. Exercises:
 *   - row click → focusResource (select + centre, no add)
 *   - the row's + → `added` (the blue check pin), repainted in place
 *   - map tap → selectionchange (the row highlights; the map does not move)
 *   - availability fills, cycled every 8 s to show in-place repaints
 *
 * Rooms come from the venue's own destinations (core loadVenue), so any venue
 * the demo creds reach works. Optional: VITE_DEMO_BUILDINGS =
 * "2407:Building 1,2457:Building 2" for the building selector.
 */
import { mountIndoorMap, type MapResource, type MapBuilding } from '@cxapp-ai/map-sdk';
import { loadVenue } from '@cxapp-ai/map-sdk/core';

const env = import.meta.env;
const mapEl = document.getElementById('map') as HTMLElement;
const listEl = document.getElementById('list') as HTMLElement;
const logEl = document.getElementById('log') as HTMLPreElement;

function log(line: string): void {
	logEl.textContent += `${new Date().toISOString().slice(11, 23)}  ${line}\n`;
	logEl.scrollTop = logEl.scrollHeight;
}
function need(name: string): string {
	const v = env[name];
	if (!v) throw new Error(`Missing ${name} in demo/.env.local`);
	return String(v);
}

const provider = {
	host: String(env.VITE_JIBESTREAM_HOST || 'https://api.jibestream.com'),
	customerId: Number(need('VITE_JIBESTREAM_CUSTOMER_ID')),
	venueId: Number(need('VITE_JIBESTREAM_VENUE_ID')),
	mapProfileId: env.VITE_JIBESTREAM_MAP_PROFILE_ID ? Number(env.VITE_JIBESTREAM_MAP_PROFILE_ID) : undefined,
	auth: { clientId: need('VITE_JIBESTREAM_CLIENT_ID'), clientSecret: need('VITE_JIBESTREAM_CLIENT_SECRET') },
	mapRotation: env.VITE_DEMO_MAP_ROTATION ? Number(env.VITE_DEMO_MAP_ROTATION) : undefined,
};

const buildings: MapBuilding[] = String(env.VITE_DEMO_BUILDINGS ?? '')
	.split(',')
	.map(s => s.trim())
	.filter(Boolean)
	.map(s => {
		const [id, ...name] = s.split(':');
		return { venueId: Number(id), name: name.join(':') || `Building ${id}` };
	});

const STATES = ['available', 'busy', 'available', 'disabled', 'available', 'excluded'] as const;
let resources: MapResource[] = [];
let selectedId: string | null = null;

async function roomsFor(venueId: number): Promise<MapResource[]> {
	const venue = await loadVenue({ ...provider, venueId });
	return venue.destinations
		.filter(d => d.locations?.[0]?.waypointIds?.length)
		.slice(0, 40)
		.map((d, i) => ({
			externalId: d.locations[0].waypointIds[0],
			name: d.name,
			type: 'room',
			buildingExternalId: buildings.length ? venueId : undefined,
			availability: STATES[i % STATES.length],
			capacity: 2 + ((i * 3) % 11),
			added: false,
		}));
}

// ── The add-in's list, in RoomFinderSheet / RoomCard markup ─────────────────

const AVATAR_COLORS = ['#6c5ce7', '#e08a1e', '#0066da', '#2e7d32', '#c2410c', '#7c3aed', '#0891b2', '#be185d'];
function avatarColor(name: string): string {
	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
const collapsed: Record<string, boolean> = { added: false, available: false, unavailable: false };
const svg = (html: string) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild as SVGElement; };
const PEOPLE = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M6 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm0 1c-2.3 0-4 1.3-4 3v1h8v-1c0-1.7-1.7-3-4-3zm5.5-1a2 2 0 100-4 2 2 0 000 4zm0 1c-.5 0-1 .1-1.4.3.9.7 1.4 1.7 1.4 2.7v1H14v-1c0-1.6-1.1-3-2.5-3z"/></svg>';
const PLUS = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M10 5v10M5 10h10" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/></svg>';
const CHECK = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M5 10.5l3 3 7-7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
const CHEVRON = '<svg class="rf-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function toggleAdded(r: MapResource): void {
	resources = resources.map(x => (x === r ? { ...x, added: !x.added } : x));
	map.setResources(resources); // `added` repaints in place
	renderList();
}

function card(r: MapResource, inAdded: boolean): HTMLElement {
	const id = String(r.externalId);
	const busy = r.availability !== 'available';
	const el = document.createElement('div');
	el.className = 'room-card';
	if (inAdded) el.classList.add('room-card--selected');
	else if (busy) el.classList.add('room-card--ineligible');
	el.dataset.id = id;
	el.tabIndex = 0;
	el.setAttribute('role', 'button');
	el.setAttribute('aria-current', String(!inAdded && id === selectedId));
	const avatar = document.createElement('div');
	avatar.className = 'room-card__avatar';
	avatar.style.background = avatarColor(r.name);
	const body = document.createElement('div');
	body.className = 'room-card__body';
	const name = document.createElement('div');
	name.className = 'room-card__name';
	name.textContent = r.name;
	const meta = document.createElement('div');
	meta.className = 'room-card__meta';
	const cap = document.createElement('span');
	cap.textContent = String(r.capacity ?? '?');
	const dot = document.createElement('span');
	dot.className = 'room-card__dot';
	dot.textContent = '·';
	const cat = document.createElement('span');
	cat.textContent = r.type === 'room' ? 'Meeting Room' : (r.type ?? '');
	meta.append(svg(PEOPLE), cap, dot, cat);
	body.append(name, meta);
	el.append(avatar, body);
	// RoomCard: added → a filled check (remove); free → an outlined +; busy → none.
	if (inAdded || !busy) {
		const action = document.createElement('button');
		action.type = 'button';
		action.className = 'room-card__action' + (inAdded ? ' room-card__action--selected' : '');
		action.setAttribute('aria-label', `${inAdded ? 'Remove' : 'Add'} ${r.name}`);
		action.append(svg(inAdded ? CHECK : PLUS));
		action.addEventListener('click', e => { e.stopPropagation(); toggleAdded(r); });
		el.append(action);
	}
	const select = () => { map.focusResource(id); log(`[host] focusResource(${id})`); };
	el.addEventListener('click', select);
	el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
	return el;
}

function group(key: string, title: string, rooms: MapResource[], inAdded = false): HTMLElement | null {
	if (!rooms.length) return null;
	const g = document.createElement('div');
	g.className = 'rf-group';
	const head = document.createElement('button');
	head.type = 'button';
	head.className = 'rf-group__header' + (inAdded ? ' rf-group__header--added' : '');
	head.setAttribute('aria-expanded', String(!collapsed[key]));
	const chev = svg(CHEVRON);
	if (collapsed[key]) chev.classList.add('is-collapsed');
	const t = document.createElement('span');
	t.className = 'rf-group__title';
	t.textContent = title;
	head.append(chev, t);
	if (inAdded) {
		const pill = document.createElement('span');
		pill.className = 'rf-group__pill';
		pill.textContent = `${rooms.length} SELECTED`;
		head.append(pill);
	}
	const rule = document.createElement('span');
	rule.className = 'rf-group__rule';
	const count = document.createElement('span');
	count.className = 'rf-group__count';
	count.textContent = String(rooms.length);
	head.append(rule, count);
	head.addEventListener('click', () => { collapsed[key] = !collapsed[key]; renderList(); });
	g.append(head);
	if (!collapsed[key]) for (const r of rooms) g.append(card(r, inAdded));
	return g;
}

function renderList(): void {
	const byName = (a: MapResource, b: MapResource) => a.name.localeCompare(b.name);
	const added = resources.filter(r => r.added).sort(byName);
	const free = resources.filter(r => !r.added && r.availability === 'available').sort(byName);
	const other = resources.filter(r => !r.added && r.availability !== 'available').sort(byName);
	listEl.replaceChildren(...[
		group('added', 'Added to meeting', added, true),
		group('available', 'Available', free),
		group('unavailable', 'Unavailable', other),
	].filter((x): x is HTMLElement => !!x));
}

// The ticket's scroll rule: a row already fully visible does not move; one
// partly or wholly out of view is scrolled to the top of the list viewport
// (or as far as the list scrolls). The highlight itself renders first.
function revealSelectedRow(): void {
	if (!selectedId) return;
	const r = resources.find(x => String(x.externalId) === selectedId);
	if (!r) return;
	const key = r.added ? 'added' : r.availability === 'available' ? 'available' : 'unavailable';
	if (collapsed[key]) { collapsed[key] = false; renderList(); }
	const scroller = listEl.parentElement!;
	const row = listEl.querySelector<HTMLElement>(`.room-card[aria-current="true"]`);
	if (!row) return;
	const view = scroller.getBoundingClientRect();
	const box = row.getBoundingClientRect();
	if (box.top >= view.top && box.bottom <= view.bottom) return;
	scroller.scrollTo({ top: scroller.scrollTop + (box.top - view.top) - 8, behavior: 'smooth' });
}

const map = mountIndoorMap(mapEl, {
	provider,
	appearance: 'omx',
	buildings: buildings.length ? buildings : undefined,
	resources: [],
	autoReroute: false,
	logger: console,
	on: {
		onReady: () => log(`ready — floors: ${map.getFloors().map(f => f.shortName || f.name).join(', ')}`),
		onSelectionChange: ({ resource, source }) => {
			selectedId = resource ? String(resource.externalId) : null;
			log(`selectionchange ${source} → ${resource?.name ?? 'none'}`);
			renderList();
			if (source === 'tap') revealSelectedRow();
		},
		onFloorChange: id => log(`floorchange ${id}`),
		onBuildingChange: b => { log(`buildingchange ${b.name}`); void loadRooms(b.venueId); },
		onError: e => log(`error: ${e.message}`),
	},
});
(window as unknown as { map: typeof map }).map = map;

async function loadRooms(venueId: number): Promise<void> {
	resources = await roomsFor(venueId);
	map.setResources(resources);
	renderList();
	log(`[host] ${resources.length} rooms`);
}
void loadRooms(provider.venueId).catch(e => log(`rooms failed: ${e}`));

// Availability refresh: rotate every room's state (repaints, no rebuild).
let tickN = 0;
setInterval(() => {
	if (!resources.length || env.VITE_DEMO_NO_CYCLE) return;
	tickN++;
	resources = resources.map((r, i) => ({ ...r, availability: STATES[(i + tickN) % STATES.length] }));
	map.setResources(resources);
	renderList();
}, 8000);
