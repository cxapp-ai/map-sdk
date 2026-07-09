/**
 * Drift guard for the hand-authored entry declaration.
 *
 * src/index.public.d.ts is copied verbatim to dist/index.d.ts (the published
 * `.` entry's types). This file makes `npm run check` fail when it diverges
 * from the real module: the two surfaces must stay mutually assignable, so a
 * renamed/removed/added/mistyped export in either file is a compile error
 * here ("Type 'false' does not satisfy the constraint 'true'" — compare
 * PublicSurface vs RealSurface to find the drifted export).
 *
 * Type-only on purpose: nothing imports this module and it is excluded from
 * the library build graph (vite-plugin-dts' include list doesn't cover it),
 * so it never contributes runtime code.
 */
type PublicSurface = typeof import('./index.public.js');
type RealSurface = typeof import('./index.js');

type Assert<T extends true> = T;

// Real module provides everything the declaration promises (nothing missing)…
type _RealCoversPublic = Assert<RealSurface extends PublicSurface ? true : false>;
// …and the declaration covers everything the real module exports (no
// undeclared surface silently shipping untyped).
type _PublicCoversReal = Assert<PublicSurface extends RealSurface ? true : false>;

export {};
