# Architecture · Security · Performance review — map-sdk @ 5f868a2

## Verdict

The port is in genuinely good internal shape — layering is clean and import-verified, token hygiene and cache keying are careful, teardown on the happy path is complete, and the view layer has effectively zero XSS surface — but it is **not ship-ready for a first consumer** as committed. Three things matter most: (1) there is literally no way to install the package (`private: true`, `dist/` gitignored, no `prepare` script); (2) every mount unconditionally executes third-party JS from `cdn.jibestream.com` with no SRI and no opt-out, which contradicts both the self-contained-IIFE decision and REQUIREMENTS §156; and (3) the public contract lies in two places — `update()`/`setResources` are documented as light patches but perform full engine teardown+re-init, and `onError` reads as a general channel but fires only on mount failure, leaving GPS denial, auth-refresh death, and itinerary failures silent. Alongside these, a cluster of small, one-day fixes (auth-shim timer leak on failed mounts, GPS coordinate leak into the debug log, `gps:false` mounts rendering cached location, CSS declaration injection via `theme`) should land before anyone integrates.

## Confirmed findings

All items below survived two independent refutation attempts unless a severity adjustment is noted.

### Architecture

**MAJOR — No working installation path** — `package.json:36`, `.gitignore:2`
`private: true` blocks npm publish; the git-dependency fallback ships no `dist/` (gitignored, no `prepare`/`prepack` script — scripts at `package.json:23-27` are only build/check/dev), so the exports map resolves to nothing. README.md:16 documents an import that no consumer can currently obtain except by hand-copying files.
*Fix:* pick one before the first consumer: publish to the org registry, add `"prepare": "npm run build"` for git installs, or ship CI tarballs — and document the choice in README.

**MAJOR — `update({provider})` / `setResources` silently tear down and recreate the whole engine** — `src/ui/IndoorMap.svelte:357-364, 371-524`; `src/mount.svelte.ts:243-246`; `src/types.ts:295-296`
The docs sell `update()` as late-config that "re-renders the floor strip", but `floorLabels`/`kioskCoordinate`/resources are folded into the rebuild signature, so any change re-fires the mount effect: JMap controller destroyed, floor/pin/pan/booking state reset (`IndoorMap.svelte:1416-1451`), `ready` re-emitted, and — the perf half — JMap's venue/building fetches repeat plus the fixed 600ms engine settle (`engine.ts:1725`) and 700ms UI settle (`IndoorMap.svelte:504-510`), ≥1.3s per patch on the *documented* late-floorLabels pattern.
*Fix:* short term, document rebuild semantics on `IndoorMapHandle.update`/`setResources` (full reload; batch config; `onReady` fires per rebuild). Medium term, apply `floorLabels` in place (it only renames `FloorInfo.mapName`) and remove it from the rebuild sig.

**MAJOR — `onError`/`mapsdk:error` covers only initial mount; all post-init failures are invisible** — `src/ui/IndoorMap.svelte:516` (sole emit site)
Geolocation denial → `logger.debug` only (`IndoorMap.svelte:1537-1541`) — worst gap for the WebView consumers, whose native shell needs the denial signal; `setItinerary` is fire-and-forget void (`mount.svelte.ts:216-222`) despite the engine reporting `{drawn, missing}` (`engine.ts:1497`), and the itinerary effect swallows draw exceptions (`IndoorMap.svelte:1700-1706`); background token-refresh failure is `jibLog`-only (`engine.ts:118-121`), so mid-session auth expiry 401s silently.
*Fix:* emit `onError` with a machine-usable cause for geolocation watch errors (include `err.code`), auth-refresh failure, and failed/empty itinerary draws (or add `onItineraryResult`). Minimum: document that `onError` is mount-only and enumerate the silent modes.

### Security

