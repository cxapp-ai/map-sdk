# @cxapp-ai/map-sdk

Standalone indoor-map SDK — the interactive map experience extracted from
nova-chat-sdk's map popup, minus the popup. Framework-agnostic (compiled;
Svelte is an internal detail), backend-agnostic (the host injects booking,
colleagues, images), Jibestream/JMap under the hood.

Features: canvas map with pan/zoom, teardrop pins, swipeable resource
carousel (Book / Navigate), floor switching, multi-stop wayfinding with
GPS/kiosk start and veer auto-reroute, live "you are here" GPS overlay,
colleague-avatar overlay.

## Distribution & install

**ESM-only.** The package ships ESM builds (`dist/map-sdk.js`, `dist/core.js`)
plus a self-contained IIFE global (`dist/map-sdk.iife.js`); there is no CJS
entry. Consume it from an ESM host (or the IIFE `<script>` for no-bundler
WebView shells).

The intended eventual distribution is a publish to the org's private npm
registry. **That has not happened yet**, so today `package.json` keeps
`"private": true` (a deliberate guard against an accidental public
`npm publish`). Until the registry publish lands, install from git:

```sh
npm install github:cxapp-ai/map-sdk#<ref>
```

A `"prepare": "npm run build"` script makes git installs work: the consumer's
`npm install` runs the build and produces `dist/` locally (`dist/` is
gitignored, so it is never committed — it is generated at install time).
When the org registry path opens, unset `private` and publish the prebuilt
`dist/` tarball instead; `prepare` remains harmless for source installs.

## Install & mount (bundler hosts)

```ts
import { mountIndoorMap } from '@cxapp-ai/map-sdk';

const map = mountIndoorMap(document.getElementById('map')!, {
  provider: {
    host: 'https://api.jibestream.com',
    customerId: 146,
    venueId: 2407,
    auth: { getToken: () => myBackend.mintJibestreamToken() }, // production
    // auth: { clientId, clientSecret },                       // dev only
  },
  resources: [
    { externalId: 12345, name: 'Room 4.02', type: 'room', floorName: 'L4',
      features: ['TV', 'Whiteboard'], bookingContext: { start, end } },
  ],
  focusResourceId: 12345,
  mode: 'container',            // or 'fullscreen'
  gps: true,
  booking: {
    onBook: async (resource, ctx) => {
      const r = await myBackend.book(resource, ctx);
      return { confirmed: r.ok, reservationId: r.id };
    },
  },
  on: {
    onResourceSelect: (r) => console.log('selected', r.name),
    onError: (e) => console.error(e.message),
  },
});

// later
map.setItinerary([12345, 67890]);
map.setFullscreen(true);
map.destroy(); // mandatory teardown
```

## Host integration recipes

The API is the same everywhere: `mountIndoorMap(container, options)` returns a
handle; you drive the map through the handle and tear it down with `destroy()`.
Only the *lifecycle wiring* differs per host.

**Golden rules (all hosts):**
1. **Mount once, keep the handle.** Do not call `mountIndoorMap` on every
   render / change-detection tick — the engine is expensive to build.
2. **Always `destroy()` on teardown** (route change, unmount, screen close). It
   stops the RAF projection loop, the geolocation watch, the auth-refresh timer,
   and the JMap controller. Skipping it leaks all of them.
3. **Drive changes through handle methods** (`setResources`, `setItinerary`,
   `setFloor`, `update`, …), never by remounting. (Note `setResources` and some
   `update()` fields are a full reload — see *Runtime updates & rebuild cost*.)
4. **The container must have a non-zero size before mount** (0×0 errors).

Every callback in `options.on` is ALSO a bubbling DOM CustomEvent on the
container — `mapsdk:ready`, `mapsdk:resourceselect`, `mapsdk:floorchange`,
`mapsdk:bookrequested`, `mapsdk:bookingstatechange` (pending/confirmed/failed),
`mapsdk:navigaterequested`, `mapsdk:fullscreenchange`, `mapsdk:selectionchange`,
`mapsdk:error` — payload in `event.detail`. The `selectionchange` detail (and
`getSelection()`) is a plain copy, safe to `structuredClone` / `postMessage`;
the other events hand back the resource as before (serialise it, e.g. with
`JSON.stringify`, before posting it). Web hosts can use either channel; native
WebView shells use the DOM-event channel (below).

