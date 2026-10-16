// Jibestream data layer. Auth + venue/destination resolution. No DOM, no
// rendering — those live in `./engine.ts`.
//
// Two auth modes (cfg.auth):
//   1. Client-credentials ({clientId, clientSecret}): SDK POSTs
//      client_credentials. Credentials ship in the bundle — dev/demo only.
//   2. Host-supplied ({getToken} callback): host returns a pre-minted bearer.
//      Keeps secrets server-side; JMap's own auth is short-circuited so the
//      bundle never sees any credential (see engine.ts).
//
// Caches are keyed by `${host}|${customerId}|${venueId}|<auth identity>` —
// NOT module singletons — so multi-instance / multi-venue hosts never share
// tokens or venue data across configs (REQUIREMENTS §7 risk 3). The auth
// identity component (clientId for client-credentials, per-callback identity
// for getToken) means a destroy + remount with a DIFFERENT getToken callback
// (e.g. user logout/login) or two concurrent instances with different
// credentials against the same venue can never reuse each other's bearer —
// the guarantee the original chat SDK provided by auto-clearing caches on
// host destroy.
//
// The cache is capped at MAX_CACHE_ENTRIES (oldest evicted) so a long-lived
// page that cycles configs — or recreates its getToken closure per mount —
// can't grow it unboundedly; hosts should hoist getToken to a stable
// reference to reuse the cache across remounts.

import type { JibestreamConfig, MapLogger } from '../types.js';

export function jibLogWith(logger: MapLogger | undefined, stage: string, msg: string, extra?: unknown): void {
	logger?.debug?.(`[jibestream:${stage}]`, msg, extra ?? '');
}

/**
 * Curried per-callsite variant: `const jibLog = makeJibLog(logger)` gives the
 * (stage, msg, extra) shape used throughout this module and the engine.
 */
export function makeJibLog(logger: MapLogger | undefined): (stage: string, msg: string, extra?: unknown) => void {
	return (stage, msg, extra) => jibLogWith(logger, stage, msg, extra);
}

export interface Destination {
	id: number;
	name: string;
	locations: Array<{ mapId: number; waypointIds: number[] }>;
}

// Shape of a raw JACS `/full` destination item as it arrives on the wire. Only
// the fields the SDK consumes are typed; the wire object carries more (polygons,
// styling, …) which the ingest projection deliberately drops. `?? []` guards
// keep the projection resilient to items missing `locations`/`waypointIds`.
interface RawDestination {
	id: number;
	name: string;
	locations?: Array<{ mapId: number; waypointIds?: number[] }>;
}

export interface VenueData {
	id: number;
	name: string;
	destinations: Destination[];
	byWaypointId: Map<number, Destination>;
	byName: Map<string, Destination>;
}

interface JibCacheEntry {
	tokenCache: { token: string; expiresAt: number } | null;
	tokenInflight: Promise<string> | null;
	venuePromise: Promise<VenueData> | null;
	// Incremented by clearJibestreamCaches. IIFEs capture this at launch and only
	// write cache fields when the value still matches, preventing a
	// destroy-then-remount race from poisoning the new mount's cache.
	cacheGeneration: number;
}

// Keyed by `${host}|${customerId}|${venueId}|<auth identity>` so switching
// venue OR credentials (or running two instances against different
// venues/credentials on one page) re-fetches that config's token +
// destinations instead of reusing the first one we loaded.
const caches = new Map<string, JibCacheEntry>();

// Cap on distinct config cache entries. Creating an entry beyond the cap
// evicts the OLDEST one (Map preserves insertion order) after bumping its
// generation — the same discipline as clearJibestreamCaches — so an in-flight
// request that captured the evicted entry can't write a stale token into it.
// Eviction only ever FORGETS a token (forcing a re-fetch); it never shares
// one across keys, so the per-auth-identity isolation guarantee is unchanged.
const MAX_CACHE_ENTRIES = 8;

// Auth identity for the cache key. getToken callbacks are keyed by function
// identity (a WeakMap-assigned id): a remount that passes a NEW callback —
// e.g. a fresh closure minting for a different logged-in user — gets a fresh
// cache entry and never reuses the previous user's bearer. The tokens
// themselves are never part of the key.
let nextAuthId = 1;
const authIds = new WeakMap<object, number>();