**MAJOR — NavigationKit loaded from CDN on every mount, no SRI, no opt-out** — `src/core/engine.ts:357, 370-383, 767`
`ensureNavigationKitLoading()` runs unconditionally in `createMinimap`, injecting `https://cdn.jibestream.com/.../navigationkit.js` into `document.head` with no `integrity`/`crossorigin`. A CDN-account compromise yields full XSS in every embedding host — the script is handed the live `JController` (`engine.ts:774`) whose JCore holds the auth object with sync token getters. Its only consumer is veer-reroute, yet pin-only mounts fire the third-party request; README.md:88 tells hosts to *open* their CSP to this origin, and `docs/REQUIREMENTS.md:156` itself says the load "must be explicitly optional".
*Fix:* defer loading to the first `drawItinerary`; add an explicit opt-out (e.g. `autoReroute?: boolean`); add SRI + `crossorigin="anonymous"` if the pinned v1.2.0 artifact is immutable; document the trust implication in README.

**MAJOR — Auth-shim refresh timer leaks permanently when `createMinimap` fails after shim construction** — `src/core/engine.ts:687, 723-734, 1073`
`buildHostTokenAuth()` arms a self-rescheduling refresh timer immediately (`scheduleNext`, engine.ts:112-121/149), and `dispose()` is only reachable via the instance `destroy()` returned at the *end* of `createMinimap`. Any throw between line 689 and the return — `populateVenueWithDefaultBuilding` rejection (bad venueId, revoked auth, JACS outage), `new JController` — leaks an immortal timer that keeps calling the host's `getToken()` every ~TTL (min 60s), minting fresh bearers for a dead mount, potentially for a logged-out principal; retry loops stack timers.
*Fix:* wrap everything after `buildHostTokenAuth` in try/catch → `disposeAuthShim()` then rethrow. The shim block is new code, so port diffability is unaffected.

**MAJOR — `options.theme` string-concatenated into the root inline style — CSS declaration injection** — `src/ui/IndoorMap.svelte:171-176, 1736`; `src/mount.svelte.ts:250`
`--map-${k}: ${v};` is built by raw concatenation with no key/value validation. A tainted value (realistic path: white-label theme tokens from tenant CMS config) injects arbitrary declarations onto the SDK root — full-viewport UI redress (amplified in fullscreen at z-index 2147483000, `mount.svelte.ts:53`) and `url()` exfil beacons. Redress/beacon class, not XSS.
*Fix:* apply tokens via `rootEl.style.setProperty(name, value)` in an effect (cannot inject sibling declarations); or validate keys against `/^(--map-)?[a-zA-Z][\w-]*$/` and reject `;`, `{`, `}`, `url(` in values.

**MAJOR — `gps:false` mount still renders the user's location from `sharedLastFix`** — `src/ui/IndoorMap.svelte:267-291, 471-474, 1742, 1788`
The module-level fix cache is seeded at component init ungated by `gpsEnabled`, and the you-are-here marker / off-map chip render with no gps gate. Mount A (gps:true) → destroy → mount B same venue with gps:false (user revoked consent, logged out) still shows A's position. Direct violation of the `types.ts:271-272` contract ("gps: false/omitted = off").
*Fix:* gate the seed on `gpsEnabled` and/or short-circuit `resolveUserOverlay`/`reprojectUserWorld` when `!gpsEnabled`.

**MAJOR — Debug channel logs the user's precise indoor position on every accepted GPS fix** — `src/core/engine.ts:1607`
`setNativeUserLocation` logs world coordinates + mapId on every reliable fix whenever an itinerary is active (`IndoorMap.svelte:1486`). A host forwarding `MapLogger.debug` to telemetry (Sentry breadcrumbs, log aggregation) persists a per-tick movement trail; nothing in `types.ts` warns that `MapLogger` receives location data. It is the *only* sensitive item on the channel — everything else is clean.
*Fix:* drop the coordinate payload (log a boolean/count) or round/redact; add one sentence to the `MapLogger` doc about channel contents.

### Performance

**MAJOR (one verifier: minor) — Marker overlays reposition via `left`/`top` — per-frame layout invalidation, O(N) in pin count** — `src/ui/IndoorMap.svelte:421-433, 583-593, 1802, 1817, 1841, 1866`
Every pan/zoom frame rebuilds `positions` (one projection + alloc per pin) plus `projectColleagues` over all floors' markers, then writes `left/top` on each absolutely-positioned marker — dirtying layout every frame. Fine at 10-30 pins; expect ~5-15ms/frame at 100 pins on mid-tier mobile and visible stutter at 500 (directory mode).
*Fix:* keep `left/top: 0` and move markers with `transform: translate3d(x, y, 0)` — identical visuals, layout-free. Add `contain: layout style` on the canvas wrap. v2: single world-space overlay layer with one per-frame affine transform.

