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

## Script-tag / WebView hosts (no bundler)

```html
<script src="map-sdk.iife.js"></script>
<script>
  const map = MapSDK.mountIndoorMap(document.getElementById('map'), { /* same options */ });
</script>
```

Every callback is also a bubbling DOM CustomEvent on the container —
`mapsdk:resourceselect`, `mapsdk:floorchange`, `mapsdk:bookrequested`,
`mapsdk:bookingstatechange` (booking lifecycle: pending/confirmed/failed),
`mapsdk:navigaterequested`, `mapsdk:fullscreenchange`, `mapsdk:ready`,
`mapsdk:error` — payload in `event.detail`. Native iOS/Android shells hosting
a WebView can bridge those without touching the bundle.

## Runtime updates & rebuild cost

Most handle methods are cheap in-place operations (`setItinerary`, `setFloor`,
`focusResource`, `confirmBooking`, `setFullscreen`), and `update({ strings })`,
`update({ theme })`, and `update({ provider: { floorLabels } })` apply in place.

**But `setResources(...)` and `update({ provider: { kioskCoordinate | venueBounds | venueCenter } })` perform a FULL engine reload**: the JMap
controller is destroyed and recreated, floor/pin/pan/booking/selection state
resets, `onReady` / `mapsdk:ready` re-fires, venue data is re-fetched, and
there is a ~1.3s settle before the map is interactive. Treat these as a
remount, not a patch — call `setResources` once with the final set, and
**batch** config changes into a single `update()` to avoid stacking reloads.

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