function authKey(auth: JibestreamConfig['auth'] | undefined): string {
	if (!auth) return 'none';
	if ('getToken' in auth) {
		let id = authIds.get(auth.getToken);
		if (id == null) {
			id = nextAuthId++;
			authIds.set(auth.getToken, id);
		}
		return `fn#${id}`;
	}
	// Fold a cheap, non-reversible discriminant of the secret into the key so a
	// rotated/wrong clientSecret (same clientId) can't be masked by a token
	// cached under the OLD secret. This is a collision-avoidance discriminant,
	// NOT a security primitive: it is never logged and never reversible to the
	// secret (length + a simple additive char-sum, folded to 32 bits).
	return `cc:${auth.clientId}:${secretDiscriminant(auth.clientSecret)}`;
}

// Non-reversible discriminant of the client secret for cache keying only.
// Deliberately NOT a cryptographic hash and NEVER logged — it only needs to
// differ when the secret changes so a stale token isn't reused after rotation.
function secretDiscriminant(secret: string | undefined): string {
	if (!secret) return '0.0';
	let sum = 0;
	for (let i = 0; i < secret.length; i++) {
		sum = (sum * 31 + secret.charCodeAt(i)) >>> 0;
	}
	return `${secret.length}.${sum.toString(36)}`;
}

function cacheKey(cfg: JibestreamConfig): string {
	return `${cfg.host}|${cfg.customerId}|${cfg.venueId}|${authKey(cfg.auth)}`;
}

function cacheFor(cfg: JibestreamConfig): JibCacheEntry {
	const key = cacheKey(cfg);
	let entry = caches.get(key);
	if (!entry) {
		while (caches.size >= MAX_CACHE_ENTRIES) {
			const oldestKey = caches.keys().next().value as string;
			const oldest = caches.get(oldestKey)!;
			oldest.cacheGeneration++;
			oldest.tokenCache = null;
			oldest.tokenInflight = null;
			oldest.venuePromise = null;
			caches.delete(oldestKey);
		}
		entry = { tokenCache: null, tokenInflight: null, venuePromise: null, cacheGeneration: 0 };
		caches.set(key, entry);
	}
	return entry;
}

export function getToken(cfg: JibestreamConfig, logger?: MapLogger): Promise<string> {
	const jibLog = makeJibLog(logger);
	const entry = cacheFor(cfg);
	// 30s skew so requests issued near the boundary don't fail mid-flight.
	if (entry.tokenCache && entry.tokenCache.expiresAt > Date.now() + 30_000) {
		return Promise.resolve(entry.tokenCache.token);
	}
	if (entry.tokenInflight) return entry.tokenInflight;

	const auth = cfg.auth;
	// Reject as a Promise (not a synchronous throw) to honour the declared
	// return type — callers using .catch() must be able to catch this.
	if (!auth || (!('getToken' in auth) && (!auth.clientId || !auth.clientSecret))) {
		return Promise.reject(new Error('Jibestream credentials not configured (set auth.getToken or auth.clientId/clientSecret)'));
	}

	const gen = entry.cacheGeneration;
	let resolveToken!: (token: string) => void;
	let rejectToken!: (err: unknown) => void;
	const thisInflight = new Promise<string>((resolve, reject) => {
		resolveToken = resolve;
		rejectToken = reject;
	});
	entry.tokenInflight = thisInflight;
	void (async () => {
		try {
			if ('getToken' in auth) {
				const minted = await auth.getToken();
				if (!minted?.accessToken) {
					throw new Error('Jibestream getToken returned empty accessToken');
				}
				const ttlSec = Number.isFinite(minted.expiresInSeconds) && minted.expiresInSeconds > 0
					? minted.expiresInSeconds
					: 1800;
				if (entry.cacheGeneration === gen) {
					entry.tokenCache = { token: minted.accessToken, expiresAt: Date.now() + ttlSec * 1000 };
					jibLog('auth', `host-supplied token cached for ${ttlSec}s`);
				}
				resolveToken(minted.accessToken);
				return;
			}

			const body = new URLSearchParams({
				grant_type: 'client_credentials',
				client_id: auth.clientId,
				client_secret: auth.clientSecret,
				scope: 'sdk.read',
			});
			const res = await fetch(`${cfg.host}/JACS/api/auth/token`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			});
			if (!res.ok) throw new Error(`Jibestream auth failed: ${res.status}`);
			const j = await res.json();
			if (entry.cacheGeneration === gen) {
				entry.tokenCache = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 1800) * 1000 };
			}
			resolveToken(j.access_token as string);
		} catch (err) {
			rejectToken(err);
		} finally {
			// Identity check: a racing clearJibestreamCaches + new getToken may
			// have already installed a fresh Promise; don't clobber it.
			if (entry.tokenInflight === thisInflight) entry.tokenInflight = null;
		}
	})();
	return thisInflight;
}

