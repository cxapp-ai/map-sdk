import type { MapStrings } from './types.js';

/**
 * English defaults for every UI string the SDK renders.
 *
 * Ported from nova-chat-sdk src/i18n/strings.ts — every key
 * ResourceMinimap.svelte read via useStrings(), flattened from the nested
 * `strings.minimap / resource / booking / common` sections to flat camelCase
 * keys, values unchanged. Keys that only served the deleted inline-preview /
 * modal chrome (errorPrefix, dismissError, expandMap, floor, selectFloor,
 * alreadyBooked, errorMissingDate, errorChatDisconnected, errorNovaBusy) are
 * intentionally not carried over — the ported view never reads them.
 *
 * Hosts override per-key via `options.strings`; missing keys fall back to
 * these English values (merge happens in the view layer).
 */
export const DEFAULT_STRINGS: MapStrings = {
	// minimap.*
	loadingMap: 'Loading map…',
	errorContainerNotMounted: 'Map container not mounted',
	errorContainerNoSize: 'Map container has no size',
	mapFailedToLoad: 'Map failed to load',
	suggestedSpaces: 'Suggested spaces', // aria-label for the resource carousel
	notShownOnMap: 'not shown on map', // "{count} not shown on map"
	showColleagues: 'Show colleagues',
	hideColleagues: 'Hide colleagues',
	colleaguesError: "Couldn't load colleagues",
	noColleagues: 'No colleagues booked',
	// booking.*
	navigate: 'Navigate',
	// resource.*
	book: 'Book',
	booking: 'Booking…',
	booked: 'Booked',
	errorMissingResourceName: 'Missing resource name',
	errorNoResponse: 'No response — try again.',
	// common.*
	tryAgain: 'Try again',
	// overlay / a11y — exact keys read by src/ui/IndoorMap.svelte:
	youAreHere: 'You are here', // aria-label for the GPS "you are here" dot
	routeStart: 'Route start', // aria-label for the wayfinding start marker
	pinPrefix: 'Pin', // aria-label prefix: `${pinPrefix} <name>`
	destinationPrefix: 'Destination', // aria-label prefix: `${destinationPrefix} <name>`
	distanceAwayMeters: '{d}m away', // off-venue chip; {d} = integer metres
	distanceAwayKilometers: '{d}km away', // off-venue chip; {d} = one-decimal km
	userFarawayLabel: 'You are {d} from the venue', // {d} = formatted distance label
	selectedLocationPrefix: 'Selected location', // aria-label prefix for the location-select pin
};
