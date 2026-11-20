/**
 * Pure planning logic for thread trimming (no DB access).
 *
 * Runs are indivisible. Turn replay (chatPhases/replayAssembly.ts) groups a run's
 * assistant messages and activity rows into one unit and still renders a run
 * whose messages are gone, while deleting a run strips its messages of their
 * tool context (`messages.run_id` is ON DELETE SET NULL). So boundaries snap to
 * messages, then the retained interval grows until no run straddles an edge;
 * the preview shows that grown interval and flags that it moved.
 */

import type { ThreadTrimSides } from '@snaglet/shared/types';

/** The ordinal span a run's messages occupy in `(created_at, id)` order. */
export interface RunMessageSpan {
  runId: string;
  /** Lowest 0-based ordinal among this run's messages. */
  lo: number;
  /** Highest 0-based ordinal among this run's messages. */
  hi: number;
}

export interface RetainedInterval {
  first: number;
  last: number;
}

export interface RunAtomicityResult extends RetainedInterval {
  /** True when the interval had to grow to keep runs whole. */
  expanded: boolean;
}

/**
 * Grow `[first, last]` until every run that overlaps it is fully inside it.
 *
 * Iterated to a fixpoint because absorbing one run can pull in ordinals owned
 * by another run (agents interleave freely in a shared thread). Each pass can
 * only widen the interval and the interval is bounded by the thread length, so
 * this terminates; in practice it settles in one or two passes.
 */
export function expandForRunAtomicity(
  first: number,
  last: number,
  spans: readonly RunMessageSpan[]
): RunAtomicityResult {
  let lo = first;
  let hi = last;
  let changed = true;
  while (changed) {
    changed = false;
    for (const span of spans) {
      // Overlap test on closed intervals.
      if (span.hi < lo || span.lo > hi) continue;
      if (span.lo < lo) {
        lo = span.lo;
        changed = true;
      }
      if (span.hi > hi) {
        hi = span.hi;
        changed = true;
      }
    }
  }
  return { first: lo, last: hi, expanded: lo !== first || hi !== last };
}

/**
 * Normalize a requested retained interval against the thread's real length.
 *
 * There is one operation — "keep messages `first` through `last`" — so this only
 * has to make the pair sane: clamp both handles into the thread and swap them if
 * they crossed. Reversed handles are swapped rather than rejected, because the
 * slider can cross its own handles mid-drag and there is no useful error to
 * show for it.
 */
export function normalizeRequestedInterval(
  first: number,
  last: number,
  messageCount: number
): RetainedInterval {
  if (messageCount <= 0) return { first: 0, last: -1 };
  const maxIndex = messageCount - 1;
  const clamp = (n: number): number => Math.min(maxIndex, Math.max(0, Math.trunc(n)));
  let lo = clamp(first);
  let hi = clamp(last);
  if (lo > hi) [lo, hi] = [hi, lo];
  return { first: lo, last: hi };
}

/** Which sides this plan actually deletes, given the retained interval. */
export interface TrimSides {
  trimPrefix: boolean;
  trimTail: boolean;
}

/**
 * Which sides a retained interval really cuts.
 *
 * This is the whole reason the contract needs no mode field: a handle left at
 * its extreme cuts nothing on that side, so "trim only the start", "trim only
 * the end" and "trim both" are the three positions of one control rather than
 * three operations. Deriving it also means a plan can never issue a delete whose
 * predicate matches no rows.
 */
export function resolveTrimSides(interval: RetainedInterval, messageCount: number): TrimSides {
  return {
    trimPrefix: interval.first > 0,
    trimTail: interval.last < messageCount - 1,
  };
}

/** The same fact as {@link TrimSides}, named for humans (audit copy, UI). */
export function describeTrimSides(sides: TrimSides): ThreadTrimSides {
  if (sides.trimPrefix && sides.trimTail) return 'both';
  if (sides.trimPrefix) return 'prefix';
  if (sides.trimTail) return 'tail';
  return 'none';
}

/** Raw summary tallies a trim measurement produces, before interpretation. */
export interface SummaryTally {
  /** Every summary on the thread. */
  total: number;
  /** How many the plan deletes — `total` under `removeSummaries`, else 0. */
  removed: number;
  /** How many cover history this plan deletes, deleted or not. */
  invalidated: number;
  removeSummaries: boolean;
}

/** The four buckets a thread's summaries fall into under a plan. */
export interface SummaryPartition {
  removedByChoice: number;
  removedAsInvalidated: number;
  preserved: number;
  repairedCoverage: number;
}

/**
 * Split a thread's summaries into what the plan deletes and what it keeps.
 * Stale coverage is not a reason to delete (a summary is the memory of the
 * history being removed): only `removeSummaries` deletes, so `invalidated` is
 * `repairedCoverage` when unchecked and `removedAsInvalidated` when checked.
 * The two removal buckets partition the deleted set without overlapping.
 */
export function partitionSummaryImpact(tally: SummaryTally): SummaryPartition {
  const removed = Math.max(0, Math.min(tally.removed, tally.total));
  const invalidated = Math.max(0, Math.min(tally.invalidated, tally.total));
  return {
    removedByChoice: Math.max(0, removed - invalidated),
    removedAsInvalidated: Math.min(invalidated, removed),
    preserved: Math.max(0, tally.total - removed),
    repairedCoverage: tally.removeSummaries ? 0 : invalidated,
  };
}
