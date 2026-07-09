import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// Demo harness: serves demo/ against the RAW SDK source (no build step), so
// edits to src/ hot-reload. Env (VITE_JIBESTREAM_*) is read from demo/.env.local
// — see demo/README.md; never commit credentials.
export default defineConfig({
	root: p('.'),
	plugins: [svelte()],
	resolve: {
		// Array form: order matters — the '/core' subpath must match before the
		// bare package name (object aliases would prefix-match the bare name
		// first and mangle the subpath).
		alias: [
			{ find: '@cxapp-ai/map-sdk/core', replacement: p('../src/core/index.ts') },
			{ find: '@cxapp-ai/map-sdk', replacement: p('../src/index.ts') },
		],
	},
});
