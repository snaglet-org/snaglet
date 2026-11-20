/**
 * `tool` category settings.
 *
 *   - `shell` — shell lifetimes and the shell_exec compatibility output cap:
 *     `{ timeoutMs?, maxTimeoutMs?, backgroundMaxMs?, maxBufferKb? }`. Every key
 *     is optional and, when set, wins over its env default (shellGuardrails).
 *   - `max_iterations` — per-agent-turn tool-call ceiling.
 *   - `condense_min_chars` — per-result floor: results at/below this survive
 *     whole; larger ones may be condensed for the LLM history.
 *   - `max_result_chars` — Tier 1 ingest floor: single tool outputs larger
 *     than the ingest ceiling are head+tail trimmed at ingestion so a
 *     mega-output never enters the retained history whole. The ceiling is this
 *     value or a share of the free room below the fold, whichever is larger
 *     (contextWindow/adaptiveLimits).
 *   - `tool_result_bulk_token_budget` — Tier 3 pressure threshold: when the
 *     total estimated tokens of retained tool-result content exceed this, the
 *     oldest unique results are shed head+tail.
 *   - `activity_log_max_output_chars` — log bound (storage/run_history), not a
 *     model-context tier: the `agent_activity_log.tool_output` row written per
 *     call is head+tail trimmed at this size independent of `max_result_chars`,
 *     so one huge output cannot bloat the table. Deliberately larger than the
 *     context ceiling so `run_history` keeps real recovery value.
 *
 * Defaults match the existing code-side fallback behavior.
 */

import { z } from 'zod';
import { defineCategory } from '../defineSetting';

const PositiveInt = z.number().int().positive();

/** Shell lifetimes never exceed 4 h (SHELL_TIMEOUT_CEILING_MS). */
const ShellLifetimeMs = PositiveInt.max(4 * 60 * 60_000);

// Every key is optional so one can be set alone (e.g. only `maxTimeoutMs`)
// while the others keep their env defaults.
const ShellSchema = z.object({
  /**
   * Default foreground lifetime; also the blocking wait of `run` and of the
   * shell_exec compatibility contract. No schema max (older rows may hold more): the code
   * clamps it to the configured maximum.
   */
  timeoutMs: PositiveInt.optional(),
  /** Largest foreground `timeout_ms` (env SNAGLET_SHELL_MAX_TIMEOUT_MS, default 30 min). */
  maxTimeoutMs: ShellLifetimeMs.optional(),
  /** Background job lifetime and its maximum (env SNAGLET_SHELL_BACKGROUND_MAX_MS, default 2 h). */
  backgroundMaxMs: ShellLifetimeMs.optional(),
  /** Output cap for the shell_exec compatibility contract and `run` results. */
  maxBufferKb: PositiveInt.optional(),
});

export const toolSettings = defineCategory('tool', {
  shell: {
    key: 'shell',
    legacyKey: 'shell_exec',
    schema: ShellSchema,
    default: { timeoutMs: 10_000, maxBufferKb: 2048 },
    description:
      'Shell tool limits, each optional and winning over its env default: timeoutMs (default foreground lifetime, env SNAGLET_SHELL_HARD_TIMEOUT_MS), maxTimeoutMs (largest foreground timeout_ms, env SNAGLET_SHELL_MAX_TIMEOUT_MS, default 30 min), backgroundMaxMs (background job lifetime, env SNAGLET_SHELL_BACKGROUND_MAX_MS, default 2 h), all at most 4 h; maxBufferKb (output cap). The legacy shell_exec alias falls back to the default below.',
  },
  maxIterations: {
    key: 'max_iterations',
    schema: PositiveInt,
    default: 640,
    description:
      'Per-agent-turn tool-call/iteration ceiling — a safety valve against runaway loops (the in-run repeat guard breaks most loops well before this). Set from live data: the largest COMPLETED run observed made 425 tool calls, so the default is ~1.5× that (425 × 1.5 ≈ 640) to avoid cutting a legitimate long run. Per-agent overrides (agent.configJson.budget.maxToolCallsPerTurn) take precedence; this is the global fallback.',
  },
  condenseMinChars: {
    key: 'condense_min_chars',
    schema: PositiveInt,
    default: 1500,
    description:
      'Per-result floor: tool output at or below this size is never condensed. Raised from 300 so small files/results survive whole; larger outputs are condensed as a head+tail window (see condenseVerbatimText) only under retention pressure.',
  },
  maxResultChars: {
    key: 'max_result_chars',
    schema: PositiveInt,
    default: 12000,
    description:
      'Tier 1 ingest FLOOR: single tool outputs larger than the ingest ceiling are head+tail trimmed (with an honest marker) as they arrive, so a mega-output (e.g. a 249K-char catalog) never enters the retained history whole. The ceiling is this value or, when larger, a share of the room still free below the compaction fold point, so a big result arrives whole while the context is empty and the ceiling shrinks back to this value as the context fills.',
  },
  toolBulkTokenBudget: {
    key: 'tool_result_bulk_token_budget',
    schema: PositiveInt,
    default: 35000,
    description:
      'Tier 3 pressure threshold: when the total estimated tokens of retained tool-result content exceed this, the oldest unique results are shed head+tail (superseded duplicates are already collapsed, newest-per-target is protected). This is a tool-bulk budget, not a percentage of the model window.',
  },
  activityLogMaxOutputChars: {
    key: 'activity_log_max_output_chars',
    schema: PositiveInt,
    default: 100_000,
    description:
      'LOG bound for the agent_activity_log.tool_output row written per tool call — head+tail trimmed at this size, independent of max_result_chars (the model-context ceiling). Deliberately larger than max_result_chars so run_history keeps real recovery value; this bounds storage/replay cost, not model context. Added after a live 4.4 MB code_search row and 250K-char list_tools rows were found uncapped.',
  },
});