### React

```tsx
import { useEffect, useRef } from 'react';
import { mountIndoorMap, type IndoorMapHandle } from '@cxapp-ai/map-sdk';

export function IndoorMap({ venueId, resources }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<IndoorMapHandle | null>(null);

  // Mount ONCE — empty deps. StrictMode double-invokes this in dev
  // (mount → destroy → mount); destroy() makes that safe.
  useEffect(() => {
    const map = mountIndoorMap(containerRef.current!, {
      provider: {
        host: 'https://api.jibestream.com',
        customerId: 146,
        venueId,
        auth: { getToken: () => api.mintJibestreamToken() },
      },
      resources,
      gps: true,
      on: {
        onResourceSelect: (r) => console.log(r.name),
        onError: (e) => console.error(e.message),
      },
    });
    mapRef.current = map;
    return () => { map.destroy(); mapRef.current = null; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Push prop changes through the handle. Guard so you only pay the
  // setResources reload when the set truly changes.
  useEffect(() => { mapRef.current?.setResources(resources); }, [resources]);

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
}
```

### Angular

```ts
import { Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { mountIndoorMap, type IndoorMapHandle } from '@cxapp-ai/map-sdk';

@Component({
  selector: 'indoor-map',
  standalone: true,
  template: `<div #host style="width:100%;height:100%"></div>`,
})
export class IndoorMapComponent implements OnInit, OnDestroy {
  @ViewChild('host', { static: true }) host!: ElementRef<HTMLDivElement>;
  private map?: IndoorMapHandle;
  constructor(private zone: NgZone, private api: Api) {}

  ngOnInit() {
    // Mount OUTSIDE Angular — the perpetual RAF loop would otherwise trigger
    // change detection ~60×/sec. Hop back into the zone inside callbacks.
    this.zone.runOutsideAngular(() => {
      this.map = mountIndoorMap(this.host.nativeElement, {
        provider: { host: 'https://api.jibestream.com', customerId: 146, venueId: 2407,
                    auth: { getToken: () => this.api.token() } },
        gps: true,
        on: { onResourceSelect: (r) => this.zone.run(() => this.select(r)) },
      });
    });
  }
  ngOnDestroy() { this.map?.destroy(); }
}
```

### Vue 3

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { mountIndoorMap, type IndoorMapHandle } from '@cxapp-ai/map-sdk';

const host = ref<HTMLDivElement>();
let map: IndoorMapHandle | undefined;

onMounted(() => {
  map = mountIndoorMap(host.value!, {
    provider: { host: 'https://api.jibestream.com', customerId: 146, venueId: 2407,
                auth: { getToken: () => api.token() } },
    gps: true,
    on: { onResourceSelect: (r) => console.log(r.name) },
  });
});
onBeforeUnmount(() => map?.destroy());
</script>

<template><div ref="host" style="width:100%;height:100%"></div></template>
```

### Plain JS / no bundler (`<script>` tag)

```html
<div id="map" style="position:fixed;inset:0"></div>
<script src="map-sdk.iife.js"></script>
<script>
  const map = MapSDK.mountIndoorMap(document.getElementById('map'), { /* same options */ });
</script>
```

### Native iOS / Android WebView

Ship a small HTML page that loads `map-sdk.iife.js`, mount the map, expose the
handle globally so native can call **in**, forward `mapsdk:*` events **out**,
and bridge `auth.getToken` to a native token mint. The page:

