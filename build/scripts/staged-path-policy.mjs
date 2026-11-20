// Single source of truth for the desktop staging security policy: the staged
// path denylist and the source-map policy check.
//
// Consumed by both:
//   - apps/desktop/scripts/stage-sidecar.mjs  (runs under plain `node`)
//   - build/scripts/verify-desktop-stage.ts   (runs under `tsx`)
//
// Authored as `.mjs` on purpose: stage-sidecar is plain-node ESM and cannot
// import a `.ts` module, while tsx resolves this `.mjs` cleanly from the
// TypeScript verifier.

/**
 * Staged relative paths (POSIX-separated) that must never appear in a desktop
 * bundle. Matches a forbidden name only as a whole path segment.
 */
export const FORBIDDEN_STAGED_PATH =
  /(^|\/)(?:\.env(?:\.|$)|plans?|tests?|test-results|coverage|\.git)(?:\/|$)/i;

/**
 * True when a staged file violates the build profile's source-map policy.
 * A profile with `sourceMaps: 'none'` must ship no `.map` files at all;
 * `'hidden'` and `'public'` both permit them.
 *
 * @param {string} sourceMaps - the profile's `sourceMaps` setting.
 * @param {string} filePath - the staged file path.
 * @returns {boolean}
 */
export function sourceMapPolicyForbids(sourceMaps, filePath) {
  return sourceMaps === 'none' && filePath.endsWith('.map');
}
