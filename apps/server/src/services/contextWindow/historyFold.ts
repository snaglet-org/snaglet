/**
 * Cutting history for a persisted compaction.
 *
 * Replay emits whole units (a user message, a run with its tool exchanges, a peer message) and
 * reports where each ends in the message list (`ReplayUnitSpan`). A fold cuts only at those ends,
 * so it never splits a tool_use from its tool_result, and the cut is named by a unit key that
 * replay can apply again next turn. After a fold the in-memory list is edited to look exactly like
 * the replay the next turn will build: one summary message first, the kept units after it.
 */

import type { ProviderMessage } from '@server/services/ProviderChatService';
import type { ReplayUnitSpan } from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import type { CompactionRecord } from '@server/services/summary/compactionRecord';

/** What a run knows about the replayed history it is sending. */
export interface HistoryFoldState {
  /** The replay's unit spans, indexes into the run's message list. */
  units: ReplayUnitSpan[];
  /** The compaction replay already applied (its summary is the list's first message), if any. */
  compaction: CompactionRecord | null;
}

export interface FoldBoundary {
  /** How many leading units fold. */
  unitCount: number;
  /** Index (exclusive) in the message list where the folded part ends. */
  endIndex: number;
}

/**
 * The widest whole-unit fold that stays at or before `splitIndex`, or null when not even the
 * first unit ends there.
 */
export function foldBoundary(
  units: readonly ReplayUnitSpan[],
  splitIndex: number
): FoldBoundary | null {
  let unitCount = 0;
  for (const unit of units) {
    if (unit.end > splitIndex) break;
    unitCount += 1;
  }
  if (unitCount === 0) return null;
  return { unitCount, endIndex: units[unitCount - 1].end };
}

/**
 * Replace the folded messages with `summaryMessage` and drop the folded spans, in place. The
 * spans that stay are shifted so they match what replay builds next turn: the summary message
 * counts as one message in front of them.
 */
export function applyHistoryFold(
  messages: ProviderMessage[],
  state: HistoryFoldState,
  boundary: FoldBoundary,
  summaryMessage: ProviderMessage
): void {
  messages.splice(0, boundary.endIndex, summaryMessage);
  state.units = state.units
    .slice(boundary.unitCount)
    .map((unit) => ({ key: unit.key, end: unit.end - boundary.endIndex + 1 }));
}
