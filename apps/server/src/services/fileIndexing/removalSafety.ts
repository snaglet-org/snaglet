/**
 * removalSafety — the rules that decide when the index may forget files.
 *
 * Removing a file row deletes its node and drops its embedding references, so a
 * false "this file is gone" is data loss. Two incidents came from exactly that:
 * a moved project folder drained thousands of watcher removals, and
 * a reconcile that couldn't read a folder treated it as empty. The
 * root-identity and unreadable-subtree checks close those specific causes; the
 * mass-removal backstop here is defense in depth for causes nobody has thought
 * of yet (iCloud eviction, flaky network volumes, …).
 */

import path from 'node:path';

/** A removal batch must exceed both this many rows… */
const MASS_REMOVAL_MIN_ROWS = 200;
/** …and this share of the project's indexed rows to be held back. */
const MASS_REMOVAL_MIN_SHARE = 0.5;

/**
 * True when one drain/reconcile would remove more than half of a project's rows
 * AND more than 200 rows. Such a batch is held (kept, logged, surfaced on the
 * project's indexing status) instead of applied.
 */
export function isMassRemoval(removals: number, totalRows: number): boolean {
  return removals > MASS_REMOVAL_MIN_ROWS && removals > totalRows * MASS_REMOVAL_MIN_SHARE;
}

/** A confirmed release tolerates this much drift from the count the person saw. */
const HELD_RELEASE_TOLERANCE = 0.1;

/**
 * True when a fresh removal count still matches the held count a person
 * confirmed: within ±10% of `expected`, and never more than
 * ceil(expected × 1.1). Anything else means the folder changed since they
 * looked, so the release is refused and they must look again.
 */
export function heldRemovalsMatch(found: number, expected: number): boolean {
  if (!Number.isInteger(expected) || expected <= 0) return false;
  const max = Math.ceil(expected * (1 + HELD_RELEASE_TOLERANCE));
  const min = Math.floor(expected * (1 - HELD_RELEASE_TOLERANCE));
  return found >= min && found <= max;
}

/**
 * True when `relPath` lies inside one of `dirs` (project-relative). `''` is the
 * root, which contains everything.
 */
export function isUnderAnyDir(relPath: string, dirs: readonly string[]): boolean {
  return dirs.some((dir) => dir === '' || relPath === dir || relPath.startsWith(dir + path.sep));
}
