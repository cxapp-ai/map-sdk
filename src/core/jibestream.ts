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
	return `cc:${auth.clientId}`;
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
		const token = await getToken(cfg, logger);
		const url = new URL(
			`${cfg.host}/JACS/api/customer/${cfg.customerId}/venue/${cfg.venueId}/full`,
		);
		if (cfg.mapProfileId != null) {
			url.searchParams.set('mapProfileId', String(cfg.mapProfileId));
		}
		const res = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${token}` },
		});
		if (!res.ok) throw new Error(`Jibestream venue fetch failed: ${res.status}`);
		const raw = await res.json();
		const destinations: Destination[] = raw.destinations?.items ?? [];
		const byWaypointId = new Map<number, Destination>();
		const byName = new Map<string, Destination>();
		for (const d of destinations) {
			byName.set(d.name.toLowerCase(), d);
			for (const loc of d.locations ?? []) {
				for (const wp of loc.waypointIds ?? []) byWaypointId.set(wp, d);
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
		console.error('[jibestream:venue] load failed', e);
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
