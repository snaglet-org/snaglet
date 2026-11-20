/**
 * The compaction record: the thread summary that says "everything up to this replay unit is folded
 * into this summary". It is a row of thread_summaries whose `compaction` column is set (where the
 * fold stopped, how many replay units it stands in for, the carry-forward note); the summary text
 * is the row's summary_text, so search, embeddings and the thread list read it like any other
 * thread summary.
 *
 * Replay applies the newest such row for the thread and agent (replayAssembly's `compaction`), so
 * the summary covers exactly the folded units and the units after it replay in full: no gap and
 * no overlap, by construction. Each fold writes a new version holding the whole rolled summary;
 * the older versions are history.
 *
 * Older threads may hold a fold as an activity-log row (tool COMPACTION_SUMMARY_ACTIVITY_TOOL).
 * Those rows are read when a thread has no fold row yet, and replay skips them; no new ones are
 * written.
 *
 * Kept free of heavy imports so the replay loader can read it.
 */

import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Links } from '@snaglet/db/tables/links';
import { ThreadSummaries, type ThreadSummaryRow } from '@snaglet/db/tables/thread_summaries';
import { generateId, isoNow, isRecord } from '@snaglet/shared/utils';
import type { ReplayCompaction } from '@server/services/SocketService/handlers/chatPhases/replayAssembly';
import { THREAD_SUMMARY_ACTIVITY_TOOL } from './threadSummaryActivity';

export const COMPACTION_SUMMARY_ACTIVITY_TOOL = 'compaction_summary';

export interface CompactionRecord extends ReplayCompaction {
  /** How many replay units the summary stands in for (for logs and the UI). */
  foldedUnits: number;
}

/** True for the summary bookkeeping rows replay must not turn into tool calls. */
export function isSummaryBookkeepingActivity(row: { tool: string | null }): boolean {
  return row.tool === COMPACTION_SUMMARY_ACTIVITY_TOOL || row.tool === THREAD_SUMMARY_ACTIVITY_TOOL;
}

export function serializeCompactionRecord(
  record: CompactionRecord,
  modelUsed: string
): Record<string, unknown> {
  return {
    through: record.through,
    summary: record.summary,
    carry_forward: record.carryForward ?? null,
    folded_units: record.foldedUnits,
    model_used: modelUsed,
  };
}

/** What a fold row keeps in its `compaction` column; the summary text is the row's own. */
export function serializeFoldColumn(record: CompactionRecord): Record<string, unknown> {
  return {
    through: record.through,
    carry_forward: record.carryForward ?? null,
    folded_units: record.foldedUnits,
    ...(record.cut ? { cut: true } : {}),
  };
}

/** A record from an activity-log fold row's output, or null when it is not a well-formed one. */
export function parseCompactionRecord(output: unknown): CompactionRecord | null {
  if (!isRecord(output)) return null;
  const { summary } = output;
  if (typeof summary !== 'string' || !summary.trim()) return null;
  return recordFrom(summary, output);
}

/** A record from a fold row of thread_summaries, or null when its column is not well-formed. */
export function parseFoldRow(
  row: Pick<ThreadSummaryRow, 'summaryText' | 'compaction'>
): CompactionRecord | null {
  if (!row.summaryText.trim()) return null;
  return recordFrom(row.summaryText, row.compaction);
}

function recordFrom(summary: string, fold: unknown): CompactionRecord | null {
  if (!isRecord(fold)) return null;
  const { through, folded_units: folded, carry_forward: carry, cut } = fold;
  if (!isRecord(through)) return null;
  const { effectiveStart, startAt, sortId } = through;
  if (
    typeof effectiveStart !== 'string' ||
    typeof startAt !== 'string' ||
    typeof sortId !== 'string'
  ) {
    return null;
  }
  return {
    through: { effectiveStart, startAt, sortId },
    summary,
    carryForward: typeof carry === 'string' && carry.trim() ? carry : null,
    foldedUnits: typeof folded === 'number' ? folded : 0,
    ...(cut === true ? { cut: true } : {}),
  };
}

/**
 * The newest compaction for this agent in this thread, or null. Never another agent's: a newcomer
 * gets a cut of its own (newcomerCut), not a borrowed summary.
 */
export async function loadLatestCompaction(
  threadId: string,
  agentId: string
): Promise<CompactionRecord | null> {
  const row = await ThreadSummaries.getLatestCompaction(threadId, agentId);
  const fromTable = row ? parseFoldRow(row) : null;
  if (fromTable) return fromTable;
  // An older thread may hold its fold as an activity-log row.
  const legacy = await AgentActivityLog.getLatestByTool(
    threadId,
    agentId,
    COMPACTION_SUMMARY_ACTIVITY_TOOL
  );
  return legacy ? parseCompactionRecord(legacy.toolOutput) : null;
}

/**
 * Persist a fold as the thread's newest summary version. `messages_covered` counts the replay units
 * folded (a unit is a turn or a run, not a message) and `last_message_id` stays empty, which the
 * trim repair reads as "bounded by created_at" and zeroes if history is cut.
 */
export async function saveCompaction(args: {
  threadId: string;
  agentId: string;
  record: CompactionRecord;
  /** The summary model; absent for a newcomer cut, which used none. */
  modelUsed?: string;
}): Promise<ThreadSummaryRow> {
  const row = await ThreadSummaries.insertNewVersion({
    id: generateId('thread_summary'),
    threadId: args.threadId,
    agentId: args.agentId,
    summaryText: args.record.summary,
    messagesCovered: args.record.foldedUnits,
    ...(args.modelUsed ? { modelUsed: args.modelUsed } : {}),
    compaction: serializeFoldColumn(args.record),
  });
  try {
    await Links.upsert({
      sourceId: row.id,
      targetId: args.threadId,
      relation: 'summarizes',
      metadata: { folded_units: args.record.foldedUnits, generated_at: isoNow() },
    });
  } catch {
    // The link only places the summary in the graph; the summary is saved without it.
  }
  return row;
}
