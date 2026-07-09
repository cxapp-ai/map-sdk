# Requirements Analysis: Extracting the Indoor-Map Experience into a Standalone Map SDK

Scope: the **content** of the fullscreen map popup (`ResourceMinimap.svelte` in `dialogMode` plus its engine), not the modal/portal chrome. Audience: the developer doing the extraction.

---

## 1. What's inside the popup today

The popup is `ResourceMinimap.svelte` itself — the chat host has **no modal wrapper**; `NovaChatSDK.svelte:2145-2152` mounts one `ResourceMinimap` with `{resources, dialogMode: true, focusExternalId, onDialogClose}` and nothing else. The component orchestrates a framework-free JMap engine (`createMinimap` in `src/utils/jibestream-minimap.ts`) rendering a canvas map, and layers **HTML overlays** on top, absolutely positioned via per-frame world→viewport projection driven by the engine's `onViewChange` callback (`ResourceMinimap.svelte:595-606, 2132-2157`). The modal chrome to discard is: `.rm-modal` fixed-inset wrapper (`:2667-2677`), backdrop (`:2678-2686`), close button (`:2035-2039`), body-portal action (`:45-53, 2032`), Escape/focus handling (`:720-739`), and `dialogMode`/`onDialogClose` wiring (`:1140-1149`). Everything inside `.rm-modal-canvas-wrap` plus the floor strip (`:2040-2093`) is the extractable experience.

Feature list of the maximized view:

- Teardrop pin overlays, reprojected every frame (`:2132-2157`); pan/zoom is JMap's own gesture handling — no zoom buttons, legend, or search box.
- Swipeable resource **carousel** as the detail UI (there is no floating pin popup — `:1254-1257, 2738-2743`): thumbnail, name, floor/building, tenant suite/address, top-3 features, Book button, Navigate button (`:2206-2323`). Custom pointer-drag with synthesized-click suppression (`:1396-1575`).
- Floor tab strip with loading overlay during switch (`:2185-2201, 510-549`).
- Live-GPS "you are here" dot with pulse halo + off-venue "Xm away" distance chip (`:2098-2130, 859-947`); route-start hollow-ring marker distinct from the GPS dot (`:2112-2121, 2375-2389`).
- Multi-stop wayfinding: ordered itinerary by `externalId`, numbered stop labels (canvas-drawn by the engine), GPS-origin start with entrance snapping and kiosk/floor-centre fallback, path-type restriction prop (a documented no-op in jmap.js v4 — `jibestream-minimap.ts:1427-1441`), NavigationKit veer-detected auto-reroute (`:1836-1947, 1779-1792`).
- **Route-forced native dot** (missed in early analysis): while an itinerary is active, the DIY HTML dot is suppressed and JMap's native dot is used; a falling-edge `$effect` clears it on route end (`:1953, 1955-1970, 2007, 2045`).
- Colleague-avatar overlay (maximized only): toggle button, lazy fetch, per-floor filtering, photo with initials fallback (`:281-298, 988-1138, 2159-2183`).
- Unresolved-pin count badge (`:2008-2010`); booking-state badge (`Booked/Booking…/Try again`) pinned to the booked card with 30s timeout (`:310-345, 2280-2295`).

## 2. Dependency map

### Files (approx line counts, measured)