```html
<div id="map" style="position:fixed;inset:0"></div>
<script src="map-sdk.iife.js"></script>
<script>
  // (1) getToken bridge: JS asks native to mint a JACS token; native replies by
  //     calling window.__resolveToken(id, token, ttl). Correlate by request id.
  const pending = {};
  let seq = 0;
  window.__resolveToken = (id, accessToken, expiresInSeconds) =>
    pending[id]?.({ accessToken, expiresInSeconds });
  function getToken() {
    const id = ++seq;
    return new Promise((resolve) => {
      pending[id] = resolve;
      window.webkit?.messageHandlers?.mintToken?.postMessage({ id }); // iOS
      window.AndroidBridge?.mintToken?.(id);                          // Android
    });
  }

  // (2) Mount; keep the handle on window so native can call methods on it.
  const el = document.getElementById('map');
  const map = window.__map = MapSDK.mountIndoorMap(el, {
    provider: { host: 'https://api.jibestream.com', customerId: 146, venueId: 2407, auth: { getToken } },
    mode: 'fullscreen',
    gps: true,
  });

  // (3) Forward map events OUT to native.
  const forward = (e) => {
    const msg = JSON.stringify({ type: e.type, detail: e.detail });
    window.webkit?.messageHandlers?.mapEvent?.postMessage(msg); // iOS
    window.AndroidBridge?.onMapEvent?.(msg);                    // Android
  };
  ['mapsdk:ready','mapsdk:resourceselect','mapsdk:floorchange','mapsdk:bookrequested',
   'mapsdk:bookingstatechange','mapsdk:navigaterequested','mapsdk:fullscreenchange',
   'mapsdk:selectionchange','mapsdk:error']
    .forEach((t) => el.addEventListener(t, forward));
</script>
```

**iOS (WKWebView, Swift)** — register the `mintToken` + `mapEvent` handlers, and
call into the map with `evaluateJavaScript`:

```swift
// config.userContentController.add(self, name: "mintToken"); add(self, name: "mapEvent")
func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
  switch m.name {
  case "mintToken":
    let id = (m.body as! [String: Any])["id"] as! Int
    mintJACSToken { token in
      self.webView.evaluateJavaScript("window.__resolveToken(\(id), '\(token)', 3000)")
    }
  case "mapEvent":
    handleMapEvent(m.body as! String) // JSON { type, detail }
  default: break
  }
}
// Call in, e.g. switch floors:  webView.evaluateJavaScript("window.__map.setFloor(3)")
```

**Android (Kotlin)** — expose a `@JavascriptInterface` bridge and call in with
`evaluateJavascript`:

```kotlin
webView.addJavascriptInterface(object {
  @JavascriptInterface fun mintToken(id: Int) {
    mintJACSToken { token ->
      runOnUiThread { webView.evaluateJavascript("window.__resolveToken($id, '$token', 3000)", null) }
    }
  }
  @JavascriptInterface fun onMapEvent(json: String) { handleMapEvent(json) }
}, "AndroidBridge")
// Call in, e.g.:  webView.evaluateJavascript("window.__map.setFloor(3)", null)
```

Tear down by calling `window.__map.destroy()` before the WebView is
released. See the *Security & host caveats* below re: `cdn.jibestream.com`
(NavigationKit) — if your WebView enforces a CSP, either allow that origin or
mount with `autoReroute: false`.

## Runtime updates & rebuild cost

Most handle methods are cheap in-place operations (`setItinerary`, `setFloor`,
`focusResource`, `confirmBooking`, `setFullscreen`), and `update({ strings })`,
`update({ theme })`, and `update({ provider: { floorLabels } })` apply in place.

**But `update({ provider: { kioskCoordinate | venueBounds | venueCenter } })`,
and a `setResources(...)` that changes the resource set, perform a FULL engine
reload**: the JMap controller is destroyed and recreated,
floor/pin/pan/booking/selection state resets, `onReady` / `mapsdk:ready`
re-fires, venue data is re-fetched, and there is a ~1.3s settle before the map
is interactive. Treat these as a remount, not a patch — call `setResources`
once with the final set, and **batch** config changes into a single `update()`
to avoid stacking reloads.

`setResources` is signature-gated: only a change to the set of
`externalId|name` pairs rebuilds. Without a rebuild, what the SDK reads live
applies in place: `added` and `availability` (pin variants, unit fills),
`type` (what a tap may select), the card fields (`features`, `alreadyBooked`,
`capacity`, `image`, …) and the `resource` in selection payloads. Where a pin
goes is read only when the engine builds: `mapId`, `worldX`/`worldY` and
`buildingExternalId` (and `floorName`, the fallback floor label), so a change
to only those moves nothing until the next rebuild — a change to the
`externalId|name` set, or a remount.

## Floor selector and cards (opt-in)

