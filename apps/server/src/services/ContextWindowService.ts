/**
 * Context Window Service
 *
 * Per-agent budget calculation and sliding-window compression.
 * Public surface of the contextWindow/ modules — kept as a barrel so existing
 * `@server/services/ContextWindowService` importers keep working.
 */

export { PROVIDER_SAFETY_MARGIN_PCT } from './contextWindow/constants';
export {
  requestMaxOutputTokens,
  resolveContextBudget,
  type ContextBudget,
} from './contextWindow/budget';
export { compressMessages, findCurrentRunBoundary } from './contextWindow/compression';
export {
  applyRunCompaction,
  buildRunSpanDigest,
  runSummaryMaxOutputTokens,
  selectRunCompactionSpan,
  spanMessagesToFold,
  type RunCompactionSpan,
} from './contextWindow/runCompaction';
export { estimateThreadUsage } from './contextWindow/usage';
