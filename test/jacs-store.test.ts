// The IndexedDB copy of the JACS `/full` responses (src/core/jibestream.ts):
// a clear must leave the store empty whatever order the writes, the clear and
// the database open land in, and a failed open must not turn the store off for
// the life of the page.

import { IDBDatabase as FakeIDBDatabase, IDBFactory, forceCloseDatabase } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { JibestreamConfig } from '../src/types.js';

type Jib = typeof import('../src/core/jibestream.js');

const DB = 'cxai-map-sdk';
const GENERATED_AT = 1760000000000;
const VENUE_TEXT = JSON.stringify({ id: 2, name: 'Venue', defaultBuildingId: 3, generatedAt: GENERATED_AT });
// Longer than any cool-down the store waits out after a failed open.
const LATER = 60_000;

const cfg: JibestreamConfig = {
	host: 'https://jacs.test',
	customerId: 1,
	venueId: 2,
	auth: { getToken: async () => ({ accessToken: 'token', expiresInSeconds: 3600 }) },
};

// How the next indexedDB.open calls behave; an empty plan opens normally.
//   throw   – open() throws (sandboxed frame, storage blocked)
//   error   – the request fails (transient UnknownError)
//   blocked – the request is blocked, then succeeds once releaseOpen() is called
//   held    – the request succeeds once releaseOpen() is called
type OpenStep = 'throw' | 'error' | 'blocked' | 'held';

let jib: Jib;
let idb: IDBFactory;
let now: number;
let idle: Array<() => void>;
let requests: Array<string | null>; // If-Modified-Since of each JACS request
let openPlan: OpenStep[];
let openCalls: number;
let connections: IDBDatabase[];
let lateConnectionClosed: Mock<() => void>;
let releaseOpen: () => void;
let transactions: Array<{ mode: IDBTransactionMode; done: boolean }>;

function openWith(name: string, version?: number): IDBOpenDBRequest {
	openCalls++;
	const step = openPlan.shift();
	if (step === 'throw') throw new DOMException('storage denied', 'SecurityError');
	if (step === 'error') {
		const failing = { result: undefined, error: new DOMException('', 'UnknownError') } as unknown as IDBOpenDBRequest;
		setTimeout(() => failing.onerror?.call(failing, new Event('error')));
		return failing;
	}
	const req = idb.open(name, version);
	req.addEventListener('success', () => connections.push(req.result));
	if (!step) return req;
	// Stand-in request: upgrades go straight through, success waits for releaseOpen().
	const gated = {
		get result() { return req.result; },
		get error() { return req.error; },
	} as unknown as IDBOpenDBRequest;
	req.onupgradeneeded = (e) => gated.onupgradeneeded?.call(gated, e);
	req.onerror = (e) => gated.onerror?.call(gated, e);
	let release!: () => void;
	const released = new Promise<void>((r) => { release = r; });
	releaseOpen = release;
	req.onsuccess = (e) => void released.then(() => {
		if (step === 'blocked') {
			const db = req.result;
			const close = db.close.bind(db);
			lateConnectionClosed.mockImplementation(close);
			db.close = lateConnectionClosed;
		}
		gated.onsuccess?.call(gated, e);
	});
	if (step === 'blocked') {
		setTimeout(() => gated.onblocked?.call(gated, new Event('blocked') as IDBVersionChangeEvent));
	}
	return gated;
}

beforeEach(async () => {
	vi.resetModules();
	idb = new IDBFactory();
	openPlan = [];
	openCalls = 0;
	connections = [];
	lateConnectionClosed = vi.fn<() => void>();
	releaseOpen = () => {};
	vi.stubGlobal('indexedDB', { open: openWith });
	now = 1_000_000;
	vi.spyOn(Date, 'now').mockImplementation(() => now);
	idle = [];
	vi.stubGlobal('requestIdleCallback', (cb: () => void) => { idle.push(cb); });
	requests = [];
	vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
		const since = new Headers(init?.headers).get('If-Modified-Since');
		requests.push(since);
		return since === String(GENERATED_AT)
			? new Response(null, { status: 304 })
			: new Response(VENUE_TEXT, { status: 200 });
	}));
	transactions = [];
	const transaction = FakeIDBDatabase.prototype.transaction;
	vi.spyOn(FakeIDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
		const tx = transaction.apply(this, args);
		const entry = { mode: tx.mode, done: false };
		transactions.push(entry);
		tx.addEventListener('complete', () => { entry.done = true; });
		return tx;
	});
	jib = await import('../src/core/jibestream.js');
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const loadVenue = () => jib.fetchJacsText(cfg, jib.jacsVenueUrl(cfg));
const runIdle = () => { for (const cb of idle.splice(0)) cb(); };
const settle = () => new Promise((r) => setTimeout(r, 20));
const microtasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const lastRequest = () => requests[requests.length - 1];

