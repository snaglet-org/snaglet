/**
 * Pure trim-planning logic.
 *
 * The property that matters here is run atomicity: turn replay groups every
 * assistant message carrying a `run_id` together with that run's activity rows
 * into one unit, so a cut through the middle of a run either resurrects tool
 * output the user deleted (activity kept) or strips messages of the tool
 * context that explains them (run deleted, `messages.run_id` SET NULL). The
 * planner must therefore never hand the executor a boundary that splits a run.
 */

import { describe, expect, it } from '@jest/globals';
import {
  describeTrimSides,
  expandForRunAtomicity,
  normalizeRequestedInterval,
  partitionSummaryImpact,
  resolveTrimSides,
  type RunMessageSpan,
} from '@server/domains/threads/trim/threadTrimPlan';

const span = (runId: string, lo: number, hi: number): RunMessageSpan => ({ runId, lo, hi });

describe('expandForRunAtomicity', () => {
  it('leaves an interval alone when no run straddles either edge', () => {
    const spans = [span('r1', 0, 2), span('r2', 4, 6)];
    expect(expandForRunAtomicity(4, 6, spans)).toEqual({ first: 4, last: 6, expanded: false });
  });

  it('grows the lower edge back to the start of a straddled run', () => {
    // Retaining from 5 would delete messages 4 and 5's siblings at 3-4.
    const spans = [span('r1', 3, 6)];
    expect(expandForRunAtomicity(5, 9, spans)).toEqual({ first: 3, last: 9, expanded: true });
  });

  it('grows the upper edge forward to the end of a straddled run', () => {
    const spans = [span('r1', 8, 12)];
    expect(expandForRunAtomicity(2, 9, spans)).toEqual({ first: 2, last: 12, expanded: true });
  });

  it('grows both edges at once', () => {
    const spans = [span('r1', 1, 4), span('r2', 7, 11)];
    expect(expandForRunAtomicity(3, 8, spans)).toEqual({ first: 1, last: 11, expanded: true });
  });

  it('reaches a fixpoint when absorbing one run pulls in another', () => {
    // Interleaved agents: retaining 5 pulls in r2 (4-5), whose lower edge 4
    // lands inside r1 (0-4), which must then be absorbed too.
    const spans = [span('r1', 0, 4), span('r2', 4, 5)];
    expect(expandForRunAtomicity(5, 5, spans)).toEqual({ first: 0, last: 5, expanded: true });
  });

  it('resolves a chain of overlapping runs in one call', () => {
    const spans = [span('a', 0, 3), span('b', 3, 6), span('c', 6, 9), span('d', 20, 22)];
    expect(expandForRunAtomicity(5, 5, spans)).toEqual({ first: 0, last: 9, expanded: true });
  });

  it('is a no-op with no runs at all (a thread of plain user messages)', () => {
    expect(expandForRunAtomicity(3, 7, [])).toEqual({ first: 3, last: 7, expanded: false });
  });

  it('treats a single-message run as already whole', () => {
    const spans = [span('r1', 5, 5)];
    expect(expandForRunAtomicity(5, 5, spans)).toEqual({ first: 5, last: 5, expanded: false });
  });

  it('never shrinks the requested interval', () => {
    const spans = [span('r1', 4, 5)];
    const out = expandForRunAtomicity(0, 20, spans);
    expect(out.first).toBeLessThanOrEqual(0);
    expect(out.last).toBeGreaterThanOrEqual(20);
    expect(out.expanded).toBe(false);
  });
});

describe('normalizeRequestedInterval', () => {
  it('keeps a well-formed interval exactly as asked', () => {
    expect(normalizeRequestedInterval(4, 6, 10)).toEqual({ first: 4, last: 6 });
  });

  it('swaps crossed handles instead of failing', () => {
    expect(normalizeRequestedInterval(8, 2, 10)).toEqual({ first: 2, last: 8 });
  });

  it('clamps out-of-range handles into the thread', () => {
    expect(normalizeRequestedInterval(-5, 999, 10)).toEqual({ first: 0, last: 9 });
  });

  it('truncates fractional handles', () => {
    expect(normalizeRequestedInterval(2.9, 6.1, 10)).toEqual({ first: 2, last: 6 });
  });

  it('reports an empty interval for an empty thread', () => {
    expect(normalizeRequestedInterval(0, 0, 0)).toEqual({ first: 0, last: -1 });
  });

  it('collapses to the single message on a one-message thread', () => {
    expect(normalizeRequestedInterval(0, 0, 1)).toEqual({ first: 0, last: 0 });
    expect(normalizeRequestedInterval(-3, 42, 1)).toEqual({ first: 0, last: 0 });
  });
});

/**
 * The one-control contract: which sides get cut is a *consequence* of where the
 * handles ended up, never a separate declaration. Each case below is a position
 * of the same range control.
 */
describe('resolveTrimSides', () => {
  it('cuts nothing when both handles sit at the very ends', () => {
    expect(resolveTrimSides({ first: 0, last: 9 }, 10)).toEqual({
      trimPrefix: false,
      trimTail: false,
    });
  });

  it('cuts only the prefix when only the first handle moved', () => {
    expect(resolveTrimSides({ first: 3, last: 9 }, 10)).toEqual({
      trimPrefix: true,
      trimTail: false,
    });
  });

  it('cuts only the tail when only the last handle moved', () => {
    expect(resolveTrimSides({ first: 0, last: 5 }, 10)).toEqual({
      trimPrefix: false,
      trimTail: true,
    });
  });

  it('cuts both when both handles moved', () => {
    expect(resolveTrimSides({ first: 3, last: 5 }, 10)).toEqual({
      trimPrefix: true,
      trimTail: true,
    });
  });

  it('cuts both ends of a single retained message', () => {
    expect(resolveTrimSides({ first: 5, last: 5 }, 10)).toEqual({
      trimPrefix: true,
      trimTail: true,
    });
  });

  it('cuts nothing on a one-message thread', () => {
    expect(resolveTrimSides({ first: 0, last: 0 }, 1)).toEqual({
      trimPrefix: false,
      trimTail: false,
    });
  });
});

