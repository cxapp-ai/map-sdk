# Decision log

Answers from Waleed (2026-07-09) to the open questions in REQUIREMENTS.md §8.
These are binding for v1.

1. **Booking-from-pin: in v1, via injected host callback.** The host passes
   its booking method to the SDK (`options.booking.onBook`). The SDK keeps the
   pending/confirmed/timeout UI; the Bond hidden-prompt flow stays behind an
   adapter in nova-chat-sdk, not in this repo.
2. **Auth: both modes shipped; `getToken()` is the production path.** Hosts
   have their own backends and mint JACS tokens server-side. The
   clientId/clientSecret mode remains for dev/demo only and is documented as
   unsafe for production bundles.
3. **Framework-agnostic, web + mobile.** Consumers are not Svelte. Ship a
   compiled `mountIndoorMap(container, options)` ESM build plus a
   self-contained IIFE global build (`window.MapSDK`) for WebView/script-tag
   hosts. Svelte is a devDependency only. Every event is also a DOM
   CustomEvent (`mapsdk:*`) so native shells can listen without bundler
   interop.
4. **Both fullscreen and in-container.** `mode: 'container' | 'fullscreen'`
   at mount + `handle.setFullscreen()` at runtime. Fullscreen adds the
   fixed-inset wrapper + body scroll-lock (new work — the chat popup never
   locked scroll).
5. **Backend-agnostic, host supplies all map info.** No wxsuperapp/CX-backend
   calls in the SDK: no meetingId→venue resolution, no colleague endpoint, no
   auth-gated image fetching — all injected as plugins or supplied as config.

   **Provider seam — honest scope (revised post-review).** `options.provider`
   is NOT a working v1 abstraction seam: Jibestream numeric mapIds are baked
   into `setFloor`/`onFloorChange`/`floorLabels`, `update()` is typed as a
   `Pick<JibestreamConfig, …>`, and `/core` exports provider-concrete
   functions. Adding a second map vendor is therefore a **v2 BREAKING rev**,
   not a drop-in. The real abstraction seam is the internal `MinimapInstance`
   interface (`src/core/engine.ts`) — that is where a second provider gets
   formalized in v2, not at `options.provider`. What v1 does now: a
   non-breaking, forward-compat `kind?: 'jibestream'` discriminant on
   `JibestreamConfig` so the surface can be narrowed later without a further
   break. v1 implements Jibestream only.

## v2 considerations (from the post-port quality review)

Not v1 changes — the v1 surface is frozen — but candidates for the next
breaking rev:

- **Hoist `venueBounds`/`venueCenter` out of the provider config.** They are
  provider-agnostic presentation concerns (GPS away-chip / at-venue test),
  not Jibestream connection data; a second provider would need them
  duplicated.
- **Fold `MapResource.capacity`/`reservationId` into the opaque
  `bookingContext` pass-through.** Both are carried-for-host-use only (never
  rendered), which is exactly what `bookingContext` is for.
- **Drop or implement `ItineraryOptions.style`/`pathType`.** Both are
  documented-inert in v1 (accepted, never threaded to the engine); an option
  that can't do anything shouldn't survive a major rev.
- **`GpsOptions.useNativeDot` leaks a Jibestream-specific concern** (JMap's
  native `updateUserLocation` dot) through the provider seam; a provider-
  neutral rendering hint or a provider-scoped options bag would fit better.
