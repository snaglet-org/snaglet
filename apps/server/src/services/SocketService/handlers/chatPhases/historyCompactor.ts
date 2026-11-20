/**
 * historyCompactor — folds the replayed HISTORY of one run into a persisted compaction.
 *
 * promptBuilder calls `compact` when the payload is over the fold threshold and compressMessages
 * has picked where it would cut (`splitIndex`). The cut moves back to the nearest whole replay
 * unit, the units before it are summarized by the agent's summary model (the same resolution the
 * digest uses), and the result is saved as a compaction record: replay applies it from then on, so
 * the summary covers exactly the folded units and the rest replay in full. The run's own message
 * list is rewritten to match, so this run and the next turn send the same prefix. The record is a
 * thread summary (thread_summaries, `compaction` column), so search and the thread list read it too.
 *
 * The summarizer reads the earlier compaction's summary together with the newly folded units and
 * writes ONE updated summary that replaces it, so the carried summary stays about one reply long.
 * Only when the earlier summary is too big to sit beside the new units in the summary model's
 * window are the new notes appended to it as a `## Fold N` section instead, the oldest sections
 * dropped past the cap (summary/compactionSummarySections).
 *
 * A summarizer that cannot do the job raises the summary halt (the thread stops and says which
 * model) and leaves everything untouched; the caller carries on this turn with the synthesized
 * digest of the folded span. A stop of the run throws AbortError.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { isConversationCompactionEnabled } from '@server/config/conversationCompactionPolicy';
import type { ProviderMessage } from '@server/services/ProviderChatService';
import type { ContextBudget } from '@server/services/contextWindow/budget';
import { buildCompactionSummaryMessage } from '@server/services/contextWindow/compactionMessage';
import {
  applyHistoryFold,
  foldBoundary,
  type HistoryFoldState,
} from '@server/services/contextWindow/historyFold';
import type { GenerateSummaryOutcome } from '@server/services/SummaryService';
import { saveCompaction, type CompactionRecord } from '@server/services/summary/compactionRecord';
import type { ThreadSummaryRow } from '@snaglet/db/tables/thread_summaries';
import { appendFoldSection } from '@server/services/summary/compactionSummarySections';
import {
  summarizeFoldedHistory,
  type HistorySummaryResult,
} from '@server/services/summary/historyCompactionSummary';
import { haltOnSummaryFailure } from '@server/services/summary/summaryHalt';
import { unitSourceId } from './replayAssembly';

/** Share of the usable budget a compaction summary may use, clamped below. */
const SUMMARY_BUDGET_FRACTION = 0.12;
const SUMMARY_MIN_OUTPUT_TOKENS = 1_024;
const SUMMARY_MAX_OUTPUT_TOKENS = 12_288;

function historySummaryMaxOutputTokens(budget: ContextBudget): number {
  return Math.min(
    SUMMARY_MAX_OUTPUT_TOKENS,
    Math.max(SUMMARY_MIN_OUTPUT_TOKENS, Math.floor(budget.usableBudget * SUMMARY_BUDGET_FRACTION))
  );
}

interface HistoryCompactorContext {
  readonly threadId: string;
  readonly agentId: string;
  readonly agentName: string;
  /** The run the fold happens in; the record itself belongs to the thread and agent. */
  readonly runId: string | null;
  readonly abortSignal: AbortSignal;
}

export interface HistoryCompactorDeps {
  summarize: typeof summarizeFoldedHistory;
  save: typeof saveCompaction;
  /** Embeds the saved summary for search, in chunks; runs detached and never throws. */
  embed: (row: ThreadSummaryRow) => Promise<void>;
  halt: (outcome: GenerateSummaryOutcome) => Promise<unknown>;
  enabled: () => boolean;
}

export type HistoryCompactResult =
  | {
      kind: 'compacted';
      summary: string;
      foldedUnits: number;
      /** Ids of the folded units (message or run ids), for mining the span for memories. */
      foldedUnitIds: string[];
      modelUsed: string;
    }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string; detail?: string };

export interface HistoryCompactor {
  /**
   * Fold the whole units at or before `splitIndex` of `messages` (rewriting the list and `state`
   * in place) when everything succeeds; otherwise change nothing.
   */
  compact(args: {
    messages: ProviderMessage[];
    state: HistoryFoldState;
    splitIndex: number;
    budget: ContextBudget;
    carryForward?: string | null;
  }): Promise<HistoryCompactResult>;
}

function abortError(): DOMException {
  return new DOMException('run aborted during context compaction', 'AbortError');
}

