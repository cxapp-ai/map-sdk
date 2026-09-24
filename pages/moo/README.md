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

## Flow

1. The map mounts in **location-select** mode: every venue floor in the
   floor strip, no resource pins, no cards/booking/navigation
   (`allFloors`, `showFloorSelector`, `showCards: false`, `locationSelect`).
2. A tap resolves to the space whose unit polygon contains the tap, else the
   nearest space/amenity waypoint (`selectable` order breaks ties). The SDK
   drops a dark pin and fires `mapsdk:locationselect` with a `MapSelection`
   (`name`, `externalId`, floor, waypoint, `raw` Jibestream models…).
3. The sheet shows the selection. The user picks *Exactly at the selected
   space* or *Anywhere on this floor* (Confluence step 3).
4. `location_on_floor_plan` = `"<building>, <floor>, <space code>"` or
   `"<building>, <floor>"` — comma **and** space, e.g. `HQ, 44, 39E04`.
   - building: `config.building` (HQ)
   - floor: `config.floorCodes[mapId]`, else Jibestream `Floor.shortName`
     (only when numeric — JMap drops string short names like `L3`), else the
     floor name with a leading "Level"/"Floor"/"L"/"F" stripped (`Level 44` → `44`)
   - space code: Jibestream destination `externalId` (`spaceCodeSource`);
     when missing, `missingCodePolicy` = `'deny'` (block, ask for another
     space — Frank) or `'name'` (use the display name — Daniel)
5. **Continue to ticket** builds
   `https://<snow host>/mesp?id=my_mutual&sys_id=<form>&view=mobile&sysparm_variable_values={"location_on_floor_plan":"…"}&wext=1`
   and `location.replace()`s to it (Back returns to the support page).

## Events for an embedding page

The picker is meant to be opened from the support page, but it also works
iframed: the SDK mirrors every `mapsdk:*` event to `window.parent` via
`postMessage` as `{ source: 'map-sdk', type: 'locationselect', detail }`,
and the page posts `{ source: 'moo-ticket-page', type: 'continue', location, url }`
right before navigating. Set a real `targetOrigin` before shipping an iframe
embed (the page currently posts with `'*'`).

Console helpers: `MOO_TICKET_PAGE.getSelection()`, `.getLocation()`, `.getUrl()`,
`.map` (the SDK handle).

## Deploying

Copy `facilities.html`, `it.html`, `ticket-page.js`, `ticket-page.css`, a
filled-in `config.local.js` and `dist/map-sdk.iife.js` to the same folder,
and change the two `<script src="../../dist/map-sdk.iife.js">` tags to
`./map-sdk.iife.js`. Serve over HTTPS (the Jibestream API is HTTPS-only from
a browser origin).

## Open items (tracked on MOO-598)

- Mutual's Jibestream customer/venue/client credentials.
- Whether the space code comes from Jibestream `externalId` or a property
  (`spaceCodeSource` covers `externalId` / name today).
- Floor component format (`44` vs `F21`) — `floorCodes` overrides per floor.
- Behaviour when a space has no code (`missingCodePolicy`).
- Final production ServiceNow host (`serviceNow.host`).
