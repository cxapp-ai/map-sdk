# @cxapp-ai/map-sdk

Standalone indoor-map SDK — the interactive map experience extracted from
nova-chat-sdk's map popup, minus the popup. Framework-agnostic (compiled;
Svelte is an internal detail), backend-agnostic (the host injects booking,
colleagues, images), Jibestream/JMap under the hood.

Features: canvas map with pan/zoom, teardrop pins, swipeable resource
carousel (Book / Navigate), floor switching, multi-stop wayfinding with
GPS/kiosk start and veer auto-reroute, live "you are here" GPS overlay,
colleague-avatar overlay.

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
| Environment | HTTPS (geolocation); CSP allowing `cdn.jibestream.com` (else veer-reroute silently degrades); a **sized** container at mount (0×0 errors) |

No backend endpoints are called by the SDK itself beyond Jibestream. Strings
(`strings`) and theme tokens (`theme`, `--map-*`) are optional overrides with
English/current-look defaults. Styles ship inside the JS bundles and
self-inject — there is no stylesheet to import.

Jibestream token/venue caches are keyed per config **including auth
identity** (the `getToken` callback / `clientId`), so remounting with
different credentials never reuses a previous user's token. The cache is
capped (oldest entries evicted) and a fresh `getToken` closure counts as a
new identity — hoist `getToken` to a stable reference to reuse the cache
across remounts. `clearJibestreamCaches()` (exported from both entries) is a
hard-reset escape hatch.

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
