# map-sdk demo

A minimal harness that mounts the SDK from raw source (`../src`) and exercises
the public surface: fullscreen, itinerary drawing, a mock booking plugin
(2 s delay → confirmed), a GPS mock toggle, `focusResource`, and a log panel
fed by the `mapsdk:*` DOM CustomEvents on the container.

## Run

```sh
npm install        # from the repo root
npm run dev        # vite --config demo/vite.config.ts
```

## Credentials

The demo reads Jibestream credentials from **`demo/.env.local`** (gitignored
via `*.local` — NEVER commit secrets):

```sh
# demo/.env.local
VITE_JIBESTREAM_HOST=https://api.jibestream.com   # optional, this is the default
VITE_JIBESTREAM_CUSTOMER_ID=...
VITE_JIBESTREAM_VENUE_ID=...
VITE_JIBESTREAM_CLIENT_ID=...
VITE_JIBESTREAM_CLIENT_SECRET=...
VITE_JIBESTREAM_MAP_PROFILE_ID=...                # only if your service account needs it
```

Working demo-venue values live in the sibling repo's `nova-chat-sdk/app/.env.local`
(same variable names) — copy them locally from there.

The demo uses the dev-only `clientId`/`clientSecret` auth mode, which ships the
secret to the browser. Production hosts must use `auth: { getToken }` with
server-minted tokens instead.

## Optional tuning

```sh
# Waypoint ids for the mock resources (must exist on your venue to pin;
# unresolved ids still appear in the carousel + the "not shown on map" badge).
# NOTE: the engine throws "Couldn't locate any of these on the map." when NONE
# resolve, so set real ids. These three are real rooms on the San Ramon demo
# venue (Boardroom 3M, Meeting Rooms 3K/3L):
VITE_DEMO_WAYPOINT_IDS=115755368,115837418,115837416

# Where the GPS mock fix lands (put it inside your venue to see the dot).
VITE_DEMO_MOCK_LAT=37.7626
VITE_DEMO_MOCK_LNG=-121.9682
```

## Notes

- The GPS toggle remounts the map — `gps` is a mount option, not a handle
  method. Remounting also demonstrates `destroy()` and that container-attached
  `mapsdk:*` listeners survive across mounts.
- Fullscreen ships no chrome; the demo binds Escape (and the toolbar button)
  to `setFullscreen(false)` — hosts own the exit affordance.