// Public-surface alias (core/index.ts exports `getJibestreamToken`); the
// short `getToken` name is kept for the engine + line-for-line parity with
// the original module.
export { getToken as getJibestreamToken };

/**
 * Drops the in-memory token + venue caches (all keys).
 *
 * Normally unnecessary: cache entries are keyed per config INCLUDING auth
 * identity, so a remount with a different `getToken` callback (or different
 * client credentials) already gets a fresh entry. Exported (from both the
 * default and /core entries) as a hard-reset escape hatch — e.g. to force a
 * token/venue re-fetch without changing the config, or to free entries on a
 * long-lived page that cycles many configs.
 */
export function clearJibestreamCaches(): void {
	// Bump each entry's generation first so any in-flight IIFE that captured
	// the entry object can't write a stale token into it, then drop the
	// entries themselves.
	for (const entry of caches.values()) {
		entry.cacheGeneration++;
		entry.tokenCache = null;
		entry.tokenInflight = null;
		entry.venuePromise = null;
	}
	caches.clear();
	// Same discipline for the stored map data: a fetch still in flight, or a
	// write already queued for idle time, must not refill the store after the
	// clear (see saveJacs and clearJacsStore).
	jacsInflight.clear();
	clearJacsStore();
}

// --- Persistent JACS response cache -------------------------------------------
//
// The building `/full` response carries every floor's SVG (Mutual of Omaha HQ:
// 54 MB, 32 floors) and JACS serves it uncompressed with no Cache-Control or
// ETag, so every open downloaded it again. JMap's own cache can't help: it is
// localStorage (~5 MB), the write throws, and its catch wipes every cached
// entry. JACS does answer `If-Modified-Since: <generatedAt>` with 304 (verified
// on venue and building, 2026-10-15), so responses are kept in IndexedDB and
// revalidated: an unchanged venue costs a 304 instead of the download.
//
// Keyed by the full request URL (host, customer, venue, building, map
// profile) — never the token. Two stores written in one transaction: `meta`
// (the tiny `generatedAt` validator, so the conditional request goes out
// without first reading the body) and `body` (the text, parsed per caller).
// Storage is best-effort: no IndexedDB (sandboxed iframe, private mode, quota)
// just means plain network loads, and a failed open is tried again after a
// short cool-down. `persistentCache: false` turns it off.

const JACS_DB = 'cxai-map-sdk';
const META = 'meta';
const BODY = 'body';
// The query JMap v4 sends (`?v=4.12`) — the response shape it expects.
const JACS_VERSION_QUERY = 'v=4.12';

interface JacsMeta { generatedAt: number | string }

// The open connection, or the open in progress. A failed or blocked open is
// not kept: for JACS_DB_RETRY_MS every call gets null without trying (a page
// with no usable IndexedDB doesn't reopen per call), then the next call opens
// again (a transient UnknownError, a frame later granted storage).
let jacsDbPromise: Promise<IDBDatabase | null> | null = null;
let jacsDbRetryAt = 0;
const JACS_DB_RETRY_MS = 10_000;

