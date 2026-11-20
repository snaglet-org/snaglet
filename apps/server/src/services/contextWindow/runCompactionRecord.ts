/**
 * The persisted record of one in-run compaction: an agent_activity_log row on
 * the compacted run (actionType 'tool_call', tool RUN_COMPACTION_ACTIVITY_TOOL —
 * the action_type CHECK constraint admits no new kind without a migration, the
 * same reason the thread-summary activity row is a 'tool_call').
 *
 * A row on the run, not a thread_summaries version: it summarizes one run's
 * tool work, which no message watermark can describe, and it dies with that
 * run's activity — thread delete/clear/trim and helper retirement all delete
 * activity through runs.thread_id — while staying out of the node graph
 * (no embeddings, search, tree or exports).
 *
 * Kept free of estimator imports so the replay assembly can read it.
 */

import { isRecord } from '@snaglet/shared/utils';

export const RUN_COMPACTION_ACTIVITY_TOOL = 'run_compaction';

export type RunCompactionSource = 'model' | 'digest';

/** `tool_input` of the activity row. */
export interface RunCompactionActivityInput extends Record<string, unknown> {
  compaction: number;
  folded_messages: number;
  folded_tool_cycles: number;
  kept_messages: number;
  tokens_before: number;
  tokens_after: number;
  token_threshold: number;
}

/**
 * `tool_output` of the activity row. The summary rides `output`, the key the
 * run-activity UI renders for every tool step.
 */
export interface RunCompactionActivityOutput extends Record<string, unknown> {
  output: string;
  source: RunCompactionSource;
  model_used: string | null;
  fallback_reason: string | null;
}

export function isRunCompactionActivity(row: { tool: string | null }): boolean {
  return row.tool === RUN_COMPACTION_ACTIVITY_TOOL;
}

/** The summary text a compaction row stored, or null when it has none. */
export function readRunCompactionSummary(toolOutput: unknown): string | null {
  if (!isRecord(toolOutput)) return null;
  const summary = toolOutput.output;
  return typeof summary === 'string' && summary.trim().length > 0 ? summary.trim() : null;
}
