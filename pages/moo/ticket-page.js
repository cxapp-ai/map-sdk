/*
 * MyMutual ticket location picker — page logic (MOO-598).
 *
 * Plain browser JS on purpose (Frank: "raw html … embedded form javascript"):
 * no bundler, no framework. Runs after config.local.js (window.MOO_TICKET_CONFIG)
 * and map-sdk.iife.js (window.MapSDK) have loaded.
 *
 * Flow:
 *   1. Mount the minimap in location-select mode: every venue floor listed,
 *      no cards / booking / navigation, tap → nearest space or amenity.
 *   2. The SDK dispatches `mapsdk:locationselect` on the container (and, via
 *      `postMessage: true`, mirrors every event to window.parent for an
 *      embedding support page). This page listens on the container.
 *   3. The user picks what the request covers — "At or near a specific space"
 *      or "The entire floor" (Michael's prototype, MOO-598 2026-09-25). The
 *      entire floor hides the pin and outline but keeps the selection.
 *   4. `location_on_floor_plan` = the `servicenow=` value in the Jibestream
 *      External ID (the tapped item's waypoint, or the floor for the entire
 *      floor); without one, a default "<building>, <floor>, <space code>" /
 *      "<building>, <floor>" (comma + space, per the MyMutual Ticketing
 *      Workflows Confluence page).
 *   5. "Continue to ticket" replaces this page with the ServiceNow form URL,
 *      passing the string in sysparm_variable_values.
 */
