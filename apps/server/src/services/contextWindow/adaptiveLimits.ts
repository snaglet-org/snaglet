/**
 * Limits that grow with free context instead of staying fixed. Two fixed numbers (a 10k-token
 * replay cap per run, a 12k-char ceiling per tool result) trimmed content long before the fold
 * point, even on an almost empty 200k window. Both now scale with the room below the fold
 * (`ContextBudget.tokenThreshold`) and fall back to their old values as that room runs out, so
 * the fold still triggers as designed. Pure: no I/O, no estimator imports.
 */

/** The most one run's replay may take, as a share of the fold threshold. */
const REPLAY_RUN_SHARE = 0.25;

/** The most one tool result may take, as a share of the room still free below the fold. */
const INGEST_FREE_SHARE = 0.25;

/** Tokens-to-chars for sizing a result; low on purpose, so code and JSON still fit the share. */
export const INGEST_CHARS_PER_TOKEN = 3;

/** Per-run replay cap when nothing else is crowding the window. Never below `floor`. */
export function replayRunCapCeiling(tokenThreshold: number, floor: number): number {
  return Math.max(floor, Math.floor(tokenThreshold * REPLAY_RUN_SHARE));
}

/**
 * Tightens `ceiling` when the whole replay (`totalTokens`) does not fit the room below the fold
 * (`freeTokens`): in proportion to the overshoot, never below `floor`.
 */
export function shrinkReplayRunCap(args: {
  ceiling: number;
  floor: number;
  freeTokens: number;
  totalTokens: number;
}): number {
  const { ceiling, floor, freeTokens, totalTokens } = args;
  if (totalTokens <= freeTokens) return ceiling;
  if (freeTokens <= 0 || totalTokens <= 0) return floor;
  return Math.max(floor, Math.floor((ceiling * freeTokens) / totalTokens));
}

/**
 * Char ceiling for one tool result as it arrives: a share of the room still free below the
 * fold, never below `floorChars` (the `max_result_chars` setting).
 */
export function resultIngestCeilingChars(args: {
  floorChars: number;
  tokenThreshold: number;
  usedTokens: number;
}): number {
  const free = Math.max(0, args.tokenThreshold - args.usedTokens);
  const scaled = Math.floor(free * INGEST_FREE_SHARE * INGEST_CHARS_PER_TOKEN);
  return Math.max(args.floorChars, scaled);
}
