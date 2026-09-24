/*
 * MyMutual ticket location picker — configuration TEMPLATE.
 *
 *   cp pages/moo/config.example.js pages/moo/config.local.js
 *
 * then fill config.local.js in. It is gitignored: it carries the Jibestream
 * client secret, which ships to the browser on this page (accepted for this
 * page by Frank on MOO-598 — "ok to hardcode jibestream creds"). Never commit
 * the filled-in file.
 */
window.MOO_TICKET_CONFIG = {
	// ── Jibestream (the map) ──────────────────────────────────────────────
	// Mutual of Omaha Headquarters: customer 485, venue 2754. The client id /
	// secret come from Daniel Seijas — put them ONLY in config.local.js.
	jibestream: {
		host: 'https://api.jibestream.com',
		customerId: 485,
		venueId: 2754,
		clientId: '',
		clientSecret: '',
		// Only if the service account has no default map profile (401 "Map
		// profile query param must be present" without it).
		mapProfileId: undefined,
	},

	// Optional: rename floors in the floor strip, by Jibestream mapId.
	floorLabels: undefined, // e.g. { 7659: 'Floor 44' }
	// Optional: open on this floor (Jibestream mapId). Mutual HQ: 8845 = Floor 1.
	initialFloor: undefined,

	// ── location_on_floor_plan ────────────────────────────────────────────
	// Format: "<building>, <floor>, <space code>" (comma + space), or
	// "<building>, <floor>" for "anywhere on this floor" / no code.
	// Floor format + no-code rule follow Frank on MOO-598 (2026-09-24); the
	// space code source is our choice pending his OK (see spaceCodeSource).
	building: 'HQ',

	// Whole location string from one Jibestream custom property, when the
	// venue has it configured (Frank). Unset / missing → generated as below.
	locationProperty: undefined, // e.g. 'Location On Floor Plan'

	// Floor component. 'name' = the Jibestream floor name as-is ("Floor 44" —
	// Frank's choice); 'shortName' = Floor.shortName ("44", the Confluence
	// example). floorCodes overrides either, per Jibestream mapId.
	floorCodeSource: 'name',
	floorCodes: undefined, // e.g. { 8869: '44' }

	// Space component, first match wins:
	//   spaceCodeProperty — a Jibestream custom property key (Frank: "space
	//     code would be a property"). Mutual HQ has none today: 3 of 3826
	//     destinations carry any property ("Filter Category").
	//   spaceCodeSource — 'namePrefix' (default: the first word of the name
	//     that contains a digit — "17N11 Conference" → "17N11", "IDF 19N04" →
	//     "19N04", "Dock Office1C14" → "1C14"; 3824 of 3826 Mutual names),
	//     'externalId' (4 of 3826 at Mutual), 'name', or 'none' (codes only
	//     from spaceCodeProperty — use once Mutual has a code property).
	//     namePrefix is our choice, not Frank's: he asked for a property, but
	//     Mutual has none today. Pending his confirmation on MOO-598.
	spaceCodeProperty: undefined, // e.g. 'Space Code'
	spaceCodeSource: 'namePrefix',
	spaceCodePattern: undefined, // regex string, capture group 1 = code (namePrefix only)
	// No code found: 'floor' (send "<building>, <floor>" — Frank), 'name' (use
	// the display name as the code), or 'deny' (block Continue).
	missingCodePolicy: 'floor',

	// What a tap may select: 'space' (rooms/desks/offices — Jibestream
	// destinations), 'amenity' (POIs), 'waypoint' (any routing point), 'point'
	// (the tapped spot itself when nothing is within maxSnapMeters → floor
	// only). Order = tie-break preference. [] = nothing.
	selectable: ['space', 'amenity', 'point'],
	// A tap outside any room shape picks the nearest space/amenity only
	// within this many metres; farther → 'point' (floor only). null = no cap.
	// 15 m ≈ a large room's span. On Mutual Floor 1 open-area taps snapped a
	// median 9.6 m (max 42 m) without a cap.
	maxSnapMeters: 15,
	// Optional filter over candidates — Jibestream doesn't mark rooms vs
	// desks, so narrow by tags / keywords / name. A rejected candidate is
	// skipped and the next-nearest accepted one is selected. e.g. rooms only:
	//   accept: function (c) { return c.kind !== 'space' || c.tags.indexOf('Meeting Room') !== -1; },
	// c = { kind, mapId, name, externalId, destinationId, amenityId, waypointId, keywords, tags, properties }
	// e.g. skip corridors at Mutual HQ ("1C03B CIRC"):
	//   accept: function (c) { return !/\bCIRC\b/.test(c.name || ''); },
	accept: undefined,
	// Ignore taps farther than this from any selectable item (map units;
	// roughly floor-plan pixels). Leave undefined for no limit.
	maxSnapDistance: undefined,
	// Keep "Anywhere on this floor" checked when the user taps a space
	// (default: a tap switches back to "Exactly at the selected space").
	keepScopeOnSelect: false,

	// ── ServiceNow (the ticket form) ──────────────────────────────────────
	// Hosts: mutualofomahadev (STAGE) · mutualofomahatest (what MyMutual PROD
	// uses today — still Mutual's ServiceNow TEST instance) · final production
	// host still to be provided by Mutual of Omaha. sys_ids are the same
	// across environments. Default is the PROD-testing host: per Daniel
	// (MOO-598) the SSO bypass (`wext=1`, double-auth) only works on PROD, so
	// the hand-off can only be verified end-to-end there.
	serviceNow: {
		host: 'https://mutualofomahatest.service-now.com',
		pageId: 'my_mutual',
		locationVariable: 'location_on_floor_plan',
		// Extra sysparm_variable_values merged into every form (optional).
		extraVariables: {},
		forms: {
			facilities: {
				title: 'Building Facilities and Supplies Request',
				sysId: '798e3ee687d20754ea4cea883cbb3549',
			},
			it: {
				title: 'Onsite Headquarters IT Incident',
				sysId: 'bf181a2447ae03980971cc0b516d439b',
			},
		},
	},

	// targetOrigin for messages posted to an embedding parent page (the SDK
	// event mirror + the `continue` hand-off). Set it to the support page's
	// origin before iframing this picker in production. Default '*'.
	postMessageTargetOrigin: undefined, // e.g. 'https://mymutual.example.com'

	// true = don't navigate on Continue; log + alert the URL instead (no
	// `continue` message is posted in dry run). MUST be false when deployed.
	dryRun: false,
};
