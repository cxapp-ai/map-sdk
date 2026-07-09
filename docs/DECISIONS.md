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
   The Jibestream engine sits behind a provider seam in the public API
   (`options.provider`) so a different map vendor can be added later without
   breaking the surface; v1 implements Jibestream only.