| File | Lines | Role | Chat-coupled? |
|---|---|---|---|
| `src/components/ResourceMinimap.svelte` | 3000 | Overlay/carousel/GPS/itinerary orchestration + modal chrome | Yes (contexts, i18n, auth store) |
| `src/utils/jibestream-minimap.ts` | 1839 | JMap engine wrapper (`createMinimap`) — no Svelte, no CSS, no chrome | 4 imports only |
| `src/utils/jibestream.ts` | 306 | JACS auth/token cache, `loadVenue`, `resolveDestination`, `JibestreamConfig` | 2 lines (logger, `clearVenueIdCache`) |
| `src/utils/jibestreamConfig.ts` | 91 | meetingId → venueId resolver | Yes (auth store) |
| `src/utils/jmap-js.d.ts` | 1 | `declare module 'jmap.js';` — all real typing is inline in jibestream-minimap.ts | No |
| `src/services/colleagues.ts` | 134 | Colleague overlay data + `colorForName`/`initialsForColleague` | Yes (auth store) |
| `src/services/booking.ts` | 86 | `buildBookingPrompt` — pure string builder, no I/O | Prompt encodes Bond behavior |
| `src/services/resourceLookup.ts` | 293 | booking → waypointId hydration (runs card-side, *before* popup opens) | Yes (auth store) |
| `src/utils/booking.ts` | 225 | `BookingItem` helpers + `buildShowOnMapPayload` (the input contract) | No (imports calendar.ts) |
| `src/utils/resourceImage.ts` | 74 | Auth-gated `/files/` image → objectURL, 100-entry LRU | Yes (auth store) |
| `src/utils/cxai-command.ts` | 111 | `window.__cxaicommand` native bridge, `p_live_map` deeplinks | Self-contained |
| `src/utils/calendar.ts` / `wxsuperappJson.ts` / `initials.ts` | 60/20/4 | Dependency-free helpers | No |
| `src/i18n/strings.ts` + `index.ts` | 336+20 | ~20 map string keys under `strings.minimap`/`resource`/`booking`/`common` | Context-installed, EN fallback |

### npm deps
- `jmap.js ^4.14.1` — the **only runtime dependency** (`package.json:42`), lazily `import('jmap.js')`-ed (`jibestream-minimap.ts:329-337`), so it code-splits.
- `svelte ^5` — peer dep only.

### Network endpoints
- **Jibestream JACS** (`cfg.host`, default `https://api.jibestream.com`): `POST /JACS/api/auth/token` (client_credentials or short-circuited to host token, `jibestream.ts:182-198`, `jibestream-minimap.ts:283-323`); `GET /JACS/api/customer/{cid}/venue/{vid}/full` (`jibestream.ts:256`); all JMap-internal GETs, with `?mapProfileId=N` injected by a custom request fn (`jibestream-minimap.ts:265-325`).
- **CDN (not npm)**: `https://cdn.jibestream.com/web/plugins/navigationkit/v1.2.0/navigationkit.js` — UMD onto `window.NavigationKit`, entitlement-gated, script-injected (`jibestream-minimap.ts:347-373`). CSP-restricted hosts silently lose veer detection.
- **wxsuperapp / CX backend** (via `apiBase()` + `getWxSuperAppHeaders()`): `GET /m/spaces/colleagues/sharing/v3` (colleague overlay, `colleagues.ts:59-62`); `GET /m/spaces/maps/v3?meetingId=` (venue resolution, `jibestreamConfig.ts:74-75`); `GET /m/spaces/map/v3` (resource lookup, `resourceLookup.ts:141-163`); `GET /files/*` (images, `resourceImage.ts:63`).
- Browser: `navigator.geolocation.watchPosition` (HTTPS required, `ResourceMinimap.svelte:1683-1777`).

### Credentials/config
- `JibestreamConfig` (`jibestream.ts:19-71`): `host`, `customerId`, `venueId`, `mapProfileId?`, and **either** `clientId`+`clientSecret` (secret ships in bundle) **or** `getToken(): Promise<{accessToken, expiresInSeconds}>` (server-minted). Presentation extras: `floorLabels`, `kioskCoordinate`, `venueBounds`, `venueCenter`.
- Env-baked `DEV_CONFIG` fallback: `VITE_JIBESTREAM_*` vars, defaults customerId=146, venueId=2407 San Ramon (`jibestream.ts:90-99`). **`app/.env.local` commits a live client secret for the demo venue.**
- wxsuperapp header set: `cx-token/cx-user-id/cx-user-email/cx-meeting/cx-device-*`, including the desktop→iOS spoof workaround (`auth.svelte.ts:134-159`).

## 3. Couplings to break

