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
	// The `servicenow=` value from the map data (serviceNowKey below), else
	// the default "<building>, <floor>, <space code>" (comma + space), or
	// "<building>, <floor>" for "The entire floor" / no code. Floor = the
	// floor number only (Daniel, MOO-598 2026-09-24); no-code rule per Frank
	// (same day).
	building: 'HQ',

	// Where the location comes from (Frank, MOO-598 2026-09-29/30): the
	// Jibestream External ID holds `key=value` pairs split by ";", e.g.
	// "zoneId=123;servicenow=HQ, 43, 43C08C". The `servicenow=` value is the
	// full location string, sent as-is: from the tapped item's waypoint (else
	// the destination / amenity), or from the floor for the entire floor.
	// Everything else in the External ID is ignored. When there is none, the
	// page generates the default below.
	serviceNowKey: 'servicenow',

	// Floor component. 'shortName' = Floor.shortName, the floor number only
	// ("43" — Daniel, MOO-598 2026-09-24: "HQ, 43, 43C08C"); 'name' = the
	// Jibestream floor name as-is ("Floor 43"). floorCodes overrides either,
	// per Jibestream mapId.
	floorCodeSource: 'shortName',
	floorCodes: undefined, // e.g. { 8869: '44' }

	// Space component of the default: 'namePrefix' (the first word of the
	// name that contains a digit — "17N11 Conference" → "17N11", "IDF 19N04"
	// → "19N04", "Dock Office1C14" → "1C14"; 3824 of 3826 Mutual names),
	// 'name' (the whole name), or 'none' (no code → missingCodePolicy).
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
	// Which "What does this request cover?" option starts selected: 'space'
	// ("At or near a specific space") or 'floor' ("The entire floor").
	defaultScope: 'space',
	// Keep "The entire floor" selected when the user taps the map (default: a
	// tap switches to "At or near a specific space").
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

	// Draw Jibestream's amenity icons (restrooms, printers…) on the map.
	showAmenityIcons: true,

	// Where Continue opens the ServiceNow form: 'auto' (this page; when
	// embedded in an iframe, the whole top page — ServiceNow usually refuses
	// to load in a frame), 'self' (always this page / frame), or 'none' (only
	// post the `continue` message; the embedding page navigates).
	continueTarget: 'auto',

	// targetOrigin for messages posted to an embedding parent page (the SDK
	// event mirror + the `continue` hand-off). Set it to the support page's
	// origin before iframing this picker in production. Default '*'.
	postMessageTargetOrigin: undefined, // e.g. 'https://mymutual.example.com'

	// true = don't navigate on Continue; log + alert the URL instead (no
	// `continue` message is posted in dry run). MUST be false when deployed.
	dryRun: false,
};