describe('describeTrimSides', () => {
  it('names each combination for the audit log and confirmation copy', () => {
    expect(describeTrimSides({ trimPrefix: false, trimTail: false })).toBe('none');
    expect(describeTrimSides({ trimPrefix: true, trimTail: false })).toBe('prefix');
    expect(describeTrimSides({ trimPrefix: false, trimTail: true })).toBe('tail');
    expect(describeTrimSides({ trimPrefix: true, trimTail: true })).toBe('both');
  });

  it('agrees with resolveTrimSides at every handle position of a 10-message thread', () => {
    // The confirmation dialog and the audit line must describe the same cut the
    // delete predicate performs — so derive both from one interval and compare.
    for (let first = 0; first < 10; first += 1) {
      for (let last = first; last < 10; last += 1) {
        const sides = resolveTrimSides({ first, last }, 10);
        const expected =
          first > 0 && last < 9 ? 'both' : first > 0 ? 'prefix' : last < 9 ? 'tail' : 'none';
        expect(describeTrimSides(sides)).toBe(expected);
      }
    }
  });
});

/**
 * Summaries are the compressed memory OF the history a trim deletes, so the
 * plan must never destroy one on coverage grounds alone — destroying the
 * messages and the summary loses the information outright, which is the
 * opposite of reclaiming context. Only the explicit `removeSummaries` choice
 * deletes; stale coverage is repaired in place.
 */
describe('partitionSummaryImpact', () => {
  it('keeps and repairs a stale-coverage summary when removal was not asked for', () => {
    expect(
      partitionSummaryImpact({ total: 10, removed: 0, invalidated: 10, removeSummaries: false })
    ).toEqual({
      removedByChoice: 0,
      removedAsInvalidated: 0,
      preserved: 10,
      repairedCoverage: 10,
    });
  });

  it('leaves a summary covering only retained messages entirely alone', () => {
    expect(
      partitionSummaryImpact({ total: 3, removed: 0, invalidated: 0, removeSummaries: false })
    ).toEqual({
      removedByChoice: 0,
      removedAsInvalidated: 0,
      preserved: 3,
      repairedCoverage: 0,
    });
  });

  it('repairs only the stale ones, keeping the rest untouched', () => {
    expect(
      partitionSummaryImpact({ total: 5, removed: 0, invalidated: 2, removeSummaries: false })
    ).toEqual({
      removedByChoice: 0,
      removedAsInvalidated: 0,
      preserved: 5,
      repairedCoverage: 2,
    });
  });

  it('deletes everything and repairs nothing when the user asks for removal', () => {
    // The two reasons partition the deleted set: the 4 stale ones would have
    // been flagged anyway, so only the 6 still-valid ones bill to the checkbox.
    expect(
      partitionSummaryImpact({ total: 10, removed: 10, invalidated: 4, removeSummaries: true })
    ).toEqual({
      removedByChoice: 6,
      removedAsInvalidated: 4,
      preserved: 0,
      repairedCoverage: 0,
    });
  });

  it('bills every deletion to the checkbox when nothing was stale', () => {
    expect(
      partitionSummaryImpact({ total: 4, removed: 4, invalidated: 0, removeSummaries: true })
    ).toEqual({
      removedByChoice: 4,
      removedAsInvalidated: 0,
      preserved: 0,
      repairedCoverage: 0,
    });
  });

  it('reports nothing for a thread with no summaries', () => {
    for (const removeSummaries of [true, false]) {
      expect(
        partitionSummaryImpact({ total: 0, removed: 0, invalidated: 0, removeSummaries })
      ).toEqual({
        removedByChoice: 0,
        removedAsInvalidated: 0,
        preserved: 0,
        repairedCoverage: 0,
      });
    }
  });

  /**
   * The buckets are an accounting of the same rows, so they have to add up no
   * matter what the measurement hands over — including impossible inputs, which
   * must clamp rather than emit a negative count into the confirmation copy.
   */
  it('accounts for every summary exactly once across the whole input space', () => {
    for (let total = 0; total <= 6; total += 1) {
      for (const removeSummaries of [true, false]) {
        const removed = removeSummaries ? total : 0;
        for (let invalidated = 0; invalidated <= total; invalidated += 1) {
          const p = partitionSummaryImpact({ total, removed, invalidated, removeSummaries });
          expect(p.removedByChoice + p.removedAsInvalidated).toBe(removed);
          expect(p.preserved).toBe(total - removed);
          expect(p.repairedCoverage).toBeLessThanOrEqual(p.preserved);
          for (const n of Object.values(p)) expect(n).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('clamps a measurement that claims more rows than the thread holds', () => {
    expect(
      partitionSummaryImpact({ total: 2, removed: 9, invalidated: 9, removeSummaries: true })
    ).toEqual({
      removedByChoice: 0,
      removedAsInvalidated: 2,
      preserved: 0,
      repairedCoverage: 0,
    });
  });
});
