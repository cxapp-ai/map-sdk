import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

// Static server for the raw-HTML pages under pages/ (MOO-598 ticket picker).
// The pages load the BUILT IIFE (`../../dist/map-sdk.iife.js`) via a classic
// <script>, exactly as they will in production — so run `npm run build`
// first, and again after SDK changes (there is no hot reload of the SDK
// here; the demo/ harness is the source-hot-reload path).
//
// Root is the repo root so `../../dist/…` resolves. Open
// http://localhost:4310/pages/moo/facilities.html (or it.html).
//
// Fixed, out-of-the-way port + strictPort on purpose: with vite's default
// (5173, auto-increment when busy) another vite dev server on 517x/518x —
// e.g. nova-chat-sdk — silently answers this URL with ITS index.html for
// every path, including ../../dist/map-sdk.iife.js, and the wrong app boots.
// Fail loudly instead.
//
// The svelte plugin is unused by these pages; it is here only because
// svelte-check loads every vite.config.* it finds and errors without one.
export default defineConfig({
	root: fileURLToPath(new URL('..', import.meta.url)),
	plugins: [svelte()],
	appType: 'mpa',
	server: {
		port: 4310,
		strictPort: true,
	},
});
