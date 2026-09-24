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
	// Mutual of Omaha's venue. Get these from Daniel Seijas / Geric Ramos.
	// The stage venue id seen in the MOO stage config (Apr 2026) was 2754; the
	// customer id and prod venue id are still to be confirmed.
	jibestream: {
		host: 'https://api.jibestream.com',
		customerId: 0,
		venueId: 0,
		clientId: '',
		clientSecret: '',
		// Only if the service account has no default map profile (401 "Map
		// profile query param must be present" without it).
		mapProfileId: undefined,
	},

	// Optional: rename floors in the floor strip, by Jibestream mapId.
	floorLabels: undefined, // e.g. { 7659: 'Floor 44' }
	// Optional: open on this floor (Jibestream mapId).
	initialFloor: undefined,

	// ── location_on_floor_plan ────────────────────────────────────────────
	// Format (confirmed on the MyMutual Ticketing Workflows page):
	//   "<building>, <floor>, <space code>"  e.g. "HQ, 44, 39E04"
	//   "<building>, <floor>"                when the user picks "anywhere on this floor"
	building: 'HQ',
	// Floor component override by Jibestream mapId. Default: the map's numeric
	// shortName from Jibestream, then its name.
	floorCodes: undefined, // e.g. { 7659: '44' }
	// Space component: 'externalId' (Jibestream destination external id — the
	// venue's space code; default) or 'name' (the display name).
	spaceCodeSource: 'externalId',
	// When the tapped item has no code: 'deny' (block Continue and ask for
	// another space — Frank) or 'name' (fall back to the Jibestream name — Daniel).
	missingCodePolicy: 'deny',

	// What a tap may select: 'space' (rooms/desks/offices — Jibestream
	// destinations), 'amenity' (POIs), 'waypoint' (any routing point; only
	// as a last resort). Order = tie-break preference.
	selectable: ['space', 'amenity'],
	// Ignore taps farther than this from any selectable item (map units;
	// roughly floor-plan pixels). Leave undefined for no limit.
	maxSnapDistance: undefined,
	// Keep "Anywhere on this floor" checked when the user taps a space
	// (default: a tap switches back to "Exactly at the selected space").
	keepScopeOnSelect: false,

	// ── ServiceNow (the ticket form) ──────────────────────────────────────
	// Hosts: mutualofomahadev (STAGE) · mutualofomahatest (PROD-testing) ·
	// final production host still to be provided by Mutual of Omaha.
	// sys_ids are the same across environments.
	serviceNow: {
		host: 'https://mutualofomahadev.service-now.com',
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

	// true = don't navigate on Continue; log + alert the URL instead.
	dryRun: false,
};