function failureOutcome(
  failure: Extract<HistorySummaryResult, { ok: false }>
): GenerateSummaryOutcome {
  return {
    status: 'skipped',
    reason: failure.reason,
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(failure.providerId ? { providerId: failure.providerId } : {}),
    ...(failure.modelId ? { modelId: failure.modelId } : {}),
    ...(failure.retryable ? { retryable: true as const } : {}),
  };
}

async function embedFoldSummary(row: ThreadSummaryRow): Promise<void> {
  // Loaded on use: SummaryService reaches back into the replay code this module sits beside.
  const { syncThreadSummaryEmbedding } = await import('@server/services/SummaryService');
  await syncThreadSummaryEmbedding(row);
}

export function createHistoryCompactor(
  ctx: HistoryCompactorContext,
  deps?: Partial<HistoryCompactorDeps>
): HistoryCompactor {
  const summarize = deps?.summarize ?? summarizeFoldedHistory;
  const save = deps?.save ?? saveCompaction;
  const embed = deps?.embed ?? embedFoldSummary;
  const enabled = deps?.enabled ?? isConversationCompactionEnabled;
  const halt =
    deps?.halt ??
    ((outcome: GenerateSummaryOutcome) =>
      haltOnSummaryFailure(outcome, {
        threadId: ctx.threadId,
        agentId: ctx.agentId,
        agentName: ctx.agentName,
      }));

  return {
    async compact({ messages, state, splitIndex, budget, carryForward }) {
      if (ctx.abortSignal.aborted) throw abortError();
      if (!enabled()) return { kind: 'skipped', reason: 'conversation compaction is off' };
      const boundary = foldBoundary(state.units, splitIndex);
      if (!boundary) return { kind: 'skipped', reason: 'no whole unit to fold' };

      const prior = state.compaction;
      // The earlier compaction's summary message is index 0; its text goes to the summarizer as
      // the notes so far (priorSummary), not as part of the span.
      const folded = messages.slice(prior ? 1 : 0, boundary.endIndex);

      const result = await summarize({
        threadId: ctx.threadId,
        agentId: ctx.agentId,
        folded,
        priorSummary: prior?.summary ?? null,
        maxOutputTokens: historySummaryMaxOutputTokens(budget),
        signal: ctx.abortSignal,
      });
      if (!result.ok) {
        // The halt table decides which reasons stop the thread; a rejected reply or a lookup
        // that could not complete does not. Either way nothing was folded.
        try {
          await halt(failureOutcome(result));
        } catch (err) {
          logger.warn(`[context] could not raise the summary halt: ${getErrorMessage(err)}`);
        }
        return { kind: 'failed', reason: result.reason, detail: result.detail };
      }

      const newNotes = result.text.trim();
      if (!newNotes) return { kind: 'skipped', reason: 'nothing new to summarize' };

      const summary = result.rolled ? newNotes : appendFoldSection(prior?.summary, newNotes);
      const carry = carryForward && carryForward.trim() ? carryForward.trim() : null;
      const record: CompactionRecord = {
        through: state.units[boundary.unitCount - 1].key,
        summary,
        carryForward: carry,
        foldedUnits: (prior?.foldedUnits ?? 0) + boundary.unitCount,
      };
      let saved: ThreadSummaryRow | undefined;
      try {
        saved = await save({
          threadId: ctx.threadId,
          agentId: ctx.agentId,
          record,
          modelUsed: result.modelUsed,
        });
      } catch (err) {
        // Not saved means the next turn would replay the whole history again; keep this turn on
        // the synthesized digest rather than fold something that will not stick.
        logger.warn(`[context] compaction was not saved: ${getErrorMessage(err)}`);
        return { kind: 'skipped', reason: 'the compaction could not be saved' };
      }

      if (saved) {
        // The summary is saved and the fold stands; search catching up is not the turn's concern.
        void embed(saved).catch((err: unknown) => {
          logger.warn(`[context] fold summary was not embedded: ${getErrorMessage(err)}`);
        });
      }

      // Message or run ids, as memory extraction matches them: a standalone unit's sortId carries a
      // prefix that no message id has.
      const foldedUnitIds = state.units
        .slice(0, boundary.unitCount)
        .map((u) => unitSourceId(u.key.sortId));
      applyHistoryFold(messages, state, boundary, buildCompactionSummaryMessage(summary, carry));
      state.compaction = record;
      return {
        kind: 'compacted',
        summary,
        foldedUnits: boundary.unitCount,
        foldedUnitIds,
        modelUsed: result.modelUsed,
      };
    },
  };
}