// Opens the venue twice with the idle write in between; the second open should
// be a 304 served from the store.
async function expectStoreWorks(): Promise<void> {
	await loadVenue();
	runIdle();
	await settle();
	expect(await loadVenue()).toBe(VENUE_TEXT);
	expect(lastRequest()).toBe(String(GENERATED_AT));
}

// A copy left by an earlier page session.
async function seedStore(): Promise<void> {
	const db = await new Promise<IDBDatabase>((resolve) => {
		const req = idb.open(DB, 1);
		req.onupgradeneeded = () => {
			req.result.createObjectStore('meta');
			req.result.createObjectStore('body');
		};
		req.onsuccess = () => resolve(req.result);
	});
	await new Promise<void>((resolve) => {
		const tx = db.transaction(['meta', 'body'], 'readwrite');
		tx.objectStore('body').put(VENUE_TEXT, jib.jacsVenueUrl(cfg));
		tx.objectStore('meta').put({ generatedAt: GENERATED_AT }, jib.jacsVenueUrl(cfg));
		tx.oncomplete = () => resolve();
	});
	db.close();
}

describe('stored JACS copy', () => {
	it('revalidates with If-Modified-Since and serves the 304 from the store', async () => {
		expect(await loadVenue()).toBe(VENUE_TEXT);
		expect(lastRequest()).toBeNull();
		await expectStoreWorks();
	});
});

describe('clearJibestreamCaches against a pending write', () => {
	it('drops a write still queued for idle time', async () => {
		await loadVenue();
		jib.clearJibestreamCaches();
		runIdle();
		await loadVenue();
		expect(lastRequest()).toBeNull();
	});

	it('wipes a write that ran in the same tick, just before the clear', async () => {
		await loadVenue();
		runIdle();
		jib.clearJibestreamCaches();
		await loadVenue();
		expect(lastRequest()).toBeNull();
	});

	it('wipes a write whose transaction is already open', async () => {
		await loadVenue();
		runIdle();
		await microtasks();
		const write = transactions.find((t) => t.mode === 'readwrite');
		expect(write).toMatchObject({ done: false });
		jib.clearJibestreamCaches();
		await loadVenue();
		expect(lastRequest()).toBeNull();
	});

	it('drops a write still waiting for the database to open', async () => {
		openPlan = ['error', 'held'];
		await loadVenue(); // no database: network, write queued
		now += LATER;
		runIdle(); // the write reopens the database, held open
		jib.clearJibestreamCaches();
		releaseOpen();
		await settle();
		await loadVenue();
		expect(lastRequest()).toBeNull();
		await expectStoreWorks();
	});
});

describe('opening the store', () => {
	it.each(['throw', 'error'] as const)('retries after a failed open (%s)', async (step) => {
		openPlan = [step];
		await loadVenue();
		runIdle();
		await settle();
		await loadVenue();
		expect(requests).toEqual([null, null]);
		expect(openCalls).toBe(1); // no reopen per call while it's failing
		now += LATER;
		await expectStoreWorks();
		expect(openCalls).toBe(2);
	});

	it('gives up on a blocked open without holding the late connection, then retries', async () => {
		openPlan = ['blocked'];
		expect(await loadVenue()).toBe(VENUE_TEXT);
		releaseOpen();
		await settle();
		expect(lateConnectionClosed).toHaveBeenCalled();
		now += LATER;
		await expectStoreWorks();
	});

	it('empties a store it could not open at clear time once it opens', async () => {
		await seedStore();
		openPlan = ['error'];
		await loadVenue();
		jib.clearJibestreamCaches();
		now += LATER;
		await loadVenue();
		expect(lastRequest()).toBeNull(); // the earlier session's copy is gone
		await expectStoreWorks();
	});

	it('lets another tab delete the database, then reopens', async () => {
		await expectStoreWorks();
		const outcome = await new Promise<string>((resolve) => {
			const req = idb.deleteDatabase(DB);
			req.onsuccess = () => resolve('deleted');
			req.onblocked = () => resolve('blocked');
		});
		expect(outcome).toBe('deleted');
		await loadVenue();
		expect(lastRequest()).toBeNull(); // fresh database
		await expectStoreWorks();
	});

	it('reopens after the browser closes the connection', async () => {
		await expectStoreWorks();
		// Typed as taking the class; it takes the connection.
		forceCloseDatabase(connections[0] as unknown as typeof FakeIDBDatabase);
		await expectStoreWorks();
		expect(connections).toHaveLength(2);
	});
});