(function () {
	'use strict';

	// Defaults live HERE only; config.local.js overrides them (an explicit
	// `undefined` in the config means "use the default").
	//   floorCodeSource 'shortName' — Daniel, MOO-598 2026-09-24: the floor
	//     component is the floor number ONLY ("HQ, 43, 43C08C"; Confluence
	//     step 3 now says the same).
	//   missingCodePolicy 'floor' — Frank, MOO-598 2026-09-24 (no code →
	//     floor only).
	//   serviceNowKey 'servicenow' — Frank, MOO-598 2026-09-29: the location
	//     comes from the `servicenow=` pair in the Jibestream External ID
	//     (waypoint for a space, floor for the entire floor). Without one the
	//     page generates a default (Frank: "only as a convenience"):
	//   spaceCodeSource 'namePrefix' — the code at the start of the room name
	//     (3824 of 3826 Mutual HQ names: "43C08C Telecom" → "43C08C").
	var DEFAULTS = {
		serviceNowKey: 'servicenow',
		building: 'HQ',
		floorCodeSource: 'shortName',
		spaceCodeSource: 'namePrefix',
		missingCodePolicy: 'floor',
		defaultScope: 'space',
		selectable: ['space', 'amenity', 'point'],
		maxSnapMeters: 15,
		showAmenityIcons: true,
		continueTarget: 'auto',
		postMessageTargetOrigin: '*',
	};
	var SERVICENOW_DEFAULTS = { pageId: 'my_mutual', locationVariable: 'location_on_floor_plan' };
	function withDefaults(defaults, overrides) {
		var out = {}, k;
		for (k in defaults) out[k] = defaults[k];
		for (k in overrides || {}) if (overrides[k] !== undefined) out[k] = overrides[k];
		return out;
	}
	var RAW = window.MOO_TICKET_CONFIG;
	var CFG = RAW && withDefaults(DEFAULTS, RAW);
	if (CFG) CFG.serviceNow = withDefaults(SERVICENOW_DEFAULTS, RAW.serviceNow);
	var TICKET = document.documentElement.getAttribute('data-ticket') || 'facilities';

	var $ = function (id) { return document.getElementById(id); };
	var els = {
		title: $('tp-title'),
		map: $('tp-map'),
		error: $('tp-error'),
		form: $('tp-form'),
		empty: $('tp-empty'),
		card: $('tp-card'),
		kind: $('tp-kind'),
		name: $('tp-name'),
		floor: $('tp-floor'),
		code: $('tp-code'),
		clear: $('tp-clear'),
		floorCard: $('tp-floor-card'),
		floorName: $('tp-floor-name'),
		building: $('tp-building'),
		pinNote: $('tp-pin-note'),
		pinName: $('tp-pin-name'),
		usePin: $('tp-use-pin'),
		banner: $('tp-banner'),
		warning: $('tp-warning'),
		location: $('tp-location'),
		continueBtn: $('tp-continue'),
	};

	function showError(msg) {
		els.error.textContent = msg;
		els.error.hidden = false;
		els.continueBtn.disabled = true;
	}

	if (!CFG) {
		showError('Missing config.local.js — copy config.example.js to config.local.js and fill in the Jibestream + ServiceNow settings.');
		return;
	}
	if (!window.MapSDK || typeof window.MapSDK.mountIndoorMap !== 'function') {
		showError('map-sdk.iife.js not found — run `npm run build` in the repo root (or copy dist/map-sdk.iife.js next to this page).');
		return;
	}
	var form = CFG.serviceNow.forms && CFG.serviceNow.forms[TICKET];
	if (!form || !form.sysId) {
		showError('No ServiceNow form configured for ticket type "' + TICKET + '" (serviceNow.forms.' + TICKET + ').');
		return;
	}
	// Without an absolute https host the ticket URL would be relative and
	// Continue would land on this picker's own origin (a silent 404).
	if (!/^https:\/\/[^/\s]+/i.test(String(CFG.serviceNow.host || ''))) {
		showError('serviceNow.host must be an https:// URL (e.g. https://mutualofomahatest.service-now.com) — check config.local.js.');
		return;
	}
	if (typeof CFG.serviceNowKey !== 'string' || !/^[^=;]+$/.test(CFG.serviceNowKey)) {
		showError('serviceNowKey must be a non-empty key without "=" or ";" (default "servicenow") — check config.local.js.');
		return;
	}
	if (['auto', 'self', 'none'].indexOf(CFG.continueTarget) === -1) {
		showError("continueTarget must be 'auto', 'self' or 'none' — check config.local.js.");
		return;
	}
	var SPACE_CODE_SOURCES = ['namePrefix', 'name', 'none'];
	if (SPACE_CODE_SOURCES.indexOf(CFG.spaceCodeSource) === -1) {
		showError('spaceCodeSource must be one of ' + SPACE_CODE_SOURCES.join(', ') + ' — check config.local.js.');
		return;
	}
	if (CFG.defaultScope !== 'space' && CFG.defaultScope !== 'floor') {
		showError("defaultScope must be 'space' or 'floor' — check config.local.js.");
		return;
	}
	// Compiled up front so a typo fails loudly here, not as a dead page.
	var NAME_CODE = null;
	if (CFG.spaceCodePattern) {
		try { NAME_CODE = new RegExp(CFG.spaceCodePattern); }
		catch (err) {
			showError('spaceCodePattern is not a valid regular expression (' + err.message + ') — check config.local.js.');
			return;
		}
	}
	// targetOrigin for everything this page posts to an embedding parent
	// (the SDK event mirror and the `continue` hand-off).
	var TARGET_ORIGIN = CFG.postMessageTargetOrigin;
	if (form.title) {
		els.title.textContent = form.title;
		document.title = form.title + ' — Select a location';
	}

	// ── State ──────────────────────────────────────────────────────────────
	var state = {
		selection: null,        // MapSelection from the SDK, or null
		scope: CFG.defaultScope, // 'space' | 'floor'
		currentMapId: null,     // floor shown on the map (for the 'floor' scope)
		ready: false,
	};

	// ── Map ────────────────────────────────────────────────────────────────
	var jb = CFG.jibestream || {};
	var map = window.MapSDK.mountIndoorMap(els.map, {
		provider: {
			host: jb.host || 'https://api.jibestream.com',
			customerId: Number(jb.customerId),
			venueId: Number(jb.venueId),
			mapProfileId: jb.mapProfileId != null ? Number(jb.mapProfileId) : undefined,
			// Hardcoded client credentials (approved for this page by Frank on
			// MOO-598). They ship to the browser — keep config.local.js out of git.
			auth: { clientId: jb.clientId, clientSecret: jb.clientSecret },
			floorLabels: CFG.floorLabels || undefined,
		},
		// Location picker: no resource pins, every floor listed, no cards.
		resources: [],
		allFloors: true,
		// Amenity icons on the map — the client asked (Daniel, MOO-598 2026-09-30).
		showAmenityIcons: CFG.showAmenityIcons,
		showFloorSelector: true,
		showCards: false,
		bookable: false,
		autoReroute: false,
		initialFloor: CFG.initialFloor != null ? Number(CFG.initialFloor) : undefined,
		locationSelect: {
			// 'point' = the tapped spot, when no space/amenity is within
			// maxSnapMeters → sends the floor only.
			selectable: CFG.selectable,
			maxSnapDistance: CFG.maxSnapDistance,
			maxSnapMeters: CFG.maxSnapMeters, // null = no cap
			// Optional host filter, e.g. rooms only — see config.example.js.
			accept: typeof CFG.accept === 'function' ? CFG.accept : undefined,
		},
		// Mirror every mapsdk:* event to window.parent as
		// { source: 'map-sdk', type, detail } — for a support page that iframes
		// this picker. Harmless when the page is opened directly.
		postMessage: { targetOrigin: TARGET_ORIGIN },
		strings: { loadingMap: 'Loading floor plan…' },
		logger: console,
	});

	// The SDK emits floorchange for the opening floor too, so currentMapId
	// needs no seeding here.
	els.map.addEventListener('mapsdk:ready', function () {
		state.ready = true;
		render();
	});
	els.map.addEventListener('mapsdk:floorchange', function (e) {
		state.currentMapId = e.detail;
		render();
	});
	els.map.addEventListener('mapsdk:locationselect', function (e) {
		state.selection = e.detail; // MapSelection | null
		if (state.selection && state.scope === 'floor') {
			// Tapping a space is a strong signal the issue is AT that space.
			// keepScopeOnSelect keeps the entire floor — re-hide the new pin,
			// which the SDK shows for every tap.
			if (CFG.keepScopeOnSelect) map.setSelectionVisible(false);
			else setScope('space');
		}
		render();
	});
	els.map.addEventListener('mapsdk:error', function (e) {
		var d = e.detail || {};
		console.error('[ticket-page] map error', d);
		showError(d.message || 'The map failed to load.');
	});

	// ── Location string ────────────────────────────────────────────────────

	// mapId → FloorSummary, read once (the floor list never changes after
	// ready; floorLabels are fixed for this page).
	var floorIndex = null;
	function floorFor(mapId) {
		if (!floorIndex) {
			var floors = map.getFloors();
			if (!floors.length) return null;
			floorIndex = {};
			for (var i = 0; i < floors.length; i++) floorIndex[floors[i].mapId] = floors[i];
		}
		return floorIndex[mapId] || null;
	}

	// Floor component. In order:
	//   1. config.floorCodes[mapId] — explicit per-floor override;
	//   2. floorCodeSource 'shortName' (default — Daniel, MOO-598 2026-09-24:
	//      floor number only): Jibestream Floor.shortName ("43" at Mutual HQ),
	//      else the floor name with a "Level"/"Floor"/"Lvl"/"L"/"F" prefix
	//      removed only when a number follows ("Level 44" → "44", "Level -1"
	//      → "-1"; "Lobby" stays);
	//      floorCodeSource 'name': the Jibestream floor name as-is ("Floor 43").
	// A hyphen glued to a word prefix is a separator ("Lvl-5" → "5");
	// otherwise it is a minus sign ("L-1" → "-1").
	var FLOOR_PREFIX = /^\s*(?:(?:level|floor|lvl)-|(?:level|floor|lvl|l|f)\s*[.:]?\s*)(?=-?\d)/i;
	function floorCode(mapId) {
		if (mapId == null) return null;
		if (CFG.floorCodes && CFG.floorCodes[mapId] != null) return String(CFG.floorCodes[mapId]);
		var f = floorFor(mapId);
		if (!f) return null;
		var name = f.name ? String(f.name).trim() : '';
		if (CFG.floorCodeSource === 'name') return name || null;
		if (f.shortName != null && String(f.shortName).trim()) return String(f.shortName).trim();
		if (!name) return null;
		return name.replace(FLOOR_PREFIX, '').trim() || name;
	}

	// The space code inside the name ('namePrefix'): the first word that
	// contains a digit, wherever it sits — "17N11 Conference" → "17N11",
	// "23S14.05" → "23S14.05", "IDF 19N04" → "19N04". A word that glues a
	// label onto the code loses the label: "Dock Office1C14" → "1C14" (letters
	// with a lowercase before the first digit are a word, not a code prefix —
	// "B23.01" stays whole). "Women's Restroom" → null. Override with
	// config.spaceCodePattern (a regex string whose first capture group is
	// the code).
	function codeInName(name) {
		if (!name) return null;
		if (NAME_CODE) {
			var m = NAME_CODE.exec(String(name));
			return m && m[1] ? m[1] : null;
		}
		var words = String(name).split(/\s+/);
		for (var i = 0; i < words.length; i++) {
			var w = words[i].replace(/^[^\w]+|[^\w]+$/g, '');
			if (!/\d/.test(w)) continue;
			var glued = /^[A-Za-z]*[a-z][A-Za-z]*(\d.*)$/.exec(w);
			return glued ? glued[1] : w;
		}
		return null;
	}

	// The ServiceNow location in a Jibestream External ID (Frank, MOO-598
	// 2026-09-29): `key=value` pairs split by ";" — e.g.
	// "zoneId=123;servicenow=HQ, 43, 43C08C". The `servicenow=` value is the
	// FULL location string, sent as-is; everything else is ignored.
	// Key matched case-insensitively, spaces around "=" tolerated.
	var SN_KEY = CFG.serviceNowKey.trim().toLowerCase();
	function serviceNowValue(externalId) {
		if (externalId == null) return null;
		var pairs = String(externalId).split(';');
		for (var i = 0; i < pairs.length; i++) {
			var eq = pairs[i].indexOf('=');
			if (eq === -1 || pairs[i].slice(0, eq).trim().toLowerCase() !== SN_KEY) continue;
			var value = pairs[i].slice(eq + 1).trim();
			if (value) return value;
		}
		return null;
	}
	// A tapped item: its waypoint's External ID (per instance — Daniel: each
	// restroom of an amenity has its own), else the destination / amenity's.
	function itemLocation(sel) {
		return sel ? serviceNowValue(sel.waypointExternalId) || serviceNowValue(sel.externalId) : null;
	}
	// The entire floor: the floor's External ID (Frank, 2026-09-30).
	function floorLocation(mapId) {
		var f = floorFor(mapId);
		return f ? serviceNowValue(f.externalId) : null;
	}

	// Space component of the generated default → { code, via }. `via` says
	// where it came from (shown on the card): 'name' | 'namePrefix' | 'fallback'.
	//   1. config.spaceCodeSource — 'namePrefix' | 'name' | 'none';
	//   2. nothing found → missingCodePolicy: 'floor' (send floor only — Frank)
	//      | 'name' (use the display name) | 'deny' (block Continue).
	function spaceCode(sel) {
		if (!sel) return { code: null, via: null };
		var source = CFG.spaceCodeSource;
		var code = null;
		if (source === 'name') code = sel.name || null;
		else if (source === 'namePrefix') code = codeInName(sel.name);
		if (code) return { code: String(code), via: source };
		if (policy() === 'name' && sel.name) return { code: String(sel.name), via: 'fallback' };
		return { code: null, via: null };
	}
	function policy() { return CFG.missingCodePolicy; }

	// → { text, floor, codeMissing, whole }. The `servicenow=` value from the
	// map data when there is one (whole: true); otherwise the default Frank
	// asked for as a convenience only — "<building>, <floor>[, <code>]",
	// comma AND a space between components: "HQ, 44, 39E04" / "HQ, 44".
	function locationParts() {
		var sel = state.scope === 'space' ? state.selection : null;
		var whole = sel ? itemLocation(sel) : floorLocation(state.currentMapId);
		if (whole) return { text: whole, floor: null, codeMissing: false, whole: true };
		var floor = floorCode(sel ? sel.mapId : state.currentMapId);
		var code = sel ? spaceCode(sel).code : null;
		var parts = [CFG.building];
		if (floor) parts.push(floor);
		if (code) parts.push(code);
		return { text: parts.join(', '), floor: floor, codeMissing: !!sel && !code, whole: false };
	}

	function locationString() {
		return locationParts().text;
	}

	// ── ServiceNow URL ─────────────────────────────────────────────────────

	function buildTicketUrl(loc) {
		var sn = CFG.serviceNow;
		var vars = {};
		if (sn.extraVariables) for (var k in sn.extraVariables) vars[k] = sn.extraVariables[k];
		if (form.extraVariables) for (var k2 in form.extraVariables) vars[k2] = form.extraVariables[k2];
		vars[sn.locationVariable] = loc;
		var host = String(sn.host || '').replace(/\/+$/, '');
		return host + '/mesp'
			+ '?id=' + encodeURIComponent(sn.pageId)
			+ '&sys_id=' + encodeURIComponent(form.sysId)
			+ '&view=mobile'
			+ '&sysparm_variable_values=' + encodeURIComponent(JSON.stringify(vars))
			+ '&wext=1';
	}

	// ── Render ─────────────────────────────────────────────────────────────

	var KIND_LABEL = { space: 'Space', amenity: 'Amenity', waypoint: 'Point on the map', point: 'Spot on the floor' };

	// "Space" when the tap was inside the room; "Nearest space · 9 m from your
	// tap" when it snapped (the pin stays on the tap, the room is outlined).
	function kindLine(sel) {
		var label = KIND_LABEL[sel.kind] || sel.kind;
		if (sel.kind === 'point') return label;
		var m = sel.distanceMeters;
		if (m == null || m < 1) return label;
		return 'Nearest ' + label.toLowerCase() + ' · ' + Math.round(m) + ' m from your tap';
	}

	// The shown selection's display name (card title, pin note).
	function selectionName(sel) {
		if (sel.kind === 'point') {
			return (CFG.maxSnapMeters != null ? 'No space within ' + CFG.maxSnapMeters + ' m' : 'No space here') + ' — floor only';
		}
		return sel.name || (sel.kind === 'waypoint' ? 'Unnamed point' : 'Unnamed ' + sel.kind);
	}

	// Radios + map in step. The entire floor hides the pin and room outline
	// but keeps the selection, so switching back restores it.
	function setScope(scope) {
		state.scope = scope;
		var radios = els.form.querySelectorAll('input[name="scope"]');
		for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === scope;
		map.setSelectionVisible(scope === 'space');
	}

	// Inline icons (Material Icons paths) for the map banner.
	function icon(d) {
		return '<svg class="tp-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
	}
	var BANNER_ICON = {
		tap: icon('M9 11.24V7.5a2.5 2.5 0 0 1 5 0v3.74c1.21-.81 2-2.18 2-3.74C16 5.01 13.99 3 11.5 3S7 5.01 7 7.5c0 1.56.79 2.93 2 3.74zm9.84 4.63-4.54-2.26a1.4 1.4 0 0 0-.54-.11H13v-6c0-.83-.67-1.5-1.5-1.5S10 6.67 10 7.5v10.74l-3.43-.72a1.1 1.1 0 0 0-.24-.03c-.31 0-.59.13-.79.33l-.79.8 4.94 4.94c.27.27.65.44 1.06.44h6.79c.75 0 1.33-.55 1.44-1.28l.75-5.27c.01-.07.02-.14.02-.2 0-.62-.38-1.16-.91-1.38z'),
		pin: icon('M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z'),
		floor: icon('M3 5h2V3c-1.1 0-2 .9-2 2zm0 8h2v-2H3v2zm4 8h2v-2H7v2zM3 9h2V7H3v2zm10-6h-2v2h2V3zm6 0v2h2c0-1.1-.9-2-2-2zM5 21v-2H3c0 1.1.9 2 2 2zm-2-4h2v-2H3v2zM9 3H7v2h2V3zm2 18h2v-2h-2v2zm8-8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2zm0-12h2V7h-2v2zm0 8h2v-2h-2v2zm-4 4h2v-2h-2v2zm0-16h2V3h-2v2zM7 17h10V7H7v10zm2-8h6v6H9V9z'),
	};

	// What a tap does right now, over the map.
	function renderBanner() {
		if (!state.ready) { els.banner.hidden = true; return; }
		var whole = state.scope === 'floor';
		var f = whole ? floorFor(state.currentMapId) : null;
		var key = whole ? 'floor' : state.selection ? 'pin' : 'tap';
		var text = whole ? 'Entire ' + ((f && f.name) || 'floor') + ' selected · tap the map to pick a space instead'
			: state.selection ? 'Tap elsewhere to move your pin'
				: 'Tap the map to pick a space';
		els.banner.innerHTML = BANNER_ICON[key];
		var span = document.createElement('span');
		span.textContent = text;
		els.banner.appendChild(span);
		els.banner.classList.toggle('tp-banner-floor', whole);
		els.banner.hidden = false;
	}

	function render() {
		var sel = state.selection;
		var whole = state.scope === 'floor';
		var info = locationParts();

		els.empty.hidden = whole || !!sel;
		els.card.hidden = whole || !sel;
		els.floorCard.hidden = !whole;
		if (!whole && sel) {
			els.kind.textContent = kindLine(sel);
			els.name.textContent = selectionName(sel);
			els.floor.textContent = sel.floorName;
			// Show the code that will actually be SENT, and where it came from
			// when that isn't obvious.
			var sc = spaceCode(sel);
			var note = sc.via === 'fallback' ? ' (name — no code in map data)'
				: sc.via === 'name' ? ' (name)' : '';
			els.code.textContent = info.whole ? 'set in the map data'
				: sc.code == null ? (policy() === 'floor' ? 'none — floor only' : '—')
					: sc.code + note;
		}
		if (whole) {
			var f = floorFor(state.currentMapId);
			els.floorName.textContent = (f && f.name) || '—';
			els.building.textContent = CFG.building;
			els.pinNote.hidden = !sel;
			if (sel) els.pinName.textContent = sel.kind === 'point' ? 'your tap' : selectionName(sel);
		}

		// Validity + guidance. No code on the selected item → per
		// missingCodePolicy: 'floor' sends the floor only (Frank's rule),
		// 'deny' blocks Continue and asks for another space.
		var warning = '';
		var canContinue = state.ready;
		if (!whole) {
			if (!sel) {
				canContinue = false;
			} else if (info.codeMissing && policy() === 'deny') {
				canContinue = false;
				warning = 'This ' + (KIND_LABEL[sel.kind] || sel.kind).toLowerCase()
					+ ' has no space code in the map data. Tap a different space, or choose "The entire floor".';
			} else if (info.codeMissing && !info.floor) {
				canContinue = false;
				warning = 'This floor has no name or number in the map data — tap a different space.';
			}
		} else if (!info.whole && !info.floor) {
			canContinue = false;
			warning = 'Pick a floor on the map first.';
		}
		els.warning.textContent = warning;
		els.warning.hidden = !warning;

		els.location.textContent = canContinue ? info.text : !whole && !sel ? 'Pick a space on the map' : '—';
		els.location.classList.toggle('tp-location-empty', !canContinue);
		els.continueBtn.disabled = !canContinue;
		renderBanner();
	}

	// ── Wiring ─────────────────────────────────────────────────────────────

	els.form.addEventListener('change', function (e) {
		if (e.target && e.target.name === 'scope') {
			setScope(e.target.value);
			render();
		}
	});

	els.clear.addEventListener('click', function () {
		map.clearSelection(); // emits locationselect(null) → render()
	});

	els.usePin.addEventListener('click', function () {
		setScope('space');
		render();
	});

	els.form.addEventListener('submit', function (e) {
		e.preventDefault();
		if (els.continueBtn.disabled) return;
		var loc = locationString();
		var url = buildTicketUrl(loc);
		// Expose the last hand-off for debugging / the embedding page.
		window.MOO_TICKET_LAST = { ticket: TICKET, location: loc, url: url, selection: state.selection, dryRun: !!CFG.dryRun };
		if (CFG.dryRun) {
			// No `continue` message in dry run: an embedding page that navigates
			// on it would otherwise leave for ServiceNow while we only alert.
			console.log('[ticket-page] dryRun — would navigate to', url);
			alert('Dry run\n\n' + loc + '\n\n' + url);
			return;
		}
		var framed = window.parent !== window;
		if (framed) {
			try {
				window.parent.postMessage({ source: 'moo-ticket-page', type: 'continue', ticket: TICKET, location: loc, url: url }, TARGET_ORIGIN);
			} catch (err) { console.warn('[ticket-page] continue postMessage failed', err); }
		}
		// continueTarget 'none': the embedding page navigates on `continue`.
		if (CFG.continueTarget === 'none') return;
		// Replace (not push) so Back returns to the support page, not to this
		// picker with a stale selection — Frank: "loads / replaces that page".
		// Embedded ('auto'): replace the whole page — ServiceNow forms usually
		// refuse to load inside an iframe. Allowed cross-origin because this
		// runs on the user's click; falls back to the frame if the host's
		// sandbox forbids it.
		if (framed && CFG.continueTarget === 'auto') {
			try { window.top.location.replace(url); return; }
			catch (err) { console.warn('[ticket-page] top navigation blocked — opening in the frame', err); }
		}
		window.location.replace(url);
	});

	// Debug handle for the console / Frank's testing.
	window.MOO_TICKET_PAGE = {
		map: map,
		getSelection: function () { return map.getSelection(); },
		getLocation: locationString,
		getUrl: function () { return buildTicketUrl(locationString()); },
		setScope: function (scope) { setScope(scope); render(); },
		state: state,
	};

	setScope(state.scope); // defaultScope
	render();
})();