function openJacsDb(): Promise<IDBDatabase | null> {
	if (jacsDbPromise) return jacsDbPromise;
	if (Date.now() < jacsDbRetryAt) return Promise.resolve(null);
	const forget = () => { if (jacsDbPromise === opened) jacsDbPromise = null; };
	const opened: Promise<IDBDatabase | null> = new Promise<IDBDatabase | null>((resolve) => {
		try {
			if (typeof indexedDB === 'undefined') return resolve(null);
			const req = indexedDB.open(JACS_DB, 1);
			let settled = false;
			req.onupgradeneeded = () => {
				req.result.createObjectStore(META);
				req.result.createObjectStore(BODY);
			};
			req.onsuccess = () => {
				const db = req.result;
				if (settled) return db.close(); // a blocked open that got through later
				settled = true;
				// Another tab upgrading or deleting the database, or the browser
				// dropping the connection: let go of it so the next call reopens.
				db.onversionchange = () => { db.close(); forget(); };
				db.onclose = forget;
				flushJacsClear(db); // ahead of every caller's transaction
				resolve(db);
			};
			req.onerror = () => { settled = true; resolve(null); };
			req.onblocked = () => { settled = true; resolve(null); };
		} catch {
			resolve(null);
		}
	}).then((db) => {
		if (!db) {
			forget();
			jacsDbRetryAt = Date.now() + JACS_DB_RETRY_MS;
		}
		return db;
	});
	jacsDbPromise = opened;
	return opened;
}

