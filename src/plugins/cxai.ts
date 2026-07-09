/**
 * Optional NavigationPlugin for CX-host WebViews — the legacy
 * `window.__cxaicommand` bridge, ported from nova-chat-sdk
 * src/utils/cxai-command.ts (SCPB-3340). Self-contained: no runtime imports.
 *
 * Bridge contract: each host (cx_ios, cx_android_business, cx_web) injects
 * `window.__cxaicommand(cmd, args)` into the WebView; the embedded page just
 * calls that function and the host routes the command into its central
 * router. The SDK never depends on a specific channel (postMessage, WebKit
 * handler, etc.) — only on this contract.
 *
 * Per types.ts the plugin is NOT auto-detected by the SDK: hosts opt in with
 * `navigation: cxaiNavigationPlugin() ?? undefined`.
 */
import type { MapResource, NavigationPlugin } from '../types.js';

type CxaiCommandFn = (cmd: string, args: Record<string, unknown>) => void;

function getBridge(): CxaiCommandFn | null {
	if (typeof window === 'undefined') return null;
	// The SDK is frequently embedded in an <iframe srcdoc> (about:srcdoc),
	// whose own `window` does NOT carry the host bridge — the host injects
	// `__cxaicommand` on the top-level WebView window. Walk self → parent → …
	// → top and use the first frame that has it. srcdoc/same-origin ancestors
	// allow this read; a cross-origin ancestor throws on access, so we stop
	// walking there (the host must inject into the frame or use postMessage).
	let win: Window | null = window;
	for (let i = 0; win && i < 10; i++) {
		try {
			const fn = (win as unknown as { __cxaicommand?: unknown }).__cxaicommand;
			if (typeof fn === 'function') return fn as CxaiCommandFn;
		} catch {
			// Cross-origin ancestor — can't read past this boundary.
			break;
		}
		const parent: Window = win.parent;
		if (!parent || parent === win) break; // reached the top frame
		win = parent;
	}
	return null;
}

function hasCxaiCommand(): boolean {
	return getBridge() !== null;
}

function cxaiCommand(cmd: string, args: Record<string, unknown>): boolean {
	const fn = getBridge();
	if (!fn) return false;
	try {
		fn(cmd, args);
		return true;
	} catch (err) {
		console.warn('[map-sdk] __cxaicommand threw', err);
		return false;
	}
}

interface NavigatePayload {
	externalId: string | number;
	buildingExternalId?: string | number | null;
	floorId?: string | number | null;
}

/**
 * Build the `p_live_map` deeplink the host's central router consumes. The
 * iOS side already accepts this exact shape via CXRoute (placemark/buildingId/
 * floorId) and routes it into routeToPlacemark; web/android implement the
 * same URL contract on their end.
 */
function buildLiveMapDeeplink(payload: NavigatePayload): string | null {
	if (payload.externalId === undefined || payload.externalId === null || payload.externalId === '') {
		return null;
	}
	const params = new URLSearchParams();
	params.set('placemark', String(payload.externalId));
	if (payload.buildingExternalId != null && payload.buildingExternalId !== '') {
		params.set('buildingId', String(payload.buildingExternalId));
	}
	if (payload.floorId != null && payload.floorId !== '') {
		params.set('floorId', String(payload.floorId));
	}
	return `p_live_map?${params.toString()}`;
}

function requestNavigation(payload: NavigatePayload): boolean {
	const url = buildLiveMapDeeplink(payload);
	if (!url) return false;
	return cxaiCommand('deeplink', { url });
}

/**
 * Wrap the `__cxaicommand` bridge as a NavigationPlugin for
 * `options.navigation`. Returns null when the bridge is absent (plain web
 * preview, bridge not yet injected) so hosts can gate:
 *
 *   navigation: cxaiNavigationPlugin() ?? undefined
 *
 * Presence is evaluated at CALL time — call this after the host shell has
 * injected `window.__cxaicommand`.
 */
export function cxaiNavigationPlugin(): NavigationPlugin | null {
	if (!hasCxaiCommand()) return null;
	return {
		onNavigate(resource: MapResource): void {
			// The view already gates the Navigate button on a present
			// externalId; keep the guard for direct callers.
			if (resource.externalId == null || resource.externalId === '') return;
			// buildingExternalId scopes the placemark to the right building's
			// venue (a campus can span several). floorId is DELIBERATELY
			// omitted — the host resolves the floor from the placemark.
			// (Ported from ResourceMinimap.navigateToResource.)
			requestNavigation({
				externalId: resource.externalId,
				buildingExternalId: resource.buildingExternalId ?? null,
			});
		},
	};
}
