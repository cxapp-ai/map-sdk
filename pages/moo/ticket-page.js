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
 *   3. Build `location_on_floor_plan` = "<building>, <floor>, <space code>"
 *      (comma + space, per the MyMutual Ticketing Workflows Confluence page),
 *      or "<building>, <floor>" when the user picks "anywhere on this floor".
 *   4. "Continue to ticket" replaces this page with the ServiceNow form URL,
 *      passing the string in sysparm_variable_values.
 */
(function () {
	'use strict';

	// Defaults live HERE only; config.local.js overrides them (an explicit
	// `undefined` in the config means "use the default").
	//   floorCodeSource 'name', missingCodePolicy 'floor' — Frank, MOO-598
	//     2026-09-24 (floor name; no code → floor only).
	//   spaceCodeSource 'namePrefix' — OUR choice, pending Frank's OK: he
	//     asked for a property, but Mutual HQ has no code property (3 of 3826
	//     destinations carry any property), while 3824 of 3826 names start
	//     with the code. Set spaceCodeProperty when one exists, and
	//     spaceCodeSource 'none' to stop deriving codes from names.
	var DEFAULTS = {
		building: 'HQ',
		floorCodeSource: 'name',
		spaceCodeSource: 'namePrefix',
		missingCodePolicy: 'floor',
		selectable: ['space', 'amenity', 'point'],
		maxSnapMeters: 15,
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
	var SPACE_CODE_SOURCES = ['namePrefix', 'externalId', 'name', 'none'];
	if (SPACE_CODE_SOURCES.indexOf(CFG.spaceCodeSource) === -1) {
		showError('spaceCodeSource must be one of ' + SPACE_CODE_SOURCES.join(', ') + ' — check config.local.js.');
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
		scope: 'space',         // 'space' | 'floor'
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
		if (state.selection && state.scope === 'floor' && !CFG.keepScopeOnSelect) {
			// Tapping a space is a strong signal the issue is AT that space.
			setScope('space');
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
	//   2. floorCodeSource 'name' (default — Frank, MOO-598 2026-09-24): the
	//      Jibestream floor name as-is ("Floor 44" at Mutual HQ);
	//      floorCodeSource 'shortName': Jibestream Floor.shortName ("44") —
	//      the Confluence example format — else the floor name with a
	//      "Level"/"Floor"/"Lvl"/"L"/"F" prefix removed only when a number
	//      follows ("Level 44" → "44", "Level -1" → "-1"; "Lobby" stays).
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

	function propertyValue(sel, key) {
		if (!sel || !key || !sel.properties) return null;
		var v = sel.properties[key];
		return v == null || String(v).trim() === '' ? null : String(v).trim();
	}

	// Space component → { code, via }. `via` says where it came from (shown on
	// the card): 'property' | 'externalId' | 'name' | 'namePrefix' | 'fallback'.
	//   1. config.spaceCodeProperty — a Jibestream custom property key (Frank:
	//      "space code would be a property … make the key configurable");
	//   2. config.spaceCodeSource — 'namePrefix' | 'externalId' | 'name' | 'none';
	//   3. nothing found → missingCodePolicy: 'floor' (send floor only — Frank)
	//      | 'name' (use the display name) | 'deny' (block Continue).
	function spaceCode(sel) {
		if (!sel) return { code: null, via: null };
		var prop = propertyValue(sel, CFG.spaceCodeProperty);
		if (prop) return { code: prop, via: 'property' };
		var source = CFG.spaceCodeSource;
		var code = null;
		if (source === 'externalId') code = sel.externalId || null;
		else if (source === 'name') code = sel.name || null;
		else if (source === 'namePrefix') code = codeInName(sel.name);
		// 'none': only spaceCodeProperty supplies codes.
		if (code) return { code: String(code), via: source };
		if (policy() === 'name' && sel.name) return { code: String(sel.name), via: 'fallback' };
		return { code: null, via: null };
	}
	function policy() { return CFG.missingCodePolicy; }

	// The whole location string can come from one configured property (Frank:
	// "the configured space name should all come from a configured property,
	// but ok to generate it … if there is no configured property").
	// → { text, floor, codeMissing }. Format: comma AND a space between
	// components — "HQ, Floor 44, 39E04".
	function locationParts() {
		var sel = state.scope === 'space' ? state.selection : null;
		var whole = propertyValue(sel, CFG.locationProperty);
		if (whole) return { text: whole, floor: null, codeMissing: false };
		var floor = floorCode(sel ? sel.mapId : state.currentMapId);
		var code = sel ? spaceCode(sel).code : null;
		var parts = [CFG.building];
		if (floor) parts.push(floor);
		if (code) parts.push(code);
		return { text: parts.join(', '), floor: floor, codeMissing: !!sel && !code };
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

	function setScope(scope) {
		state.scope = scope;
		var radios = els.form.querySelectorAll('input[name="scope"]');
		for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === scope;
	}

	function render() {
		var sel = state.selection;
		var info = locationParts();

		if (sel) {
			els.empty.hidden = true;
			els.card.hidden = false;
			els.kind.textContent = kindLine(sel);
			els.name.textContent = sel.kind === 'point'
				? (CFG.maxSnapMeters != null ? 'No space within ' + CFG.maxSnapMeters + ' m' : 'No space here') + ' — floor only'
				: sel.name || (sel.kind === 'waypoint' ? 'Unnamed point' : 'Unnamed ' + sel.kind);
			var fc = floorCode(sel.mapId);
			els.floor.textContent = sel.floorName + (fc && fc !== sel.floorName ? ' (' + fc + ')' : '');
			// Show the code that will actually be SENT, and where it came from
			// when that isn't obvious.
			var sc = spaceCode(sel);
			var note = sc.via === 'fallback' ? ' (name — no code in map data)'
				: sc.via === 'name' ? ' (name)' : '';
			els.code.textContent = sc.code == null
				? (policy() === 'floor' ? 'none — floor only' : '—')
				: sc.code + note;
		} else {
			els.empty.hidden = false;
			els.card.hidden = true;
		}

		// Validity + guidance. No code on the selected item → per
		// missingCodePolicy: 'floor' sends the floor only (Frank's rule),
		// 'deny' blocks Continue and asks for another space.
		var warning = '';
		var canContinue = state.ready;
		if (state.scope === 'space') {
			if (!sel) {
				canContinue = false;
			} else if (info.codeMissing && policy() === 'deny') {
				canContinue = false;
				warning = 'This ' + (KIND_LABEL[sel.kind] || sel.kind).toLowerCase()
					+ ' has no space code in the map data. Tap a different space, or choose "Anywhere on this floor".';
			} else if (info.codeMissing && !info.floor) {
				canContinue = false;
				warning = 'This floor has no name in the map data — tap a different space.';
			}
		} else if (!info.floor) {
			canContinue = false;
			warning = 'Pick a floor on the map first.';
		}
		els.warning.textContent = warning;
		els.warning.hidden = !warning;

		els.location.textContent = canContinue ? info.text : '—';
		els.continueBtn.disabled = !canContinue;
	}

	// ── Wiring ─────────────────────────────────────────────────────────────

	els.form.addEventListener('change', function (e) {
		if (e.target && e.target.name === 'scope') {
			state.scope = e.target.value;
			render();
		}
	});

	els.clear.addEventListener('click', function () {
		map.clearSelection(); // emits locationselect(null) → render()
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
		if (window.parent !== window) {
			try {
				window.parent.postMessage({ source: 'moo-ticket-page', type: 'continue', ticket: TICKET, location: loc, url: url }, TARGET_ORIGIN);
			} catch (err) { console.warn('[ticket-page] continue postMessage failed', err); }
		}
		// Replace (not push) so Back returns to the support page, not to this
		// picker with a stale selection — Frank: "loads / replaces that page".
		window.location.replace(url);
	});

	// Debug handle for the console / Frank's testing.
	window.MOO_TICKET_PAGE = {
		map: map,
		getSelection: function () { return map.getSelection(); },
		getLocation: locationString,
		getUrl: function () { return buildTicketUrl(locationString()); },
		state: state,
	};

	render();
})();