**MAJOR (one verifier: minor) — Cold start serializes venue fetch before the 1.4MB jmap chunk download** — `src/core/engine.ts:638, 668`
`await loadVenue(cfg)` (token POST + `/full` fetch) completes before `await loadJmap()` (the 307KB-gzip dynamic import) even starts, though they are fully independent — two network round-trips serially ahead of the chunk transfer, plus the tick+2×RAF wait in the mount effect (`IndoorMap.svelte:393-408`).
*Fix:* `const jmapPromise = loadJmap()` at the top of `createMinimap`, await at the current line 668 — race-safe (module-cached), no observable ordering change. Optionally export `preloadMapEngine()` for intent-based warming.

**MINOR (downgraded from major by both verifiers) — Venue `/full` payload fetched twice on cold mount** — `src/core/jibestream.ts:242-252`; `src/core/engine.ts:723-728`
The SDK fetches `/venue/{v}/full` for its destinations index, then JMap's `populateVenueWithDefaultBuilding` re-fetches the same payload through its own HTTP layer (verified in minified jmap source). SDK copy is cached; JMap's re-fetches on every rebuild. Whether the browser cache dedupes depends on JACS response headers, unverified.
*Fix:* confirm JACS validators via the `makeJacsRequest` interceptor / a HAR; if no 304, add a small URL-keyed GET cache in the interceptor. v2: derive the destination index from `activeVenue` and drop the SDK fetch (reorders a preserved port structure — v2 only).

## Contested findings