| # | Where | What it does | Strategy |
|---|---|---|---|
| 1 | `getContext('nova-jibestream-config')` — `ResourceMinimap.svelte:68-100`, set at `NovaChatSDK.svelte:262-269` | Delivers `JibestreamConfig` (merged DEV_CONFIG < prop < `getJibestreamToken`) via reactive context getter | **Config option.** `createMinimap` already accepts `cfg` directly (`jibestream-minimap.ts:422`); make it a required constructor arg. Preserve reactivity (host may fetch `floorLabels` after mount). |
| 2 | `getContext('nova-send-bond-text')` + `buildBookingPrompt` — `ResourceMinimap.svelte:62-66, 1592-1644`; `services/booking.ts:32` | Book button sends a hidden NL prompt into the Bond conversation, not a REST call | **Inject as callback** `onBook(resource, bookingContext) => Promise<BookResult>`. Keep the single-flight/30s-timeout state machine (`:310-345`); drop the prompt template (it encodes Bond agent behavior). |
| 3 | `getContext('nova-on-booking-confirmed')` — `ResourceMinimap.svelte:346-373`, fed by `NovaChatSDK.svelte:1444-1463` | Flips Book→Booked when a `booking-created` tool_result arrives, matched by externalId then name | **Fold into the `onBook` promise result**; optionally keep a `confirmBooking(externalId)` imperative method for async confirmation flows. |
| 4 | `getMeetingId()` from `src/stores/auth.svelte.ts` — `ResourceMinimap.svelte:39, 386-396` | Campus-id fallback when `resources[].bookingContext.meetingId` missing; feeds venue resolution and colleague overlay | **Config option** `meetingId?: string`. |
| 5 | `resolveVenueIdForMeeting` import — `jibestream-minimap.ts:27, 627-634` → `jibestreamConfig.ts:20` → auth store | Venue tier 2: meetingId → venueId via wxsuperapp `GET /m/spaces/maps/v3` | **Optional module** behind an injected `{ apiBase, headers }` provider — or drop and require `cfg.venueId` / `resources[].buildingExternalId`. Note (audit): current chat producers never populate `buildingExternalId` on find_available payloads (`ResourceCard.svelte:337-353`), so tier 2 is the live path today. |
| 6 | `MinimapResource` type from `components/registry.ts:97-127` and `ColleagueBooking` from `services/colleagues.ts` — `jibestream-minimap.ts:29-30` | Type-only imports; engine reads only `externalId, name, buildingExternalId, floorName, buildingName` | **Move the types into the map SDK** as its canonical contract. |
| 7 | `fetchColleagueBookings` — `ResourceMinimap.svelte:281-284, 1120`; `colleagues.ts:8` (auth store) | Colleague overlay data (`/m/spaces/colleagues/sharing/v3`) | **Optional plugin**: accept an injected `fetchColleagues(startUnix, endUnix)` provider; keep `colorForName`/`initialsForColleague` (pure). Preserve the drop-if-no-externalId rule (`colleagues.ts:76-78`). |
| 8 | `loadResourceImage` — `ResourceMinimap.svelte:294-298, 1069-1084`; `resourceImage.ts:5` (auth store) | Auth-gated `/files/` thumbnails + avatars (avatars need `files/` prefix added) | **Inject** `loadImage(path) => Promise<string|null>`; default = plain `<img src>` passthrough. |
| 9 | `hasCxaiCommand()/requestNavigation()` — `ResourceMinimap.svelte:40, 1151-1252`; `utils/cxai-command.ts` | Navigate button deeplinks to native `p_live_map` via `window.__cxaicommand` (note: `__cxaicommand`, not `window.cxai`); popup deliberately omits `floorId` from the payload (`:1160-1173`) | **Optional module** — `cxai-command.ts` is self-contained; gate the Navigate button on an injected `onNavigate` or the bridge. **Strip the `[nova:navdebug]` console probes (`:1164-1252`) — not dev-gated.** |
| 10 | `useStrings()` — `ResourceMinimap.svelte:38, 58`; keys listed in `strings.ts:98-132` | All UI text via Svelte context, EN fallback | **Config option** `strings?: Partial<MapStrings>` (~20 keys). Already degrades gracefully to EN (`i18n/index.ts:19`). |
| 11 | `--chat-*` CSS vars (34 usages) | Theme tokens | **Audit correction — mostly a non-coupling for the popup**: the dialog is portaled to `document.body` (`:45-53, 2032`) while vars live only on the `.nova-chat-sdk` root (`NovaChatSDK.svelte:164, 2025`), so **the popup already renders on hardcoded fallbacks today** (every usage has one). Extraction: rename to `--map-*` with the current fallbacks as defaults; no injection required to reproduce today's look. |
| 12 | Portal-to-body + Escape + focus restore + input-blur — `:42-53, 720-739, 1794-1802` | Chat-specific chrome (escapes GenUI transformed ancestor; blurs chat input on touch) | **Drop.** The SDK renders into a host container. No body scroll-lock exists today (audit) — hosts wanting fullscreen own that. |
| 13 | `logger.js` + `window._jibDiag` — `jibestream.ts:11, 140-143`; `clearVenueIdCache` import at `jibestream.ts:12` | SDK logger, debug hook, cache-invalidation tie to wxsuperapp resolver | Replace with injectable/no-op logger; sever the `clearVenueIdCache` line (only called in `clearJibestreamCaches`, `:223`). |
| 14 | `DEFAULT_VENUE_CENTER` San Ramon — `ResourceMinimap.svelte:80-92` | Last-resort distance-chip anchor | **Drop the hardcode**; require `venueCenter`/`venueBounds` for the away chip, else hide it. |
| 15 | `resolveBookingResource` — `resourceLookup.ts:216-293` (used by `BookingConfirmation.svelte:92`, *not* by the popup) | Hydrates missing externalId before the popup opens | **Out of core**; ship as optional helper with injected fetch, or document that callers must supply waypoint externalIds. |

