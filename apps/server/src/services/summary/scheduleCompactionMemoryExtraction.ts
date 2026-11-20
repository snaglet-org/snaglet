/**
 * scheduleCompactionMemoryExtraction — the one way a summary-writing path
 * triggers compaction-time memory extraction, given the `GenerateSummaryOutcome`
 * it got back. Never throws or blocks (extraction runs detached); runs only
 * for `status === 'generated'`; once per summary id (an in-process watermark,
 * backed by the (owner, key) upsert after a restart). Memories come only from
 * live compactions, not sweeps over old threads. In-run compaction
 * (contextWindow/runCompaction) writes no `thread_summaries` row and is not wired in.
 */

import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import type { GenerateSummaryOutcome } from '@server/services/SummaryService';
import { extractMemoriesFromCompaction, type MemoryExtractionResult } from './memoryExtraction';

/**
 * Summary ids already mined, newest last. In-process like the summary halt
 * registry and the compaction latch beside it: a restart clears it, and the
 * stable-key upsert makes a cleared watermark harmless.
 */
const extractedSummaryIds = new Set<string>();

/**
 * Bound on the watermark set. A long-lived server compacts many threads; the
 * set is a duplicate guard for concurrent/retried passes over the same
 * summary, which happen within seconds, so an old entry has no value.
 */
const MAX_TRACKED_SUMMARY_IDS = 500;

function rememberSummaryId(summaryId: string): void {
  extractedSummaryIds.add(summaryId);
  if (extractedSummaryIds.size > MAX_TRACKED_SUMMARY_IDS) {
    // Set iteration is insertion-ordered: drop the oldest overflow.
    const overflow = extractedSummaryIds.size - MAX_TRACKED_SUMMARY_IDS;
    let removed = 0;
    for (const id of extractedSummaryIds) {
      if (removed >= overflow) break;
      extractedSummaryIds.delete(id);
      removed += 1;
    }
  }
}

/** Test seam: forget every watermarked summary id. */
export function resetCompactionMemoryExtractionWatermark(): void {
  extractedSummaryIds.clear();
}

export interface ScheduleCompactionMemoryExtractionArgs {
  threadId: string;
  agentId: string;
  /** The outcome of the summary pass that just ran. */
  outcome: GenerateSummaryOutcome;
  agentNameMap?: Map<string, string>;
  /**
   * Called with the result when extraction wrote something (active or
   * proposed). Lets a caller broadcast the deltas without this module
   * depending on the socket layer. Its own failures are swallowed.
   */
  onResult?: (result: MemoryExtractionResult) => void;
}

/**
 * Fire compaction-time memory extraction if (and only if) this summary pass
 * actually wrote a summary that has not been mined yet. Returns immediately;
 * extraction runs detached.
 */
export function scheduleCompactionMemoryExtraction(
  args: ScheduleCompactionMemoryExtractionArgs
): void {
  try {
    const { outcome } = args;
    // A summary that was not written has no newly-compacted span to mine.
    if (outcome.status !== 'generated') return;

    const summaryId = outcome.summaryId;
    if (summaryId) {
      if (extractedSummaryIds.has(summaryId)) {
        logger.debug(
          `[memory-extraction] thread ${args.threadId} / agent ${args.agentId}: ` +
            `summary ${summaryId} already mined this process — skipping`
        );
        return;
      }
      rememberSummaryId(summaryId);
    }

    void extractMemoriesFromCompaction({
      threadId: args.threadId,
      agentId: args.agentId,
      agentNameMap: args.agentNameMap,
    })
      .then((result) => {
        if (result.saved > 0 || result.proposed > 0) {
          try {
            args.onResult?.(result);
          } catch (error) {
            logger.debug(
              `[memory-extraction] thread ${args.threadId}: onResult failed: ${getErrorMessage(error)}`
            );
          }
        }
      })
      // extractMemoriesFromCompaction never rejects, but a detached promise
      // must not be able to become an unhandled rejection even if that
      // changes.
      .catch((error: unknown) => {
        logger.warn(
          `[memory-extraction] thread ${args.threadId} / agent ${args.agentId}: ` +
            `scheduling failed: ${getErrorMessage(error)}`
        );
      });
  } catch (error) {
    // Belt and braces: this helper is called from hot paths that must not
    // care about it at all.
    logger.warn(
      `[memory-extraction] thread ${args.threadId}: could not schedule extraction: ${getErrorMessage(error)}`
    );
  }
}

/**
 * Compaction-time extraction for a history compaction (a persisted fold of replayed units): mine
 * exactly the messages in the units just folded. Same contract as the helper above: synchronous,
 * detached, never throws. One fold is mined once, keyed by its last unit.
 */
export function scheduleHistoryCompactionMemoryExtraction(args: {
  threadId: string;
  agentId: string;
  foldedUnitIds: readonly string[];
  agentNameMap?: Map<string, string>;
  /** Called when extraction wrote something (active or proposed); its failures are swallowed. */
  onResult?: (result: MemoryExtractionResult) => void;
}): void {
  try {
    const last = args.foldedUnitIds[args.foldedUnitIds.length - 1];
    if (!last) return;
    const key = `history:${args.threadId}:${args.agentId}:${last}`;
    if (extractedSummaryIds.has(key)) return;
    rememberSummaryId(key);

    void extractMemoriesFromCompaction({
      threadId: args.threadId,
      agentId: args.agentId,
      agentNameMap: args.agentNameMap,
      foldedUnitIds: args.foldedUnitIds,
    })
      .then((result) => {
        if (result.saved > 0 || result.proposed > 0) {
          try {
            args.onResult?.(result);
          } catch (error) {
            logger.debug(
              `[memory-extraction] thread ${args.threadId}: onResult failed: ${getErrorMessage(error)}`
            );
          }
        }
      })
      .catch((error: unknown) => {
        logger.warn(
          `[memory-extraction] thread ${args.threadId} / agent ${args.agentId}: ` +
            `scheduling failed: ${getErrorMessage(error)}`
        );
      });
  } catch (error) {
    logger.warn(
      `[memory-extraction] thread ${args.threadId}: could not schedule extraction: ${getErrorMessage(error)}`
    );
  }
}