**Provider seam (DECISIONS #5) is largely cosmetic — provider #2 breaks the frozen surface** — `src/types.ts:72, 241, 258, 289, 297`
*For:* every citation reproduces — no `kind` discriminant on `provider`, Jibestream numeric mapIds baked into `setFloor`/`onFloorChange`/`floorLabels`, `update()` typed as `Pick<JibestreamConfig,…>`, `/core` exports provider-concrete functions — so adding a vendor requires a breaking rev, contradicting the recorded decision. *Against (refuting skeptic):* the facts are right but the severity is not — this is a documentation-honesty gap about a v2 concern, not a v1 defect; both skeptics adjusted to minor. **Tiebreak:** treat as minor. Re-scope DECISIONS #5 to say provider #2 is a v2 breaking rev with `MinimapInstance` (`engine.ts:481-605`) as the real seam, and cheaply add optional `kind?: 'jibestream'` now (non-breaking). Do not attempt a provider interface in v1.

**`sharedLastFix` retains GPS coordinates for the page lifetime, keyed by venue not user** — `src/ui/IndoorMap.svelte:1-15, 1471`
*For:* the cache is never cleared by `tearDown`, `destroy()`, or `clearJibestreamCaches()`, and has no user key — on shared devices (kiosks, logout/login SPAs) user B's map seeds from user A's position; the token caches got identity keying (`jibestream.ts:11-19`) and this deliberately-flagged singleton (REQUIREMENTS §7 risk 3) did not. *Against (refuting skeptic):* the code facts hold but the impact scenario collapses once the confirmed `gps:false` fix lands, and the proposed remediation would not change behavior in the stated threat cases. **Tiebreak:** fix the confirmed `gps:false` gating first (that closes the consent violation), then land the cheap residual: have `clearJibestreamCaches()` (or a new `clearMapCaches()`) also null `sharedLastFix`, and document the shared-device implication. Minor after that.

**Refuted (considered, dropped):** *mapsdk:\* CustomEvents broadcast bookingContext page-wide with bubbles+composed* — code is as described, but within a same-realm page this adds no boundary crossing beyond what any co-resident script already has; the residual shadow-DOM caveat survives as a minor doc item below.

## Minor findings

| Severity | Lens | Title | File | Remediation |
|---|---|---|---|---|
| minor | arch | Core writes to console, violating "no logger = no output" | `src/core/jibestream.ts:270`, `src/core/engine.ts:738`, `src/plugins/cxai.ts:54` | Route all three through the in-scope `jibLog`/logger |
| minor | arch | d.ts drift guard blind to type-only exports | `src/index.assert-public.ts:15-24` | Add a type-import assertion consuming every public type from `./index.public.js` |
| minor | arch | Mount-time `focusResourceId` re-asserts after every rebuild, overriding runtime `focusResource()` | `src/ui/IndoorMap.svelte:482-493`, `src/mount.svelte.ts:191` | Have `handle.focusResource` also write `props.focusResourceId` |
| minor | arch | Handle is write-only (no getFloor/getSelectedResource/isFullscreen); `gps` mount-frozen despite reactive plumbing | `src/types.ts:283-306` | Add cheap getters; add `gps` to `update()` or document as mount-fixed |
| minor | arch | Exports map gaps: `./global` untyped, no CJS, `main` → ESM, sourceMappingURL 404s | `package.json:6-21` | Add `./global` types condition; strip map comments; document ESM-only + Jest config |
| minor | arch | Hardcoded English bypasses MapStrings (aria-labels, "m away" chip) | `src/ui/IndoorMap.svelte:699-700, 1803-1842` | Add keys to `DEFAULT_STRINGS` (additive; MapStrings is an open Record) |
| minor | arch | `/core` mutates host container (`nova-minimap-*` id, inline position) without restore | `src/core/engine.ts:671-677, 1068-1074` | Rename prefix to `map-sdk-`; restore id/position in `destroy()` |
| minor | arch/perf | Perpetual RAF poll → zone.js change detection 60×/sec in Angular hosts; battery in backgrounded WebViews | `src/core/engine.ts:1026-1034` | README: mount in `runOutsideAngular()`; optionally pause RAF on `visibilitychange` |
| minor | sec | Live Jibestream secret in `demo/.env.local` (untracked, but same pair burned in nova-chat-sdk history); demo README institutionalizes copying it | `demo/.env.local:4-5`, `demo/README.md:30-31` | Rotate the 838c9279 secret; point README at the secrets store; add `.env.example` |
| minor | sec | README "hoist getToken to a stable reference" invites cross-principal token reuse | `README.md:95-101` | Caveat: recreate the closure on login/logout or call `clearJibestreamCaches()`; v2 `authKey?: string` |
| minor | sec | cc-mode cache key omits the secret — rotated/wrong secret masked by cached token | `src/core/jibestream.ts:96` | Fold a cheap hash of the secret into the key, or document clientId-only keying |
| minor | sec | bubbles+composed events cross shadow roots with bookingContext — undocumented | `src/mount.svelte.ts:138-143` | README caveat; v2 `events: 'dom' \| 'callbacks-only'` option |
| minor | sec | Image URLs used verbatim as `<img src>` — trust assumption undocumented | `src/ui/IndoorMap.svelte:180, 1871, 1948` | Allowlist http(s)/data:image/blob schemes, or document as trusted display URLs |
| minor | sec | Demo mounts error text via `innerHTML` — reference-integration footgun | `demo/main.ts:218` | Use `textContent` (consistent with `demo/main.ts:29`) |
| minor | sec | Object URLs from `images.load` never revoked; ownership undocumented | `src/ui/IndoorMap.svelte:1035-1040, 1450` | Revoke `blob:` URLs on prune/tearDown, or document host ownership |
| minor | perf | No-venueBounds away path: O(all-waypoints) scan + coord conversion every view-change frame | `src/ui/IndoorMap.svelte:762-774`, `src/core/engine.ts:1180-1212` | Memoize `nearestWaypointWorld` keyed on (fix, mapId) — view-independent |
| minor | perf | Frame-rate `$state` array replacement pays deep-proxy cost for nothing | `src/ui/IndoorMap.svelte:249, 308, 426-472` | Declare `positions`/`colleaguePositions`/`startPos` as `$state.raw` |
| minor | perf | Fixed 600ms+700ms settles put a ~1.3s wall-clock floor under warm mounts | `src/core/engine.ts:920-925, 1724-1727`, `src/ui/IndoorMap.svelte:504-510` | v2/flagged: readiness poll on view-transform stability with current timers as ceiling |
| minor | perf | `jmap.js` in runtime `dependencies` though bundled into dist | `package.json:37-39` | Move to devDependencies; verify with `npm pack` + scratch install |
| minor | perf | VenueData retains full unprojected JACS destination objects ×8 cache entries | `src/core/jibestream.ts:253-263` | Project to `{id, name, locations}` on ingest (pure narrowing, no surface change) |
| minor | perf | IIFE inlines jmap (321KB gzip) — parse cost even if no map mounts | `vite.config.iife.ts:19-21` | Record accepted trade-off in DECISIONS.md; optional two-file variant as v2 item |

## What's solid

Don't lose these in refactors:

- **Layering** — core → types only; ui → core+types+strings; `mount.svelte.ts` is the sole component-aware module; barrels are pure re-exports. No upward deps.
- **Event fan-out** — compile-checked exhaustive `EVENT_CALLBACKS` table (`mount.svelte.ts:37-47`) makes event drift a type error; callbacks are failure-isolated and squelched after destroy.
- **Cache architecture** — token/venue caches keyed by auth identity (getToken WeakMap), generation counters against destroy/remount races, in-flight dedup, capped eviction that only forgets tokens. Cross-user bearer reuse verifiably impossible on the normal path.
- **Packaging guards** — committed `index.public.d.ts` + mutual-assignability assert + afterBuild post-condition; lazy jmap split verified working from the ESM entry (48.8KB gzip eager).
- **Hygiene** — zero `{@html}`/innerHTML in src; no tokens/secrets in logs or events; zero persistence (no storage APIs); clean git history (no credentials ever committed); happy-path teardown complete (RAF, ResizeObserver, controller, shim, GPS watch, timers, refcounted scroll lock).
- **`MinimapInstance`** (`engine.ts:481-605`) is the real provider-abstraction seam for v2 — formalize it there, not in `options.provider`.

## Recommended order of work

1. **(S)** Wrap post-shim `createMinimap` body in try/catch → `disposeAuthShim()` on failure (timer leak).
2. **(S)** Strip coordinates from `engine.ts:1607` log; gate `sharedLastFix` seed + user overlay on `gpsEnabled`; extend `clearJibestreamCaches` to null `sharedLastFix`.
3. **(S)** Theme via `style.setProperty` per token (kills CSS injection).
4. **(S)** Rotate the burned 838c9279 Jibestream secret; fix `demo/README.md:30-31` and add `.env.example`.
5. **(M)** Decide distribution: unset `private` + publish, or add `prepare` script — verify with `npm pack` + scratch install; move `jmap.js` to devDependencies while in there.
6. **(M)** NavigationKit: defer load to first itinerary draw, add opt-out option, add SRI if the artifact is immutable, README security note.
7. **(M)** Error channel: emit `onError` for geolocation denial (with code), auth-refresh failure, itinerary draw failure/empty; document mount-only scope wherever not widened.
8. **(S)** Kick off `loadJmap()` concurrently with `loadVenue`; export `preloadMapEngine()`.
9. **(M)** Apply `floorLabels` in place and drop it from the rebuild sig; document rebuild cost of `setResources`/`update` in README + types.
10. **(S)** Markers: `translate3d` instead of `left/top`; `$state.raw` for position arrays; `contain: layout style` on the canvas wrap.
11. **(S)** DECISIONS #5 rescope + optional `kind?: 'jibestream'` discriminant; record `MinimapInstance` as the v2 seam.
12. **(S)** Minor sweep: three console.* → jibLog, demo `innerHTML` → `textContent`, `focusResource` props write-back, i18n keys, `nova-` prefix rename, memoize `nearestWaypointWorld`, README notes (Angular zone, shadow-DOM events, image trust, getToken hoisting caveat, cc-key caveat).
13. **(L, v2)** Settle-timer → readiness poll; resource diffing without rebuild; venue `/full` dedup via interceptor cache or `activeVenue`-derived index; provider interface rev.