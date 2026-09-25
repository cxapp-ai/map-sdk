# MyMutual ticket location picker (MOO-598)

Two raw HTML pages that embed the minimap so a Mutual of Omaha user can pick
**where** a Facilities or IT issue is, then continue to the ServiceNow form
with `location_on_floor_plan` pre-filled. Approach 2 on the
[MyMutual Ticketing Workflows](https://cxai.atlassian.net/wiki/spaces/SUP/pages/2058027019)
Confluence page; requirements from Frank's and Daniel's comments on
[MOO-598](https://cxai.atlassian.net/browse/MOO-598).

| Page | Ticket | ServiceNow `sys_id` |
|---|---|---|
| `facilities.html` | Building Facilities and Supplies Request | `798e3ee687d20754ea4cea883cbb3549` |
| `it.html` | Onsite Headquarters IT Incident | `bf181a2447ae03980971cc0b516d439b` |

The two pages differ only in `data-ticket` and the title. All behaviour is
`ticket-page.js` (plain browser JS, no bundler) + `ticket-page.css`.

## Run locally

```sh
npm install
cp pages/moo/config.example.js pages/moo/config.local.js   # fill it in (see below)
npm run build        # produces dist/map-sdk.iife.js, which the pages load
npm run pages        # static server on http://localhost:4310 (fixed port)
# → http://localhost:4310/pages/moo/facilities.html  or  /pages/moo/it.html
```

Open it in a real browser (Chrome/Safari). The VS Code "Simple Browser"
webview kills the renderer on this page (canvas map + 1 MB bundle) —
"Render process gone". Port 4310 is fixed on purpose: 5173–5180 are usually
taken by other vite dev servers (nova-chat-sdk), which answer every path with
their own index.html and boot the wrong app.

`config.local.js` is gitignored — it carries the Jibestream client secret,
which this page ships to the browser (accepted for this page on MOO-598).
Until Mutual's credentials arrive, point it at the San Ramon demo venue and
keep `dryRun: true` so Continue shows the URL instead of leaving the page.

**Accepted risk:** anyone who can load the page can fetch `config.local.js`
and read the Jibestream `clientId`/`clientSecret` — enough to mint their own
read-only (`sdk.read`) token for Mutual's venue data. Frank approved
hardcoding for this page; the proper fix is a small token-minting endpoint
and the SDK's `auth: { getToken }` mode, which keeps the secret server-side.

## Flow

1. The map mounts in **location-select** mode: every venue floor, no
   resource pins, no cards/booking/navigation (`allFloors`,
   `showFloorSelector`, `showCards: false`, `locationSelect`). Mutual HQ has
   32 floors, so the SDK shows a dropdown floor picker with ‹ › buttons
   (`floorSelectorStyle: 'auto'` switches from tabs above 6 floors).
2. A tap resolves to the innermost named space whose unit polygon contains
   the tap, else the nearest space/amenity within `maxSnapMeters` (15 m),
   else the tapped **spot** itself (floor only). The pin stays where the
   user tapped; the chosen room is outlined in blue when Jibestream has a
   polygon for it (Mutual Floor 1: 21 of 52 rooms do — the rest are drawn as
   artwork), and the card says "Nearest space · 9 m from your tap" when the
   tap snapped. The SDK fires `mapsdk:locationselect` with a `MapSelection`
   (`name`, `externalId`, floor, waypoint, `distanceMeters`, `properties` =
   every Jibestream custom property, `raw` Jibestream data as plain JSON…).
3. The sheet shows the selection. The user picks *Exactly at the selected
   space* or *Anywhere on this floor* (Confluence step 3).
4. `location_on_floor_plan` = `"<building>, <floor>, <space code>"` or
   `"<building>, <floor>"` — comma **and** space. Floor format and the
   no-code rule follow Frank on MOO-598 (2026-09-24); the space-code source is
   our choice pending his OK. At Mutual HQ this gives `HQ, Floor 43, 43C08C`:
   - whole string: `config.locationProperty` when that Jibestream property is
     set on the item (none at Mutual today); otherwise generated:
   - building: `config.building` (HQ)
   - floor: `config.floorCodes[mapId]`, else `floorCodeSource` — `'name'`
     (default: the Jibestream floor name, `Floor 44`) or `'shortName'`
     (`44`, the Confluence example format)
   - space code: `config.spaceCodeProperty` (a custom property key), else
     `spaceCodeSource` — `'namePrefix'` (default: the first word of the name
     when it contains a digit; 3824 of 3826 Mutual names), `'externalId'`,
     `'name'`, or `'none'` (codes only from the property)
   - no code (e.g. "Women's Restroom"): `missingCodePolicy` — `'floor'`
     (default, Frank: send `HQ, Floor 43`), `'name'`, or `'deny'`. The card's
     "Space code" row shows exactly what will be sent.
5. **Continue to ticket** builds
   `https://<snow host>/mesp?id=my_mutual&sys_id=<form>&view=mobile&sysparm_variable_values={"location_on_floor_plan":"…"}&wext=1`
   and `location.replace()`s to it (Back returns to the support page).
   `serviceNow.host` must be an `https://` URL or the page refuses to start.
   The default is `mutualofomahatest` (what MyMutual PROD uses): per Daniel
   the `wext=1` SSO bypass only works on PROD, so the stage host
   (`mutualofomahadev`) stops at a login wall.

## Events for an embedding page

The picker is meant to be opened from the support page, but it also works
iframed: the SDK mirrors every `mapsdk:*` event to `window.parent` via
`postMessage` as `{ source: 'map-sdk', type: 'locationselect', detail }`,
and the page posts `{ source: 'moo-ticket-page', type: 'continue', location, url }`
right before navigating (never in `dryRun`). Both use
`config.postMessageTargetOrigin` — set it to the support page's origin
before iframing the picker in production (default `'*'`).

Console helpers: `MOO_TICKET_PAGE.getSelection()`, `.getLocation()`, `.getUrl()`,
`.map` (the SDK handle).

## Deploying

1. `npm run build`, then copy `facilities.html`, `it.html`, `ticket-page.js`,
   `ticket-page.css`, `config.local.js` and `dist/map-sdk.iife.js` to one
   folder.
2. In both HTML files change `<script src="../../dist/map-sdk.iife.js">` to
   `./map-sdk.iife.js`.
3. In `config.local.js` set **`dryRun: false`** (the local dev copy has it
   `true`, which makes Continue only show an alert), and set
   `postMessageTargetOrigin` to the support page's origin if the picker is
   ever iframed.
4. Serve over HTTPS and point the support page's Facilities / IT buttons at
   the two pages.

## Mutual HQ data (Jibestream customer 485, venue 2754 — checked 2026-09-24)

- 1 building, 32 floors: Basement (`B`), Floor 1, Floor 15 … Floor 44;
  `level` 1–32 bottom to top. Floor 1 is mapId 8845.
- 3826 destinations, 42 amenities. Space codes live in the **name**
  (`17N11 Conference`, `23S14.05`); `externalId` is set on 4 (locker banks),
  custom properties on 3 (`Filter Category`) — no space-code property yet.
- The building payload is ~56 MB (32 floor SVGs); ~8 s to ready on desktop.

## Open items (tracked on MOO-598)

- **Client confirmation:** Mutual of Omaha has not yet confirmed the
  standalone-minimap approach (Daniel, 2026-09-23).
- **Hosting:** where the two pages live and who links the support-page
  buttons to them.
- Confirm with Frank: space code = first word of the name. He asked for a
  property, but none exists at Mutual today.
- Floor format: `Floor 44` (Frank, the default) vs `44` (Confluence, which
  Daniel calls authoritative and which hasn't been updated) —
  `floorCodeSource` switches.
- Deliberate choices to confirm: taps farther than 15 m from any space send
  the floor only (Frank asked for "the nearest"); the pin sits where the
  user tapped and the chosen room is outlined — rooms Jibestream has no
  polygon for (31 of 52 on Floor 1) get no outline.
- IT page: Confluence mentions an "immediate-assistance" pop-up for the IT
  flow, but its content and target POI are undefined — not built.
- On-screen copy is provisional; the ServiceNow deep-link target (MOO-425)
  is still open.
- Should corridors (`… CIRC`) / utility rooms be selectable? `accept` can
  exclude them.
- Final production ServiceNow host (`serviceNow.host`) and PROD testing of
  the logged-in form + the MyMutual app end to end (SSO wrapper, MOO-605).
