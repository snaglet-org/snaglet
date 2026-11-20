/**
 * In-run compaction — span selection and replacement for a run whose own
 * exchanges outgrow the context budget.
 *
 * compressMessages never folds the current run (see its `currentRunBoundary`
 * doc), so a long run eventually cannot fit no matter how much history folds.
 * This module picks the part of the run that may fold instead: everything the
 * turn loop appended since the run started (tool cycles, lint corrections,
 * mid-run injections, an earlier in-run summary), minus the newest tool cycles,
 * which stay verbatim. The head — the triggering message and the turn-context
 * tail, `[currentRunBoundary, runStartIndex)` — is never part of the span.
 *
 * The span always ends at an assistant message, so a tool_use and its
 * tool_result (always the next user message) can never be split — the
 * compaction-boundary 400 the split guard in compression.ts exists for.
 *
 * Unlike compressMessages this mutates the caller's array: the run's message
 * array is the state every later iteration builds from, so a compaction must
 * stick rather than be recomputed per call.
 */

import type { ProviderMessage, TextMessage } from '@server/services/ProviderChatService';
import { estimateMessageTokens } from '@server/services/TokenEstimator';
import { resolveEffectiveToolName } from '@server/services/ToolService/toolResultFormat';
import type { ContextBudget } from './budget';
import { buildPayloadDigest } from './toolResultSummary';
import {
  RUN_KEEP_MIN_CYCLES,
  RUN_KEEP_RECENT_CYCLES,
  RUN_KEEP_TAIL_BUDGET_FRACTION,
  RUN_MIN_FOLD_BUDGET_FRACTION,
  RUN_SUMMARY_BUDGET_FRACTION,
  RUN_SUMMARY_MAX_OUTPUT_TOKENS,
  RUN_SUMMARY_MIN_OUTPUT_TOKENS,
} from './constants';

const RUN_SUMMARY_HEADER = '[Earlier in this run, summarized]';
/** Distinct tool names a digest lists before eliding the rest. */
const MAX_DIGEST_TOOL_TYPES = 40;

/** Summary text of each in-run summary message this process inserted. */
const runSummaryText = new WeakMap<ProviderMessage, string>();

export interface RunCompactionSpan {
  /** First folded index (inclusive) — always the run's first appended message. */
  readonly start: number;
  /** First kept index (exclusive end of the span) — always an assistant message. */
  readonly end: number;
  /** Assistant (tool_use) turns folded. */
  readonly foldedCycles: number;
  /** Assistant (tool_use) turns kept verbatim after the span. */
  readonly keptCycles: number;
  /** Estimated tokens of the folded messages, an earlier in-run summary excluded. */
  readonly foldedTokens: number;
  /** Estimated tokens of the kept tail. */
  readonly keptTailTokens: number;
  /** The earlier in-run summary inside the span, if any. */
  readonly previousSummary: string | null;
}

/**
 * Output-token cap for an in-run summary against this budget: a share of the
 * usable budget, clamped (see RUN_SUMMARY_BUDGET_FRACTION).
 */
export function runSummaryMaxOutputTokens(budget: ContextBudget): number {
  const share = Math.floor(budget.usableBudget * RUN_SUMMARY_BUDGET_FRACTION);
  return Math.min(RUN_SUMMARY_MAX_OUTPUT_TOKENS, Math.max(RUN_SUMMARY_MIN_OUTPUT_TOKENS, share));
}

/** Smallest fold worth a compaction (see RUN_MIN_FOLD_BUDGET_FRACTION). */
function runMinFoldTokens(budget: ContextBudget): number {
  return Math.max(
    2 * runSummaryMaxOutputTokens(budget),
    Math.floor(budget.usableBudget * RUN_MIN_FOLD_BUDGET_FRACTION)
  );
}

/**
 * Choose the span of the current run to fold, or null when no fold is worth
 * doing: too few tool cycles to keep the tail floor and still fold one, or too
 * little to free (an oversized head or kept tail is not this layer's to fix).
 *
 * `runStartIndex` is the length of the run's message array when the turn loop
 * started appending to it; everything before it is history or the run's head.
 */