## 4. Proposed SDK surface

**Package**: `@cxapp-ai/indoor-map-sdk` (sibling repo following the nova-chat-sdk raw-source template).

```ts
import { mountIndoorMap } from '@cxapp-ai/indoor-map-sdk';

const map = mountIndoorMap(container: HTMLElement, {
  // required
  jibestream: JibestreamConfig,            // host, customerId, venueId, mapProfileId?,
                                           // getToken() XOR clientId/clientSecret,
                                           // floorLabels?, kioskCoordinate?, venueBounds?, venueCenter?
  resources: MapResource[],                // externalId = Jibestream waypointId (required per pin),
                                           // name, type, buildingName, floorName, buildingExternalId?,
                                           // suite?, address?, features?, image?, capacity?,
                                           // alreadyBooked?, reservationId?, bookingContext?

  // optional core
  focusExternalId?: string | number,
  itinerary?: Array<string|number>,        // + itineraryStyle, itineraryShowStopNumbers,
                                           //   itineraryStartFromMapCenter, itineraryPathType
  gpsAccuracyThresholdM?: number,          // default 30
  useNativeUserDot?: boolean,
  strings?: Partial<MapStrings>,           // EN default
  theme?: Partial<MapTheme>,               // --map-* tokens, defaults = today's fallback palette
  logger?: MapLogger,
});

map.setResources(rs); map.setItinerary(ids); map.setFloor(mapId);
map.confirmBooking(externalId);            // async booking confirmation hook
map.destroy();                             // mandatory (RAF loop, ResizeObserver, JMap, auth timer)
```

**Events/callbacks**: `onResourceSelect(resource)`, `onFloorChange(mapId)`, `onError(err)`, `onClose?` (only if the host asks the SDK to render its own chrome — default: no chrome).

**Optional plugins** (each undefined-guarded, degrading exactly as today):
- **Booking-from-pin**: `booking: { onBook(resource, ctx) => Promise<{confirmed: boolean}> }` — replaces the Bond hidden-prompt + confirmation-subscription pair. Without it, Book buttons hide.
- **Colleague overlay**: `colleagues: { fetch(startUnix, endUnix) => Promise<ColleagueBooking[]> }` — replaces `fetchColleagueBookings`. Without it, the toggle hides.
- **Live GPS**: `gps: boolean | { accuracyThresholdM }` — geolocation watch is already self-contained; keep the route-forced-native-dot switchover (`:1953-1970`).
- **Native navigation**: `onNavigate(resource)` or auto-detect `window.__cxaicommand` (keep `cxai-command.ts` as an opt-in module).
- **Image loader**: `loadImage(path)` for auth-gated thumbnails/avatars.
- **wxsuperapp resolvers** (`resolveVenueIdForMeeting`, `resolveBookingResource`): separate entry point `@cxapp-ai/indoor-map-sdk/cx-backend` taking `{ apiBase, headers }`.