Every option below defaults to the historical view: cards shown, one floor tab
per pinned floor (only when there is more than one), floors ordered by pin
count, the map opening on the floor with the most pins (or the focused
resource's floor). Hosts that pass none of them see no change.

```ts
const map = mountIndoorMap(el, {
  provider,
  resources,
  showCards: false,              // no card carousel (host renders its own list); default true
  showFloorSelector: true,       // true = always (even one floor), false = never; omitted = only when > 1 floor
  floorSelectorStyle: 'dropdown', // 'tabs' (default) | 'dropdown' (native picker + ‹ › buttons) | 'auto' (dropdown past 6 floors)
  floorOrder: 'building',        // 'pins' (default, most pins first) | 'building' (level → elevation → numeric shortName → mapId)
  allFloors: false,              // true = list every building floor, even without pins (implies 'building'; allows resources: [])
  initialFloor: 7659,            // Jibestream mapId to open on; ignored unless listed. Wins over focusResourceId's floor
  // initialFloor: { resource: 12345 }, // or: the floor that resource's pin is on (not selected)
});

map.getFloors();             // [{ mapId, name, shortName, level, hasPins }] in display order, current floorLabels applied
map.getResourceMapId(12345); // mapId of that resource's pin in the current build; null if none
```

`initialFloor` is read at (re)build. When it is set, a `focusResourceId` on
another floor is still selected (card + `resourceselect`), but the map stays on
`initialFloor` until the user switches. The `{ resource: externalId }` form
opens on the floor of that resource's pin without selecting it (no
`resourceselect`, no `selectionchange`); a resource that is unknown or has no
pin is ignored, and the map opens as if `initialFloor` were not set. The
dropdown keeps the `.rm-floor-select` class, so a host rule that hides the
floor selector still applies. `update()` cannot change these options —
remount instead.

`getResourceMapId(externalId)` returns the Jibestream mapId of the floor that
resource's pin is on in the current build (by host externalId, string or
number, as `focusResource`). It returns null when the resource has no pin,
while the map is building or rebuilding (before `ready`), and after `destroy()`.
A host with its own floor ids can use it to find the SDK's floor for one of its
resources, then call `setFloor(mapId)`.

## Keeping the view on resize (opt-in)

By default every non-zero container resize re-frames the current floor's pins,
which drops any pan, zoom or `focusResource()` centring. With
`keepViewOnResize: true` a resize only pans: the zoom stays and the world point
that was at the centre of the view stays at the centre.

```ts
mountIndoorMap(el, { provider, resources, keepViewOnResize: true }); // default false
```

- The first layout still frames the floor as without the option.
- A container that collapses to zero size and opens again (a sheet or drawer
  closing over the map) comes back to the view it had before it collapsed,
  including when it reports every size on the way down and up.
- A `focusResource()` or floor switch while the container has no size is
  framed once it opens again, for its final size.
- It is read at mount; `update()` cannot change it — remount instead.

## Selection, pins and availability (opt-in)