export function selectRunCompactionSpan(
  messages: readonly ProviderMessage[],
  runStartIndex: number,
  budget: ContextBudget
): RunCompactionSpan | null {
  const start = Math.min(Math.max(Math.floor(runStartIndex) || 0, 0), messages.length);
  const cycleStarts: number[] = [];
  for (let i = start; i < messages.length; i++) {
    if (messages[i].role === 'assistant') cycleStarts.push(i);
  }
  if (cycleStarts.length <= RUN_KEEP_MIN_CYCLES) return null;

  const tokens = messages.map((message, i) =>
    i < start ? 0 : estimateMessageTokens(message, budget.provider, budget.modelId)
  );
  const tokensFrom = (from: number): number =>
    tokens.slice(from).reduce((sum, value) => sum + value, 0);

  const tailCap = budget.usableBudget * RUN_KEEP_TAIL_BUDGET_FRACTION;
  let kept = RUN_KEEP_MIN_CYCLES;
  let keptTailTokens = tokensFrom(cycleStarts[cycleStarts.length - kept]!);
  // Grow toward the target while at least one cycle is left to fold.
  while (kept < RUN_KEEP_RECENT_CYCLES && kept < cycleStarts.length - 1) {
    const candidate = tokensFrom(cycleStarts[cycleStarts.length - kept - 1]!);
    if (candidate > tailCap) break;
    kept++;
    keptTailTokens = candidate;
  }
  const end = cycleStarts[cycleStarts.length - kept]!;

  let previousSummary: string | null = null;
  let foldedTokens = 0;
  for (let i = start; i < end; i++) {
    const summary = runSummaryText.get(messages[i]!);
    if (summary !== undefined) {
      previousSummary = summary;
      continue;
    }
    foldedTokens += tokens[i]!;
  }
  if (foldedTokens < runMinFoldTokens(budget)) return null;

  return {
    start,
    end,
    foldedCycles: cycleStarts.length - kept,
    keptCycles: kept,
    foldedTokens,
    keptTailTokens,
    previousSummary,
  };
}

/** The folded messages of a span, any earlier in-run summary left out. */
export function spanMessagesToFold(
  messages: readonly ProviderMessage[],
  span: RunCompactionSpan
): ProviderMessage[] {
  return messages.slice(span.start, span.end).filter((message) => !runSummaryText.has(message));
}

/** Build the message that replaces a folded span. */
function buildRunSummaryMessage(summary: string, foldedMessages: number): TextMessage {
  const message: TextMessage = {
    role: 'user',
    content: [
      RUN_SUMMARY_HEADER,
      `${foldedMessages} earlier messages of this run were folded to free context. This is a ` +
        'record of your own work so far, not a new request: the request that started the run ' +
        'is above, and your most recent steps follow verbatim. Continue from the next step; do ' +
        'not redo finished work.',
      '',
      summary.trim(),
    ].join('\n'),
  };
  runSummaryText.set(message, summary.trim());
  return message;
}

/**
 * Replace the span with one summary message, in place. Returns the inserted
 * message. Every later iteration of the run builds from the compacted array.
 */
export function applyRunCompaction(
  messages: ProviderMessage[],
  span: RunCompactionSpan,
  summary: string
): TextMessage {
  const folded = spanMessagesToFold(messages, span).length;
  const summaryMessage = buildRunSummaryMessage(summary, folded);
  messages.splice(span.start, span.end - span.start, summaryMessage);
  return summaryMessage;
}

/** Real tool names (the `action` gateway unwrapped) with call counts, in first-call order. */
function toolCallCounts(messages: readonly ProviderMessage[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const name = resolveEffectiveToolName(block) ?? block.name;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Deterministic stand-in for a model-written summary: used when summaries are
 * disabled (COMPACT_CONVERSATIONS=false) or the summary model fails. Same input
 * → same text. An earlier in-run summary is carried forward (bounded to half
 * the cap) so a chain of compactions still remembers its oldest work.
 */
export function buildRunSpanDigest(
  folded: readonly ProviderMessage[],
  previousSummary: string | null,
  maxChars: number
): string {
  const counts = [...toolCallCounts(folded).entries()];
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const shown = counts.slice(0, MAX_DIGEST_TOOL_TYPES).map(([name, n]) => `${name} ×${n}`);
  if (counts.length > shown.length) shown.push(`+${counts.length - shown.length} more`);
  const callsLine =
    total === 0
      ? `Machine digest of ${folded.length} folded messages (no tool calls).`
      : `Machine digest of ${folded.length} folded messages: ${total} tool call${total === 1 ? '' : 's'} — ` +
        `${shown.join(', ')}.`;

  const parts = [callsLine];
  if (previousSummary) {
    const cap = Math.floor(maxChars / 2);
    const carried =
      previousSummary.length > cap
        ? `${previousSummary.slice(0, cap)}… [earlier summary cut]`
        : previousSummary;
    parts.push('', 'Earlier summary of this run:', carried);
  }
  const used = parts.join('\n').length;
  const steps = buildPayloadDigest([...folded], Math.max(0, maxChars - used - 16));
  if (steps) parts.push('', 'Steps:', steps);
  return parts.join('\n');
}