**Required vs optional summary**: required = container, `jibestream` config, `resources` with waypoint externalIds. Everything else optional. Venue targeting must stay per-resource (`buildingExternalId`) — a campus spans multiple venues (`jibestreamConfig.ts:10-18`).

## 5. Packaging & build requirements

Today nova-chat-sdk ships **raw `.ts`/`.svelte` source**: `main`/`svelte`/`exports` all point at `./index.ts`, no dist, no build step, `svelte ^5` peer dep, consumer's Vite compiles it (`package.json:5-13`; `app/vite.config.ts` aliases the package to repo root). `jmap.js` is a dynamic import so it chunks separately; NavigationKit is CDN-injected UMD.

Options:
1. **Svelte-5 raw-source library (same template)** — zero build work, but restricts consumers to Svelte-5 + Vite-compatible bundlers and requires them to handle `.png` asset imports (`assets/assets.d.ts`).
2. **Custom element** (`svelte:options customElement`) — framework-agnostic, but the component leans on Svelte context replacement, per-frame overlay projection, and slots of overlay snippets; shadow DOM complicates the portal-free fullscreen mode and `--map-*` theming.
3. **Framework-agnostic wrapper**: ship `jibestream-minimap.ts` + `jibestream.ts` as a pure TS core (they already are — no Svelte, no CSS) and precompile the Svelte view layer to a `mountIndoorMap(container, opts)` JS API via `svelte-package`/Vite lib mode.

**Recommendation: option 3.** The codebase already has the seam — the engine is framework-free (`jibestream-minimap.ts` header, `:1-14`) and only the overlay/carousel layer is Svelte. Publish two entry points: `/core` (engine + config/auth, TS-only, for hosts that draw their own overlays via `projectWorldToViewport`) and the default compiled `mountIndoorMap` UI. Requirements either way: replace `import.meta.env` reads (`jibestream.ts:73, 90-99`) with config-only (env access is Vite-specific and bakes secrets); ship `src/utils/jmap-js.d.ts` (jmap.js publishes no types); inline the 3 placeholder PNGs as data URIs; keep `jmap.js` a dynamic import. Known fragility: heavy reliance on undocumented JMap internals (`control.stage`, `mapObj._.size`, `_getParsedMapView`, auth shim `_: ['','']` — `jibestream-minimap.ts:929-1310, 146-163`) means the SDK should pin `jmap.js` exactly, not `^`.

## 6. Data & auth requirements

A consumer must supply:

1. **Jibestream identity**: `host`, `customerId`, `venueId` (+ `mapProfileId` for service accounts without a default profile — omitting it 401s with "Map profile query param must be present", `jibestream.ts:23-28`).
2. **Jibestream auth, one of**: (a) `getToken(): Promise<{accessToken, expiresInSeconds}>` — server-minted, secrets stay server-side (auth shim `buildHostTokenAuth`, `jibestream-minimap.ts:95-171`); or (b) `clientId`+`clientSecret` — ships in bundle, dev only. Token cache is a module-level singleton not keyed by cfg (`jibestream.ts:115`) — one credential set per page unless fixed during extraction.
3. **Resources**: array where `externalId` is a numeric **Jibestream waypointId**; `buildingExternalId` (= the building's Jibestream venueId) for multi-building campuses; display fields (`name`, `floorName`, `buildingName`, `suite`, `address`, `features`, `image`) as desired. Entries without `externalId` can't be pinned.
4. **Presentation config (optional)**: `floorLabels` (mapId→label), `kioskCoordinate` ({mapId,x,y} wayfinding fallback start), `venueBounds` (at-venue test), `venueCenter` (distance-chip anchor — no more San Ramon default).
5. **Per-plugin**: booking callback; colleague fetcher (unix-seconds window); authenticated image loader for `/files/` paths; `meetingId` only if the wxsuperapp resolver module is used (then also `{ apiBase, headers }` with the `cx-*` header set incl. the iOS spoof, `auth.svelte.ts:148-159`).
6. **Environment**: HTTPS (geolocation); CSP allowance for `cdn.jibestream.com` (or accept veer-detection degrading to false); a **sized** container at init — JMap errors on 0x0 rect (`ResourceMinimap.svelte:574-589`).

## 7. Effort & risks

**Phase 1 — Core lift (low risk, ~days)**: new repo; move `jibestream-minimap.ts`, `jibestream.ts`, `jmap-js.d.ts`; sever logger + `clearVenueIdCache` lines; replace `DEV_CONFIG` env-baking with required config; move `MinimapResource`/`ColleagueBooking` types in. Engine is already chat-free — this is mostly mechanical.

**Phase 2 — View layer (the real work, ~1-2 weeks)**: fork `ResourceMinimap.svelte`; delete modal chrome/portal/Escape/blur-on-mount; convert the 3 contexts + auth-store reads into constructor options/callbacks; collapse the inline-vs-maximized duplicated state (positions, `userWorld`, `cardRefs` — `:222-231`) to a single view; rename CSS vars to `--map-*` with current fallbacks as defaults; strip navdebug logging; build `mountIndoorMap` wrapper + compiled output. Preserve the timing invariants: tick + 2×RAF size check (`:574-589`), 700ms settle re-projection (`:494-500, 667-682`), `MAP_SETTLE_MS=600` (`jibestream-minimap.ts:61`), reprojection-only-after-`setFloor` (`:966-990`), `pendingRecenterAfterSwitch` race handling (`:1326-1372`), route-framing-once-per-signature (`jibestream-minimap.ts:895-900`), and the z-index ladder (`:2354-2777`).

**Phase 3 — Plugins + backfill (~1 week)**: booking/colleagues/GPS/navigate/image-loader plugins; optional `cx-backend` resolver module; then refit nova-chat-sdk to consume the new SDK (adapters from its contexts to the callbacks) so the code isn't duplicated long-term.

**Biggest risks**:
1. **JMap private-API fragility** — the engine reads undocumented internals throughout; any `jmap.js` upgrade can break framing, labels, floor sizing, and the auth shim. Pin exactly; add a smoke test against a live venue.
2. **Booking semantics change** — replacing the Bond NL-prompt flow with a callback moves booking responsibility to the host; the confirmation matching (externalId → name fallback, `:347-373`) has no equivalent unless the host's booking API returns something matchable.
3. **Module-level singletons** — token cache, venue cache, `sharedLastFix` GPS cache (`ResourceMinimap.svelte:1-15`) assume one config per page; multi-instance/multi-venue hosts will hit contention unless caches are keyed during extraction.
4. **NavigationKit CDN** — not on npm, entitlement-gated, breaks under strict CSP; must be explicitly optional.
5. **Data provenance** — outside the chat, nothing hydrates waypoint externalIds (`resolveBookingResource`) or backfills `meetingId`; consumers with sparse booking data lose "show on map" capability unless the cx-backend module ships. Also note the second producer path: host-side TenantCard flows resolve `externalId` via `loadVenue`/`resolveDestination` by name (`index.ts:16-19`) — the SDK should keep exporting that data layer, and it's the only current source of `suite`/`address` (no chat producer populates them).

## 8. Open questions for the user

1. **Booking-from-pin in v1?** It's the deepest coupling (Bond prompt + confirmation feed). If the standalone SDK's first consumers don't book from the map, ship it as a later plugin and cut ~30% of the extraction risk.
2. **Who mints Jibestream tokens for standalone consumers?** If every consumer has a backend that can mint (getToken mode), the client_credentials path can be dev-only and the committed demo secret rotated/removed.
3. **Must the SDK support non-Svelte hosts (React/native WebView) in v1?** Decides compiled-`mountIndoorMap` (recommendation) vs raw-source Svelte library — raw source is a day cheaper but locks consumers to Svelte 5 + Vite.
4. **Does the SDK own a fullscreen mode at all**, or is it strictly "render into my container" (host owns chrome, scroll-lock, close)? The audit confirmed there's no body scroll-lock today, so fullscreen-in-SDK would need new work either way.
5. **Is the wxsuperapp resolver module (meetingId→venueId, booking→waypointId, `/files/` images) in scope**, or do all standalone consumers supply resolved waypoint IDs and public image URLs? This determines whether the `cx-*` auth-header injection surface exists in the SDK.