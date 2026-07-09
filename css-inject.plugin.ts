import type { Plugin } from 'vite';

/**
 * Inlines the CSS that Vite lib-mode extracts (dist/map-sdk.css) into the
 * entry JS chunk as a self-injecting <style> tag, then drops the CSS asset.
 *
 * Why: the SDK's whole UI depends on positional CSS (absolute pins/markers,
 * carousel, floor strip). Shipping a separate stylesheet that the README
 * never imports — and that package.json#exports doesn't even expose — left
 * every documented integration path unstyled, and broke DECISIONS.md #3's
 * requirement that the IIFE build be self-contained for script-tag/WebView
 * hosts. Inlining makes `import '@cxapp-ai/map-sdk'` and the IIFE global
 * carry their own styles with no extra host step.
 *
 * Injection runs at module-evaluation time, is guarded for non-DOM
 * environments (SSR imports are a no-op), and dedupes via a fixed <style> id
 * so a double-load doesn't stack duplicate rules.
 */
export function cssInjectedByJs(entryChunkName = 'index'): Plugin {
	return {
		name: 'map-sdk:css-injected-by-js',
		apply: 'build',
		enforce: 'post',
		generateBundle(_options, bundle) {
			let css = '';
			for (const [fileName, output] of Object.entries(bundle)) {
				if (output.type === 'asset' && fileName.endsWith('.css')) {
					css += String(output.source);
					delete bundle[fileName];
				}
			}
			if (!css) return;
			const chunks = Object.values(bundle).filter(
				(o): o is Extract<typeof o, { type: 'chunk' }> => o.type === 'chunk' && o.isEntry,
			);
			// Prefer the named UI entry (`index`); the /core entry has no CSS.
			const target = chunks.find((c) => c.name === entryChunkName) ?? chunks[0];
			if (!target) {
				this.warn('css-injected-by-js: no entry chunk found; CSS was dropped');
				return;
			}
			// Appended AFTER the chunk body so existing sourcemap segments stay
			// aligned (the injector itself is unmapped, which is fine).
			target.code +=
				`\n(function(){` +
				`if(typeof document==='undefined')return;` +
				`var id='map-sdk-styles';` +
				`if(document.getElementById(id))return;` +
				`var s=document.createElement('style');` +
				`s.id=id;` +
				`s.textContent=${JSON.stringify(css)};` +
				`document.head.appendChild(s);` +
				`})();\n`;
		},
	};
}
