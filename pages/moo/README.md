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
   (`floorSelectorStyle: 'auto'` switches from tabs above 6 floors), and
   the venue's amenity icons (`showAmenityIcons`).
2. A tap resolves to the innermost named space whose unit polygon contains
   the tap, else the nearest space/amenity within `maxSnapMeters` (15 m),
   else the tapped **spot** itself (floor only). The pin stays where the
   user tapped; the chosen room is outlined in blue when Jibestream has a
   polygon for it (Mutual Floor 1: 21 of 52 rooms do — the rest are drawn as
   artwork), and the card says "Nearest space · 9 m from your tap" when the
   tap snapped. The SDK fires `mapsdk:locationselect` with a `MapSelection`
   (`name`, `externalId`, floor, waypoint, `distanceMeters`, `properties` =
   every Jibestream custom property, `raw` Jibestream data as plain JSON…).
3. The sheet asks **What does this request cover?** — *At or near a
   specific space* or *The entire floor* (Confluence step 3; layout from
   Michael's prototype on MOO-598, 2026-09-25). The entire floor hides the
   pin and room outline (`setSelectionVisible(false)`) but keeps the
   selection: the card notes the pin won't be included and links back. A
   banner over the map says what a tap does now; a tap while the entire
   floor is chosen switches back to the space (`keepScopeOnSelect` keeps
   the floor). `defaultScope` picks the starting option.
4. `location_on_floor_plan` comes from the map data (Frank, MOO-598
   2026-09-29/30): the Jibestream **External ID** holds `key=value` pairs
   split by `;` — e.g. `zoneId=123;servicenow=HQ, 43, 43C08C` — and the
   `servicenow=` value is the full location string, sent as-is. Everything
   else in the External ID is ignored.
   - a space / amenity: the tapped item's waypoint External ID (each
     instance of a multi-instance amenity has its own — Daniel), else the
     destination / amenity's own External ID
   - the entire floor: the floor's External ID
   - key: `config.serviceNowKey` (default `servicenow`, matched
     case-insensitively)

   Without a `servicenow=` value the page generates a default ("only as a
   convenience" — Frank): `"<building>, <floor>, <space code>"` or
   `"<building>, <floor>"`, comma **and** space. At Mutual HQ: `HQ, 43,
   43C08C` / `HQ, 43`.
   - building: `config.building` (`HQ` — Daniel: "always will be HQ";
     Jibestream calls the building "Mutual of Omaha Headquarters")
   - floor: the floor number only (Daniel, 2026-09-24) —
     `config.floorCodes[mapId]`, else `floorCodeSource` `'shortName'`
     (default: Jibestream's floor short name, `43`, `B` for the basement) or
     `'name'` (`Floor 43`)
   - space code: `spaceCodeSource` — `'namePrefix'` (default: the first word
     of the name when it contains a digit; 3824 of 3826 Mutual names),
     `'name'`, or `'none'`
   - no code (e.g. "Women's Restroom"): `missingCodePolicy` — `'floor'`
     (default, Frank: send `HQ, 43`), `'name'`, or `'deny'`. The card's
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

## Deploying (BTS or any static host)

```sh
npm run build:pages     # → dist/moo/facilities.html, dist/moo/it.html
```

Each file is **self-contained** — styles, config, the SDK and the page logic
inlined (~1.1 MB), nothing else to host. The build reads
`pages/moo/config.local.js` (`--config <file>` for another) and forces
`dryRun: false`, so Continue really opens ServiceNow (`--dry-run` keeps the
alert for testing). The files carry the Jibestream client secret: `dist/` is
gitignored; don't commit or post them.

1. Put the two files where BTS serves HTML (or any HTTPS host). They also
   work opened straight from disk (`file://`).
2. Point the support page's buttons at them — **Submit a Facilities
   Request** → `facilities.html`, **Open an IT Incident** → `it.html` — as
   links, or embed one in an `<iframe>` (give it the full viewport height).
3. Continue replaces the page with the ServiceNow form (`location.replace`,
   so Back returns to the support page). Inside an iframe it replaces the
   **whole** page (`continueTarget: 'auto'`) — ServiceNow forms usually
   refuse to load in a frame. It also posts
   `{ source: 'moo-ticket-page', type: 'continue', location, url }` to the
   parent first; `continueTarget: 'none'` leaves the navigation to it.
4. If the picker is iframed, set `postMessageTargetOrigin` to the support
   page's origin before building.

## Mutual HQ data (Jibestream customer 485, venue 2754 — checked 2026-09-29)

- 1 building ("Mutual of Omaha Headquarters"), 32 floors: Basement (`B`),
  Floor 1, Floor 15 … Floor 44; short names `B`, `1`, `15` … `44`; `level`
  1–32 bottom to top. Floor 1 is mapId 8845.
- 3829 destinations, 43 amenities. Space codes live in the **name**
  (`17N11 Conference`, `23S14.05`); `externalId` is set on 4 (locker banks),
  custom properties on 3 (`Filter Category`). None of the 9163 waypoints
  or 32 floors has an External ID yet.
- Some floors have few room polygons (Basement 3, Floor 15 2, Floor 44 14);
  the SDK frames every floor to its building outline (Jibestream "Boundary"
  layer), so they still open whole.
- The building payload is ~56 MB (32 floor SVGs); ~8 s to ready on desktop.

## Open items (tracked on MOO-598)

- **Client confirmation:** Mutual of Omaha has not yet confirmed the
  standalone-minimap approach (Daniel, 2026-09-23).
- **Hosting:** where the two pages live and who links the support-page
  buttons to them.
- No `servicenow=` values are in Mutual's Jibestream data yet (waypoints or
  floors); the page reads them as soon as support staff enter them. Until
  then it sends the generated default. The zone-label side of the shared
  External ID format is SCPB-4259.
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
