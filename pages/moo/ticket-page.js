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

	var CFG = window.MOO_TICKET_CONFIG;
	var TICKET = document.documentElement.getAttribute('data-ticket') || 'facilities';

	var $ = function (id) { return document.getElementById(id); };
	var els = {
		title: $('tp-title'),
		hint: $('tp-hint'),
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
	var form = CFG.serviceNow && CFG.serviceNow.forms && CFG.serviceNow.forms[TICKET];
	if (!form || !form.sysId) {
		showError('No ServiceNow form configured for ticket type "' + TICKET + '" (serviceNow.forms.' + TICKET + ').');
		return;
	}
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
			selectable: CFG.selectable || ['space', 'amenity'],
			maxSnapDistance: CFG.maxSnapDistance,
		},
		// Mirror every mapsdk:* event to window.parent as
		// { source: 'map-sdk', type, detail } — for a support page that iframes
		// this picker. Harmless when the page is opened directly.
		postMessage: true,
		strings: { loadingMap: 'Loading floor plan…' },
		logger: console,
	});

	els.map.addEventListener('mapsdk:ready', function () {
		state.ready = true;
		if (state.currentMapId == null) {
			var floors = map.getFloors();
			if (floors.length) state.currentMapId = floors[0].mapId;
		}
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

	function floorFor(mapId) {
		var floors = map.getFloors();
		for (var i = 0; i < floors.length; i++) if (floors[i].mapId === mapId) return floors[i];
		return null;
	}

	// Floor component (Confluence example: "44"). In order:
	//   1. config.floorCodes[mapId] — explicit, use this for Mutual once the
	//      floor ids are known;
	//   2. Jibestream Floor.shortName — but JMap only keeps it when it is a
	//      NUMBER; a string like "L3" or "44" is dropped (null here);
	//   3. the floor name with a leading "Level"/"Floor"/"L"/"F" stripped
	//      ("Level 44" → "44", "L3" → "3"), else the name as-is.
	function floorCode(mapId) {
		if (mapId == null) return null;
		if (CFG.floorCodes && CFG.floorCodes[mapId] != null) return String(CFG.floorCodes[mapId]);
		var f = floorFor(mapId);
		if (!f) return null;
		if (f.shortName != null) return String(f.shortName);
		if (!f.name) return null;
		var stripped = String(f.name).replace(/^\s*(level|floor|lvl|l|f)\s*[-.:]?\s*(?=\S)/i, '').trim();
		return stripped || String(f.name);
	}

	// Space component: the Jibestream destination externalId (the venue's own
	// space code) by default. `spaceCodeSource: 'name'` uses the display name.
	function spaceCode(sel) {
		if (!sel) return null;
		var source = CFG.spaceCodeSource || 'externalId';
		var code = source === 'name' ? sel.name : sel.externalId;
		if (code == null || code === '') {
			// No code in Jibestream for this item. Policy (Frank: deny; Daniel:
			// fall back to the Jibestream name) is a config switch.
			var policy = CFG.missingCodePolicy || 'deny';
			if (policy === 'name' && sel.name) return sel.name;
			return null;
		}
		return String(code);
	}

	function locationParts() {
		var building = CFG.building || 'HQ';
		var mapId = state.scope === 'space' && state.selection ? state.selection.mapId : state.currentMapId;
		var floor = floorCode(mapId);
		var parts = [building];
		if (floor) parts.push(floor);
		if (state.scope === 'space') {
			var code = spaceCode(state.selection);
			if (code) parts.push(code);
		}
		return { parts: parts, floor: floor, code: state.scope === 'space' ? spaceCode(state.selection) : null };
	}

	function locationString() {
		// Confirmed format: comma AND a space between components — "HQ, 44, 39E04".
		return locationParts().parts.join(', ');
	}

	// ── ServiceNow URL ─────────────────────────────────────────────────────

	function buildTicketUrl(loc) {
		var sn = CFG.serviceNow;
		var vars = {};
		if (sn.extraVariables) for (var k in sn.extraVariables) vars[k] = sn.extraVariables[k];
		if (form.extraVariables) for (var k2 in form.extraVariables) vars[k2] = form.extraVariables[k2];
		vars[sn.locationVariable || 'location_on_floor_plan'] = loc;
		var host = String(sn.host || '').replace(/\/+$/, '');
		return host + '/mesp'
			+ '?id=' + encodeURIComponent(sn.pageId || 'my_mutual')
			+ '&sys_id=' + encodeURIComponent(form.sysId)
			+ '&view=mobile'
			+ '&sysparm_variable_values=' + encodeURIComponent(JSON.stringify(vars))
			+ '&wext=1';
	}

	// ── Render ─────────────────────────────────────────────────────────────

	var KIND_LABEL = { space: 'Space', amenity: 'Amenity', waypoint: 'Point on the map' };

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
			els.kind.textContent = KIND_LABEL[sel.kind] || sel.kind;
			els.name.textContent = sel.name || (sel.kind === 'waypoint' ? 'Unnamed point' : 'Unnamed ' + sel.kind);
			els.floor.textContent = sel.floorName + (floorCode(sel.mapId) && floorCode(sel.mapId) !== sel.floorName ? ' (' + floorCode(sel.mapId) + ')' : '');
			els.code.textContent = sel.externalId || '—';
		} else {
			els.empty.hidden = false;
			els.card.hidden = true;
		}

		// Validity + guidance. Frank: allow/deny the next action based on
		// whether the tapped space has a code.
		var warning = '';
		var canContinue = state.ready;
		if (state.scope === 'space') {
			if (!sel) {
				canContinue = false;
			} else if (!info.code) {
				canContinue = false;
				warning = 'This ' + (KIND_LABEL[sel.kind] || sel.kind).toLowerCase()
					+ ' has no space code in the map data. Tap a different space, or choose "Anywhere on this floor".';
			}
		} else if (!info.floor) {
			canContinue = false;
			warning = 'Pick a floor on the map first.';
		}
		els.warning.textContent = warning;
		els.warning.hidden = !warning;

		els.location.textContent = canContinue ? locationString() : '—';
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
		window.MOO_TICKET_LAST = { ticket: TICKET, location: loc, url: url, selection: state.selection };
		try {
			window.parent.postMessage({ source: 'moo-ticket-page', type: 'continue', ticket: TICKET, location: loc, url: url }, '*');
		} catch (err) { /* not embedded — ignore */ }
		if (CFG.dryRun) {
			console.log('[ticket-page] dryRun — would navigate to', url);
			alert('Dry run\n\n' + loc + '\n\n' + url);
			return;
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
