/**
 * In-run repeat-call guard for byte-identical tool calls (same tool, same
 * arguments), keyed by `hash(tool + canonicalized-input) → prior result`:
 * the 1st call runs, the 2nd runs with an advisory appended, the 3rd+ returns
 * the cached result with a "do not call again" header, and past the suppression
 * cap `takePendingNudge()` yields a one-time loop-breaking nudge.
 * Mutations are never tracked; each one invalidates the cached reads it could
 * have changed (an exec clears all), so a read after a write runs fresh. Nothing
 * here rewrites earlier messages; state is per model attempt and not persisted.
 */

import { toolCallHash, type MutationScope, type ToolCallClassification } from './toolCallTargeting';
import { resolveToolId } from '@snaglet/shared/utils';

/** Interactive tools that must always run — never suppressed (returning a
 * cached "answer" for an interactive prompt would break its semantics). */
const EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['ask', 'get_clarification']);

/** Number of prior identical executions after which we stop executing. Calls
 * #1 and #2 run (with #2 advised); #3 onward are suppressed. */
const SUPPRESS_AFTER_EXECUTIONS = 2;
/** Emit a loop-breaking nudge each time cumulative suppressions cross this. */
const SUPPRESSION_NUDGE_CAP = 8;

interface RepeatCallDecision {
  kind: 'execute' | 'advise' | 'suppress';
  /** For `advise`: the advisory line to append to the freshly-executed result. */
  advisory?: string;
  /** For `suppress`: the full tool-result content to return without executing. */
  cachedResult?: string;
}

export interface RepeatCallGuard {
  /**
   * Decide how to handle a tool call about to execute, and advance the per-run
   * counters. Mutations and interactive tools always execute untracked. For
   * `execute`/`advise`, call {@link RepeatCallGuard.recordResult} afterward with
   * the fresh result so later repeats can be suppressed.
   */
  evaluate(
    toolName: string,
    input: unknown,
    classification: ToolCallClassification
  ): RepeatCallDecision;
  /** Store the fresh result text for a call so identical later calls can be
   * suppressed with it. No-op for excluded/mutation tools. */
  recordResult(toolName: string, input: unknown, resultText: string): void;
  /** Invalidate cached reads a mutation could have changed: clear all cached
   * entries for an exec (`scope: 'all'`), or just entries reading `subject`. */
  invalidate(scope: MutationScope): void;
  /**
   * If cumulative suppressions have crossed the cap since the last check,
   * return a one-time loop-breaking nudge string; otherwise null. Consuming it
   * clears the pending flag.
   */
  takePendingNudge(): string | null;
}

interface Entry {
  /** How many times this exact (tool, input) has been seen this run. */
  count: number;
  /** The most recent result text for this call, once executed. */
  result?: string;
  /** Concrete target the call reads, for subject-scoped invalidation. */
  subject: string | null;
}

function buildAdvisory(toolName: string, callNumber: number): string {
  return (
    `note: identical call #${callNumber} to \`${toolName}\` with the same arguments this run — ` +
    `the earlier result is still valid; avoid repeating calls and reuse what you already have.`
  );
}

function buildSuppressionHeader(toolName: string, callNumber: number): string {
  return (
    `[repeat call #${callNumber} — returning your earlier result; you already have this ` +
    `information; do not call \`${toolName}\` with these arguments again. If you need something ` +
    `different, change the arguments or move on and answer.]`
  );
}

const LOOP_NUDGE =
  '[system note: you appear to be looping — the same tool calls keep repeating without new ' +
  'information. Stop calling tools, review what you already know from this run, and produce your ' +
  'answer now.]';

export function createRepeatCallGuard(): RepeatCallGuard {
  const map = new Map<string, Entry>();
  let totalSuppressions = 0;
  let pendingNudge = false;

  const trackable = (toolName: string, classification: ToolCallClassification): boolean =>
    classification.role !== 'mutation' && !EXCLUDED_TOOLS.has(resolveToolId(toolName).id);

  return {
    evaluate(toolName, input, classification) {
      const canonicalToolName = resolveToolId(toolName).id;
      // Mutations + interactive tools always execute; never suppressed.
      if (!trackable(toolName, classification)) return { kind: 'execute' };

      const key = toolCallHash(canonicalToolName, input);
      const entry = map.get(key);
      const priorCount = entry?.count ?? 0;
      const callNumber = priorCount + 1;

      if (priorCount < SUPPRESS_AFTER_EXECUTIONS) {
        // Under the ceiling — execute (advising on the 2nd identical call).
        map.set(key, { count: callNumber, result: entry?.result, subject: classification.subject });
        if (priorCount === 0) return { kind: 'execute' };
        return { kind: 'advise', advisory: buildAdvisory(toolName, callNumber) };
      }

      // At/over the ceiling — suppress, returning the cached prior result. If
      // (defensively) no result was ever recorded, fall back to executing so we
      // never return an empty tool_result.
      map.set(key, { count: callNumber, result: entry?.result, subject: classification.subject });
      if (entry?.result === undefined) return { kind: 'execute' };

      totalSuppressions++;
      if (totalSuppressions % SUPPRESSION_NUDGE_CAP === 0) pendingNudge = true;

      return {
        kind: 'suppress',
        cachedResult: `${buildSuppressionHeader(toolName, callNumber)}\n\n${entry.result}`,
      };
    },

    recordResult(toolName, input, resultText) {
      const key = toolCallHash(resolveToolId(toolName).id, input);
      const entry = map.get(key);
      // Only record for entries evaluate() is tracking; a missing entry means
      // the call was untracked (mutation/interactive) — nothing to cache.
      if (entry) entry.result = resultText;
    },

    invalidate(scope) {
      if (scope.scope === 'all') {
        // Exec with opaque effects — every cached read/other result may be stale.
        map.clear();
        return;
      }
      for (const [key, entry] of map) {
        if (entry.subject === scope.subject) map.delete(key);
      }
    },

    takePendingNudge() {
      if (!pendingNudge) return null;
      pendingNudge = false;
      return LOOP_NUDGE;
    },
  };
}