Defaults again reproduce the historical view: every pin drawn in the primary
colour, the selected pin enlarged (same colour), map taps ignored, no unit
styling, pin labels "Pin <name>". A host that passes none of the options or
fields below sees no change (the new `selectionchange` event fires, and older
hosts simply don't listen).

```ts
const map = mountIndoorMap(el, {
  provider,
  resources: [
    // added: draws the "added" pin (white plus) and keeps it visible under pins:'selected'
    // availability: fills the resource's unit polygon(s): 'free' | 'busy' | 'unavailable' (grey)
    { externalId: 12345, name: 'Room 4.02', type: 'room', added: true, availability: 'busy' },
  ],
  pins: 'selected',                 // 'all' (default) | 'selected' = selected pin + added resources only
  tapSelect: {                      // default off; true = every resource, no amenities
    selectable: ['room', 'amenity'], // MapResource.type values (case-insensitive) + 'amenity'; [] = nothing
    maxSnapMeters: 15,              // cap for "nearest"; default no cap
  },
  pinShape: 'material',             // 'teardrop' (default) | 'material' = the parent app's location_on pin
  availabilityColors: { free: '#00D302', busy: '#DF2E07', unavailable: '#c2c2c2' }, // hex only; these are the defaults
  theme: {
    '--map-pin-selected': '#1D2739', // selected pin body; default = the pin colour (--map-primary, #0070F0)
    '--map-pin-added': '#0070F0',    // added pin body; default #0070F0
  },
  strings: {                        // pin label state wording (defaults shown)
    pinAddedSuffix: ', added to the meeting', // `added` resources
    pinSelectedSuffix: ', selected',          // the selected pin, under tapSelect or pins:'selected'
  },
  on: { onSelectionChange: (sel) => console.log(sel?.kind, sel?.externalId, sel?.source) },
});

map.getSelection();   // MapSelection | null — a fresh plain copy
map.clearSelection(); // deselects; emits selectionchange(null) if something was selected
```

**Selection model.** There is one selected item: a host resource (its pin is
drawn selected) or, with `tapSelect`, a Jibestream amenity (a dark marker on
the amenity; it follows `--map-pin-selected` when set). Pin taps, card
taps/swipes, `focusResource()` and `focusResourceId` all set it.
`onSelectionChange` / `mapsdk:selectionchange` fires when a *different* item
becomes selected, and with `null` when the selection is cleared
(`clearSelection()`, selecting a resource that has no pin, a rebuild). An item
is a resource (by `externalId`) or an amenity at one location (amenity id +
waypoint), so moving from one restroom to another of the same amenity fires.
`onResourceSelect` keeps firing on every resource selection exactly as before.
After a rebuild the map selects its focus (`focusResource()` /
`focusResourceId`) again. With `tapSelect`, a pick on the map drops that
focus, so a rebuild after it leaves nothing selected; `clearSelection()`
drops it too.
Payload (`MapSelection`, plain JSON-safe data):

| Field | Meaning |
|---|---|
| `source` | `'map'` (user tapped the map, a pin or a card) or `'host'` (`focusResource` / `focusResourceId`) |
| `kind` | `'resource'` or `'amenity'` |
| `resource` | the CURRENT host resource (re-read from the live `resources` by externalId); null for an amenity |
| `externalId` | `resource.externalId` as a string (the Jibestream waypoint id); null for an amenity |
| `name`, `mapId`, `floorName` | display name, floor, current floor label (`floorLabels` win) |
| `worldX`, `worldY` | where the item is drawn (pin / amenity) |
| `tap` | `{ worldX, worldY, distanceMeters, inside }` for a canvas tap (`inside` = inside the room's polygon, `distanceMeters` null when the floor has no scale); null for pin, card and host selections |
| `jibestream` | `{ destinationId, amenityId, waypointId, name, description, externalId, category, keywords, properties, raw }` — what Jibestream has. `externalId` is the CMS externalId (NOT the host id), `properties` the CMS extensors, `raw` JSON copies of the destination / amenity / waypoint (and the tapped unit). Null when nothing resolves |

**Taps (`tapSelect`).** A tap outside the building — outside the floor's
Jibestream `Boundary` outline (one polygon per building on multi-building
maps; a floor without one falls back to the bounding box of its unit polygons)
— selects nothing. Inside, a tap resolves to (a) the innermost unit polygon
containing it that belongs to a selectable resource on the floor (matched by
the unit's destination ids or waypoint ids), else (b) the nearest selectable
resource pin or amenity within `maxSnapMeters`, else (c) nothing — the
selection stays as it was. A tap never recentres or zooms.
`focusResource()` / `focusResourceId` keep their behaviour (switch floor,
recentre + zoom, scroll the card). With `tapSelect`, a mount-time
`focusResourceId` also ends centred on its pin once the opening floor has
settled; without it the floor's opening frame still lands last, as before, so
the focused pin can end up off-centre. A tap on the focused room before then
keeps it centred; a tap that picks something else drops the focus and nothing
is re-centred (the opening floor's frame can still land after such an early
pick).

Taps are detected by the SDK from Pointer Events on the map, so they register
on pointerup (`selectionchange` follows within milliseconds — no double-tap
wait): one pointer, alone on the map, down and up within 1 s, moving at most
8 px. A longer move is a pan, a second finger on the map a pinch; neither
selects, and JMap's own drag, pinch and wheel handling is untouched. Only the
map's own pointers count, so a finger resting elsewhere on the page does not
block taps. A double-click is two taps on the same item (one
`selectionchange`). Without `tapSelect` no listener is added.

In this mode pins are not hit targets (`pointer-events: none`, as in the
parent app): a tap on a pin lands on the map and resolves by what is under it.
Pins stay focusable buttons — Enter / Space on a focused pin selects it in
place (`source: 'map'`, `tap: null`; a pin whose type isn't `selectable`
ignores it).

**Pin labels.** A pin whose resource has `added` gets `pinAddedSuffix` in its
`aria-label` ("Pin Room 4.02, added to the meeting"). Under `tapSelect` or
`pins: 'selected'` the selected pin also gets `pinSelectedSuffix` and
`aria-current="true"`. Without those options (and `added`) labels are
unchanged.

**Pin artwork (`pinShape`).** `'teardrop'` (default) is the SDK's pin: white
outline, and the selected pin grows and pulses. `'material'` draws every
resource pin and the amenity marker with the parent app's Material
`location_on` artwork: a 40 px box with the tip exactly on the point, a
`drop-shadow(0 1px 2px rgba(0,0,0,0.2))`, no outline, no halo, and no size
change when selected — the states differ by colour (the same tokens:
`--map-pin-selected`, `--map-pin-added`, `--map-primary`) and glyph (white dot;
white plus when `added`); the selected pin is still drawn on top.

**Availability.** Each resource with `availability` gets its unit polygon(s)
filled like the parent app (status colour, grey hairline, 50% opacity):
`'free'` green, `'busy'` red, `'unavailable'` the parent app's grey for spaces
that can't be booked (`#c2c2c2`, `availabilityColors.unavailable`). The fill is
all it changes: an unavailable resource is still drawn, listed and selectable
by tap. Changing `availability` through `setResources` repaints in place,
without a rebuild; removing it restores the venue style. Floors are painted as
JMap parses them, so nothing is loaded up front. Resources without a unit
polygon (desks drawn only as icons, explicit-coordinate pins) get no fill.

`pins`, `tapSelect`, `pinShape` and `availabilityColors` are read at mount;
`update()` cannot change them — remount instead.

**Types.** `IndoorMapHandle` gains `getFloors()`, `getResourceMapId()`,
`getSelection()` and `clearSelection()`, and `MapEventCallbacks` gains
`onSelectionChange`. Hosts that call `mountIndoorMap` and pass `on` (a
`Partial`) need no change; code that implements either interface itself (a
test double of the handle, a full callbacks table) has to add the new members.

## Engine-only (`/core`)

Hosts that want to draw their own overlays can skip the bundled UI:

```ts
import { createMinimap } from '@cxapp-ai/map-sdk/core';
const mm = await createMinimap({ container: el, cfg, resources, onViewChange });
const pt = mm.projectWorldToViewport(worldX, worldY); // {x, y} | null
```

## What the host must supply

| Thing | How |
|---|---|
| Jibestream identity | `provider.host/customerId/venueId` (+ `mapProfileId` for service accounts) |
| Jibestream auth | `provider.auth.getToken()` (server-minted, recommended) or dev-only client credentials |
| Resources | `resources[]` with waypoint `externalId`s (+ `buildingExternalId` on multi-venue campuses) |
| Booking (optional) | `booking.onBook()` — without it, Book buttons hide |
| Colleagues (optional) | `colleagues.fetch(startUnix, endUnix)` — without it, the toggle hides |
| Images (optional) | `images.load(path)` for auth-gated thumbnails; else plain URLs are used as-is |
| Navigation (optional) | `navigation.onNavigate()`; `cxaiNavigationPlugin()` ships for the legacy `window.__cxaicommand` bridge |
| Environment | HTTPS (geolocation); a **sized** container at mount (0×0 errors); see the NavigationKit / CSP note below re: `cdn.jibestream.com` |

No backend endpoints are called by the SDK itself beyond Jibestream. Strings
(`strings`) and theme tokens (`theme`, `--map-*`) are optional overrides with
English/current-look defaults. Styles ship inside the JS bundles and
self-inject — there is no stylesheet to import.

Jibestream token/venue caches are keyed per config **including auth
identity** (the `getToken` callback / `clientId`), so remounting with
different credentials never reuses a previous user's token. The cache is
capped (oldest entries evicted) and a fresh `getToken` closure counts as a
new identity — hoist `getToken` to a stable reference to reuse the cache
across remounts. **Caveat:** because the closure identity *is* the cache key,
a hoisted `getToken` that captures the current principal (user/tenant) must be
**recreated on login/logout** — otherwise a new principal reusing the same
closure reference reuses the previous principal's cached token. If you cannot
recreate the closure across a principal switch, call `clearJibestreamCaches()`
at the switch. `clearJibestreamCaches()` (exported from both entries) is a
hard-reset escape hatch.

## Security & host caveats

- **NavigationKit / third-party CDN (`autoReroute`).** With `autoReroute`
  (default **true**), the SDK injects a `<script>` from
  `https://cdn.jibestream.com/.../navigationkit.js` into `document.head` on the
  **first itinerary draw** — it is deferred, not loaded at mount, and pin-only
  mounts never fetch it. NavigationKit powers veer-detected auto-reroute during
  active wayfinding. Trust posture: the script is loaded **without SRI** and is
  handed the live map controller, so a compromise of the CDN origin is
  effectively XSS in every embedding host. **CSP:** if you allow this, your
  `script-src` must include `cdn.jibestream.com`; if your CSP does not allow
  it, the load fails and auto-reroute silently degrades (the map still works).
  **Opt out** with `autoReroute: false` to never contact the CDN — you keep
  wayfinding, you lose only veer auto-reroute. Prefer the opt-out (or a pinned,
  self-hosted, SRI-pinned copy) over blanket-allowing the origin.
- **Angular hosts:** the SDK runs a perpetual `requestAnimationFrame`
  projection loop. Mount inside `ngZone.runOutsideAngular(() => …)` (and hop
  back into the zone only inside your event callbacks) — otherwise every RAF
  tick triggers Angular change detection ~60×/sec.
- **DOM events cross shadow boundaries:** the `mapsdk:*` CustomEvents are
  dispatched `bubbles: true, composed: true`, so they escape shadow roots and
  carry `event.detail` (including your opaque `bookingContext`) to any
  ancestor listener up the composed tree. Do not put secrets in
  `bookingContext` if the mount lives inside a shared/embedded shadow DOM.
- **Image URLs are used verbatim as `<img src>`.** Resource/colleague `image`
  values (or whatever `images.load` returns) are set directly as `src` with no
  scheme allowlisting. Supply only trusted display URLs; treat these as a
  data-exfil surface (`url()`-style beacons) if you pass through
  attacker-influenced strings.
- **ESM-only:** there is no CJS build. See *Distribution & install* above.

## Repo layout

- `src/core/` — framework-free engine (`createMinimap`), Jibestream auth/venue data. No Svelte, no CSS.
- `src/ui/` — the compiled view layer (pins, carousel, floors, GPS, colleagues).
- `src/plugins/` — optional helpers (`cxaiNavigationPlugin`).
- `docs/REQUIREMENTS.md` — extraction analysis this repo was built from; `docs/DECISIONS.md` — binding v1 decisions.

## Build

```sh
npm install
npm run build    # dist/map-sdk.js + dist/core.js (ESM) + dist/map-sdk.iife.js (global);
                 # component CSS is inlined + self-injected (no separate .css file)
npm run check    # svelte-check
npm run dev      # demo app (demo/, needs VITE_JIBESTREAM_* creds — never commit secrets)
```

`jmap.js` is pinned **exactly** (4.14.1): the engine relies on undocumented
JMap internals; treat any bump as a breaking change and re-run the demo
smoke test against a live venue.

**jmap.js is a runtime `dependency`, not bundled into the ESM output.** It is a
webpack-UMD bundle of PixiJS that reassigns its own module exports at runtime;
bundling it into the ESM entry makes those exports getter-only and Pixi throws
`Cannot set property glCore … which has only a getter` on the second map mount.
So the ESM entries (`dist/map-sdk.js`, `dist/core.js`) emit `import('jmap.js')`
and your bundler transforms Pixi once (installed automatically as a dependency).
The IIFE global build **does** inline jmap.js — a no-bundler WebView host has
nothing to resolve a bare import against, and the IIFE format doesn't hit the
getter-only interop issue.
