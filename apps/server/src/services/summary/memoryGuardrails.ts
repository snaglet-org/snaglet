/**
 * memoryGuardrails — cost guardrails for default-on summarization:
 *
 * - a fixed daily safety cap (count-based, UTC day) on automatic generations,
 *   so automatic compaction cannot surprise a bill;
 * - a per-thread+agent debounce (`SNAGLET_SUMMARY_MIN_INTERVAL_MS`, default
 *   120s) on top of the message-threshold boundary, so bursty turns can't
 *   fire back-to-back generations.
 *
 * Both are in-process counters: the server is single-process by design, and
 * a restart resetting them is an accepted, cheap failure mode (worst case a
 * few extra generations). Manual/forced summaries bypass both — an explicit
 * user request is never rate-limited — but successful forced generations
 * still count toward the day's total so the cap reflects real usage.
 */

import { logger } from '@server/config/logger';
function numEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

const DEFAULT_MIN_INTERVAL_MS = 120_000;
const DEFAULT_DAILY_SUMMARY_CAP = 200;
const DEFAULT_BACKFILL_DAILY_CAP = 50;

let dayKey = '';
let usedToday = 0;
let backfillUsedToday = 0;
let capLoggedForDay = '';
const lastGenerationAt = new Map<string, number>();
let dailySummaryCap = DEFAULT_DAILY_SUMMARY_CAP;
let backfillDailyCap = DEFAULT_BACKFILL_DAILY_CAP;

function currentDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function rollDay(now: Date): void {
  const key = currentDayKey(now);
  if (key !== dayKey) {
    dayKey = key;
    usedToday = 0;
    backfillUsedToday = 0;
  }
}

/** Test-only: reset all counters. */
export function resetMemoryGuardrailsForTests(): void {
  dayKey = '';
  usedToday = 0;
  backfillUsedToday = 0;
  capLoggedForDay = '';
  lastGenerationAt.clear();
  dailySummaryCap = DEFAULT_DAILY_SUMMARY_CAP;
  backfillDailyCap = DEFAULT_BACKFILL_DAILY_CAP;
}

/**
 * Gate an automatic generation attempt. Returns null when allowed, or a
 * skip descriptor when the daily cap or the per-thread debounce bites.
 * Does not consume budget — call `recordSummaryGeneration` after a
 * successful generation.
 */
export async function checkMemoryGuardrails(
  threadId: string,
  agentId: string | undefined,
  now: Date = new Date()
): Promise<{ reason: 'daily-cap-reached' | 'debounced'; detail: string } | null> {
  rollDay(now);

  const cap = dailySummaryCap;
  if (usedToday >= cap) {
    if (capLoggedForDay !== dayKey) {
      capLoggedForDay = dayKey;
      logger.warn(
        `[summary] daily summary cap reached (${usedToday}/${cap}) — automatic summarization paused until next UTC day`
      );
    }
    return { reason: 'daily-cap-reached', detail: `${usedToday}/${cap} generations today` };
  }

  const minIntervalMs = numEnv('SNAGLET_SUMMARY_MIN_INTERVAL_MS', DEFAULT_MIN_INTERVAL_MS);
  const key = `${threadId}:${agentId ?? 'shared'}`;
  const last = lastGenerationAt.get(key);
  if (last !== undefined && now.getTime() - last < minIntervalMs) {
    const waitMs = minIntervalMs - (now.getTime() - last);
    return {
      reason: 'debounced',
      detail: `next generation allowed in ${Math.ceil(waitMs / 1000)}s`,
    };
  }

  return null;
}

/** Record a completed generation (automatic or forced) for cap + debounce. */
export function recordSummaryGeneration(
  threadId: string,
  agentId: string | undefined,
  now: Date = new Date()
): void {
  rollDay(now);
  usedToday += 1;
  lastGenerationAt.set(`${threadId}:${agentId ?? 'shared'}`, now.getTime());
}

/** Current day's usage — surfaced by the status API / backfill. */
export async function getSummaryBudgetStatus(now: Date = new Date()): Promise<{
  usedToday: number;
  dailyCap: number;
  backfillUsedToday: number;
  backfillDailyCap: number;
}> {
  rollDay(now);
  return {
    usedToday,
    dailyCap: dailySummaryCap,
    backfillUsedToday,
    backfillDailyCap,
  };
}