// Runs `run` in one transaction over `stores`; resolves with its request's
// result once the transaction completes, or null on any failure.
function jacsTx<T>(
	stores: string[],
	mode: IDBTransactionMode,
	run: (tx: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | null> {
	return openJacsDb().then((db) => new Promise<T | null>((resolve) => {
		if (!db) return resolve(null);
		try {
			const tx = db.transaction(stores, mode);
			const req = run(tx);
			tx.oncomplete = () => resolve(req ? (req.result as T) ?? null : null);
			tx.onerror = () => resolve(null);
			tx.onabort = () => resolve(null);
		} catch {
			resolve(null);
		}
	}));
}

const readMeta = (url: string) => jacsTx<JacsMeta>([META], 'readonly', (tx) => tx.objectStore(META).get(url));
const readBody = (url: string) => jacsTx<string>([BODY], 'readonly', (tx) => tx.objectStore(BODY).get(url));

// Bumped by clearJacsStore. A fetch captures it when it starts, and its write
// is dropped if a clear happened since.
let jacsGeneration = 0;

// Set by a clear until its transaction exists. A clear that finds no database
// (open failed or cooling down, connection closing) stays pending and runs as
// the first transaction of the next successful open, so a copy the page could
// not reach at clear time is still gone before anything reads it.
let jacsClearPending = false;

// Readwrite transactions over the same stores run in the order they are
// created. The generation moves on synchronously here, and saveJacs reads it
// in the same turn it creates its transaction, so a write either comes before
// the clear's transaction (and is wiped by it) or sees the new generation and
// writes nothing.
function clearJacsStore(): void {
	jacsGeneration++;
	jacsClearPending = true;
	void openJacsDb().then((db) => { if (db) flushJacsClear(db); });
}

function flushJacsClear(db: IDBDatabase): void {
	if (!jacsClearPending) return;
	try {
		const tx = db.transaction([META, BODY], 'readwrite');
		tx.objectStore(META).clear();
		tx.objectStore(BODY).clear();
		jacsClearPending = false;
	} catch {
		// Connection closing: stays pending for the next open.
	}
}

// Writes the copy once the browser is idle — structured-cloning a 54 MB string
// competes with the first render otherwise. Body and validator go in one
// transaction, so a validator never points at a missing or older body.
function saveJacs(url: string, text: string, generation: number): void {
	const generatedAt = generatedAtOf(text);
	if (generatedAt == null) return; // nothing to revalidate with
	const write = () => {
		void jacsTx([META, BODY], 'readwrite', (tx) => {
			// Checked as the transaction is created, not before the database
			// open resolves (see clearJacsStore).
			if (generation !== jacsGeneration) return; // cleared since the fetch began
			tx.objectStore(BODY).put(text, url);
			tx.objectStore(META).put({ generatedAt } satisfies JacsMeta, url);
		});
	};
	const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
	if (idle) idle(write, { timeout: 5000 });
	else setTimeout(write, 1000);
}

// The top-level `generatedAt` is among the last keys of a `/full` body (only
// small scalars follow it), so the last match in the tail is the top-level
// one — no need to keep a parsed copy around for it.
function generatedAtOf(text: string): number | string | null {
	const re = /"generatedAt"\s*:\s*(?:(-?\d+(?:\.\d+)?)|"([^"]*)")/g;
	const tail = text.slice(-4096);
	let last: RegExpExecArray | null = null;
	for (let m = re.exec(tail); m; m = re.exec(tail)) last = m;
	if (!last) return null;
	return last[1] != null ? Number(last[1]) : last[2];
}

export function jacsVenueUrl(cfg: JibestreamConfig): string {
	return jacsUrl(cfg, `venue/${cfg.venueId}/full`);
}

export function jacsBuildingUrl(cfg: JibestreamConfig, buildingId: number): string {
	return jacsUrl(cfg, `venue/${cfg.venueId}/building/${buildingId}/full`);
}

function jacsUrl(cfg: JibestreamConfig, path: string): string {
	const url = new URL(`${cfg.host}/JACS/api/customer/${cfg.customerId}/${path}?${JACS_VERSION_QUERY}`);
	if (cfg.mapProfileId != null) url.searchParams.set('mapProfileId', String(cfg.mapProfileId));
	return url.toString();
}

// One network request per URL at a time: the venue is read by both
// loadVenue (destination index) and the engine (handed to JMap).
const jacsInflight = new Map<string, Promise<string>>();

/**
 * GETs a JACS `/full` response as text: from the IndexedDB copy when JACS
 * answers 304 to `If-Modified-Since: <generatedAt>`, else from the network
 * (and stored for next time). A network or server failure falls back to the
 * stored copy when there is one.
 */
export function fetchJacsText(cfg: JibestreamConfig, url: string, logger?: MapLogger): Promise<string> {
	const hit = jacsInflight.get(url);
	if (hit) return hit;
	const jibLog = makeJibLog(logger);
	const useStore = cfg.persistentCache !== false;
	const generation = jacsGeneration;
	const p = (async () => {
		const [meta, token] = await Promise.all([
			useStore ? readMeta(url) : Promise.resolve(null),
			getToken(cfg, logger),
		]);
		// Read the stored body while the request is in flight.
		const stored = meta ? readBody(url) : Promise.resolve(null);
		const get = (conditional: boolean) => fetch(url, {
			headers: conditional
				? { Authorization: `Bearer ${token}`, 'If-Modified-Since': String(meta!.generatedAt) }
				: { Authorization: `Bearer ${token}` },
		});
		let res: Response;
		try {
			res = await get(!!meta);
		} catch (err) {
			const text = await stored;
			if (text != null) { jibLog('cache', `network failed, using stored copy of ${url}`, err); return text; }
			throw err;
		}
		if (res.status === 304) {
			const text = await stored;
			if (text != null) { jibLog('cache', `not modified: ${url}`); return text; }
			res = await get(false); // validator without a body (evicted) — fetch it whole
		}
		if (!res.ok) {
			const text = res.status >= 500 ? await stored : null;
			if (text != null) { jibLog('cache', `JACS ${res.status}, using stored copy of ${url}`); return text; }
			throw new Error(`Jibestream fetch failed: ${res.status} ${url.replace(/\?.*$/, '')}`);
		}
		const text = await res.text();
		if (useStore) saveJacs(url, text, generation);
		return text;
	})();
	jacsInflight.set(url, p);
	const clear = () => { if (jacsInflight.get(url) === p) jacsInflight.delete(url); };
	p.then(clear, clear);
	return p;
}

/** The venue's raw `/full` JSON (`?v=4.12` — the shape JMap consumes). */
export async function fetchVenueJson(cfg: JibestreamConfig, logger?: MapLogger): Promise<Record<string, unknown>> {
	return JSON.parse(await fetchJacsText(cfg, jacsVenueUrl(cfg), logger));
}

/** A building's raw `/full` JSON — every floor's map, SVG included. */
export async function fetchBuildingJson(cfg: JibestreamConfig, buildingId: number, logger?: MapLogger): Promise<Record<string, unknown>> {
	return JSON.parse(await fetchJacsText(cfg, jacsBuildingUrl(cfg, buildingId), logger));
}

/**
 * The building the stored venue copy names as default, or null with no copy.
 * Lets a repeat open revalidate the building alongside the venue instead of
 * after it (JACS takes ~1.2 s to answer the building's 304). The engine
 * checks it against the venue JMap actually populates.
 */
export async function storedDefaultBuildingId(cfg: JibestreamConfig): Promise<number | null> {
	if (cfg.persistentCache === false) return null;
	const text = await readBody(jacsVenueUrl(cfg));
	if (text == null) return null;
	try { return defaultBuildingIdOf(JSON.parse(text)); } catch { return null; }
}

/**
 * The building JMap will populate by default, read from the raw venue the way
 * JMap's `buildings.getDefault()` does: `defaultBuildingId`, else the first.
 */
export function defaultBuildingIdOf(rawVenue: Record<string, unknown>): number | null {
	const explicit = Number(rawVenue.defaultBuildingId);
	if (Number.isFinite(explicit) && explicit > 0) return explicit;
	const items = (rawVenue.buildings as { items?: Array<{ id?: unknown }> } | undefined)?.items;
	const first = Number(items?.[0]?.id);
	return Number.isFinite(first) && first > 0 ? first : null;
}

/**
 * Returns the cached token's `expiresAt` (epoch ms) for this config's cache
 * key, or null if no token is cached. Used by the JMap auth shim to schedule
 * a background refresh ~30s before TTL expiry so sync property reads
 * (`shim.token`, etc.) stay current even when JMap never invokes the async
 * getters.
 */
export function peekTokenExpiry(cfg: JibestreamConfig): number | null {
	return caches.get(cacheKey(cfg))?.tokenCache?.expiresAt ?? null;
}

export async function loadVenue(cfg: JibestreamConfig, logger?: MapLogger): Promise<VenueData> {
	const jibLog = makeJibLog(logger);
	const entry = cacheFor(cfg);
	const hit = entry.venuePromise;
	if (hit) return hit;
	jibLog('venue', `fetching customer=${cfg.customerId} venue=${cfg.venueId}`);
	// Local reference for the catch identity check — mirrors the thisInflight
	// pattern in getToken so a rejection from an old mount can't clobber a
	// fresh venue cache entry installed by a concurrent new-mount loadVenue call.
	const thisVenueCache: Promise<VenueData> = (async () => {
		// Same request (and IndexedDB copy) the engine hands to JMap — fetched
		// once, not once here and again inside JMap.
		const raw = await fetchVenueJson(cfg, logger) as { id: number; name: string; destinations?: { items?: RawDestination[] } };
		// Project the raw JACS destination items to the fields the SDK actually
		// consumes ({id, name, locations:{mapId, waypointIds}}). The raw items
		// carry large unprojected sub-objects (polygons, styling, etc.) that are
		// never read — retaining them held ×MAX_CACHE_ENTRIES copies alive.
		// This is a PURE field-narrowing: the single projected object is shared
		// by identity across `destinations`, `byWaypointId`, and `byName` exactly
		// as the raw object was, and every consumer only ever touches id/name/
		// locations (verified: engine reads dest.locations[0].mapId; resolve*
		// use id/name; the meta.waypointIds path reads a JMap unit, not this).
		const rawItems: RawDestination[] = raw.destinations?.items ?? [];
		const destinations: Destination[] = rawItems.map((d) => ({
			id: d.id,
			name: d.name,
			locations: (d.locations ?? []).map((loc) => ({
				mapId: loc.mapId,
				waypointIds: loc.waypointIds ?? [],
			})),
		}));
		const byWaypointId = new Map<number, Destination>();
		const byName = new Map<string, Destination>();
		for (const d of destinations) {
			byName.set(d.name.toLowerCase(), d);
			for (const loc of d.locations) {
				for (const wp of loc.waypointIds) byWaypointId.set(wp, d);
			}
		}
		jibLog('venue', `loaded "${raw.name}" — ${destinations.length} destinations`);
		return { id: raw.id, name: raw.name, destinations, byWaypointId, byName };
	})();
	entry.venuePromise = thisVenueCache;
	try {
		return await thisVenueCache;
	} catch (e) {
		if (entry.venuePromise === thisVenueCache) entry.venuePromise = null;
		jibLog('venue', 'load failed', e);
		throw e;
	}
}

export function resolveDestination(
	venue: VenueData,
	opts: { externalId?: string | number; name?: string },
): Destination | null {
	if (opts.externalId != null) {
		const ext = Number(opts.externalId);
		if (Number.isFinite(ext)) {
			const hit = venue.byWaypointId.get(ext);
			if (hit) return hit;
		}
	}
	if (opts.name) {
		const hit = venue.byName.get(opts.name.toLowerCase());
		if (hit) return hit;
	}
	return null;
}
