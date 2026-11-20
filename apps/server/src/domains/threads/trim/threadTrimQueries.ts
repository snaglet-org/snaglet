/**
 * The trim calculation: one SQL statement behind every figure the product
 * shows (top bar, panel, confirmation and the re-check inside the delete), so
 * they cannot drift apart. The top bar passes a plan that removes nothing.
 *
 * Bytes are `SUM(pg_column_size(row))` over the rows in scope: stored width
 * after TOAST, generated columns included, index and page overhead excluded,
 * so a lower bound on space reclaimed. The timeline is ordered by the keyset
 * `(created_at, id)`: `created_at` alone ties within a turn.
 */

import { getDb, type NodeRunner } from '@snaglet/db';
import type { ThreadTrimTotals } from '@snaglet/shared/types';
import { partitionSummaryImpact, type RunMessageSpan } from './threadTrimPlan';

/**
 * Resolved keyset for one end of the retained interval.
 *
 * `createdAt` must carry FULL microsecond precision — use
 * `ResolvedBoundaryRow.createdAtExact`, never a value that has passed through a
 * JS `Date`. See that field for what truncation costs.
 */
interface BoundaryKey {
  createdAt: string;
  id: string;
}

export interface TrimImpactInput {
  threadId: string;
  trimPrefix: boolean;
  trimTail: boolean;
  first: BoundaryKey;
  last: BoundaryKey;
  removeSummaries: boolean;
}

export interface TrimImpact {
  totals: ThreadTrimTotals;
  removed: ThreadTrimTotals;
  remaining: ThreadTrimTotals;
  summary: {
    total: number;
    removedByChoice: number;
    removedAsInvalidated: number;
    preserved: number;
    /** Kept summaries whose coverage bookkeeping the apply path must reset. */
    repairedCoverage: number;
    removedBytes: number;
  };
}

/**
 * A keyset far outside any real timestamp, used when a side is not being cut.
 * The predicate is still evaluated (SQL has no short-circuit guarantee), so the
 * sentinel must not accidentally match: `-infinity` can never be greater than a
 * real `created_at`, and `infinity` can never be less than one.
 */
const NO_CUT_LOW: BoundaryKey = { createdAt: '-infinity', id: '' };
const NO_CUT_HIGH: BoundaryKey = { createdAt: 'infinity', id: '' };

/**
 * Impact of a trim plan, plus the whole-thread totals it was measured against.
 *
 * `remaining` is computed as `totals - removed` rather than by a second pass,
 * so "removed + remaining === total" holds by construction for every field.
 *
 * Pass `trimPrefix`/`trimTail` both false to get pure totals (the top-bar call).
 * Pass a `runner` to evaluate inside the deleting transaction, where it becomes
 * the authoritative post-lock recount.
 */
export async function calculateTrimImpact(
  input: TrimImpactInput,
  runner?: NodeRunner
): Promise<TrimImpact> {
  const r = runner ?? getDb();
  const first = input.trimPrefix ? input.first : NO_CUT_LOW;
  const last = input.trimTail ? input.last : NO_CUT_HIGH;

  const { rows } = await r.query<TrimImpactRawRow>(IMPACT_SQL, [
    input.threadId,
    input.trimPrefix,
    input.trimTail,
    first.createdAt,
    first.id,
    last.createdAt,
    last.id,
    input.removeSummaries,
  ]);
  const raw = rows[0];
  if (!raw) {
    // Aggregate-only SELECT always yields exactly one row; a miss means the
    // statement shape changed underneath this function.
    throw new Error('calculateTrimImpact: impact query returned no row');
  }
  return shapeImpact(raw, input.removeSummaries);
}

interface TrimImpactRawRow {
  total_messages: string;
  removed_messages: string;
  total_message_bytes: string;
  removed_message_bytes: string;
  total_message_embedding_bytes: string;
  removed_message_embedding_bytes: string;
  total_runs: string;
  removed_runs: string;
  total_run_bytes: string;
  removed_run_bytes: string;
  total_activity: string;
  removed_activity: string;
  total_activity_bytes: string;
  removed_activity_bytes: string;
  total_summaries: string;
  removed_summaries: string;
  invalidated_summaries: string;
  total_summary_bytes: string;
  removed_summary_bytes: string;
  total_summary_embedding_bytes: string;
  removed_summary_embedding_bytes: string;
}

const num = (value: string | null): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function shapeImpact(raw: TrimImpactRawRow, removeSummaries: boolean): TrimImpact {
  const totals: ThreadTrimTotals = {
    messages: num(raw.total_messages),
    summaries: num(raw.total_summaries),
    runs: num(raw.total_runs),
    activity: num(raw.total_activity),
    bytes: {
      messages: num(raw.total_message_bytes),
      messageEmbeddings: num(raw.total_message_embedding_bytes),
      runs: num(raw.total_run_bytes),
      activity: num(raw.total_activity_bytes),
      summaries: num(raw.total_summary_bytes),
      summaryEmbeddings: num(raw.total_summary_embedding_bytes),
      total: 0,
    },
  };
  const removed: ThreadTrimTotals = {
    messages: num(raw.removed_messages),
    summaries: num(raw.removed_summaries),
    runs: num(raw.removed_runs),
    activity: num(raw.removed_activity),
    bytes: {
      messages: num(raw.removed_message_bytes),
      messageEmbeddings: num(raw.removed_message_embedding_bytes),
      runs: num(raw.removed_run_bytes),
      activity: num(raw.removed_activity_bytes),
      summaries: num(raw.removed_summary_bytes),
      summaryEmbeddings: num(raw.removed_summary_embedding_bytes),
      total: 0,
    },
  };
  totals.bytes.total = sumBytes(totals);
  removed.bytes.total = sumBytes(removed);

  const partition = partitionSummaryImpact({
    total: totals.summaries,
    removed: removed.summaries,
    invalidated: num(raw.invalidated_summaries),
    removeSummaries,
  });
  return {
    totals,
    removed,
    remaining: subtractTotals(totals, removed),
    summary: {
      total: totals.summaries,
      ...partition,
      removedBytes: removed.bytes.summaries + removed.bytes.summaryEmbeddings,
    },
  };
}

function sumBytes(t: ThreadTrimTotals): number {
  const b = t.bytes;
  return b.messages + b.messageEmbeddings + b.runs + b.activity + b.summaries + b.summaryEmbeddings;
}

function subtractTotals(a: ThreadTrimTotals, b: ThreadTrimTotals): ThreadTrimTotals {
  const nonNeg = (x: number): number => Math.max(0, x);
  const out: ThreadTrimTotals = {
    messages: nonNeg(a.messages - b.messages),
    summaries: nonNeg(a.summaries - b.summaries),
    runs: nonNeg(a.runs - b.runs),
    activity: nonNeg(a.activity - b.activity),
    bytes: {
      messages: nonNeg(a.bytes.messages - b.bytes.messages),
      messageEmbeddings: nonNeg(a.bytes.messageEmbeddings - b.bytes.messageEmbeddings),
      runs: nonNeg(a.bytes.runs - b.bytes.runs),
      activity: nonNeg(a.bytes.activity - b.bytes.activity),
      summaries: nonNeg(a.bytes.summaries - b.bytes.summaries),
      summaryEmbeddings: nonNeg(a.bytes.summaryEmbeddings - b.bytes.summaryEmbeddings),
      total: 0,
    },
  };
  out.bytes.total = sumBytes(out);
  return out;
}

/**
 * $1 threadId, $2 trimPrefix, $3 trimTail, $4/$5 first retained keyset,
 * $6/$7 last retained keyset, $8 removeSummaries. A run goes when all of its
 * messages go (`bool_and`); a run with no messages (aborted before replying,
 * its activity still replays) is placed by `started_at`. Summaries are removed
 * only by `removeSummaries`; coverage picks which kept ones need repair: any
 * prefix cut, or a tail cut past the covered end (`last_message_id`, else the
 * summary's `created_at`). A repaired summary (`messages_covered = 0`) never
 * matches again.
 */
const IMPACT_SQL = `
WITH msg AS (
  SELECT m.id,
         m.run_id,
         m.created_at,
         (
           ($2::boolean AND (m.created_at, m.id) < ($4::timestamptz, $5::text))
           OR
           ($3::boolean AND (m.created_at, m.id) > ($6::timestamptz, $7::text))
         ) AS removed,
         pg_column_size(m.*)::bigint AS bytes
    FROM public.messages m
   WHERE m.thread_id = $1
),
msg_emb AS (
  SELECT msg.removed, pg_column_size(e.*)::bigint AS bytes
    FROM public.embeddings e
    JOIN msg ON msg.id = e.node_id
),
run_rollup AS (
  SELECT run_id, bool_and(removed) AS all_removed
    FROM msg
   WHERE run_id IS NOT NULL
   GROUP BY run_id
),
run AS (
  SELECT r.id,
         COALESCE(
           rr.all_removed,
           ($2::boolean AND r.started_at < $4::timestamptz)
             OR ($3::boolean AND r.started_at > $6::timestamptz)
         ) AS removed,
         pg_column_size(r.*)::bigint AS bytes
    FROM public.runs r
    LEFT JOIN run_rollup rr ON rr.run_id = r.id
   WHERE r.thread_id = $1
),
act AS (
  SELECT run.removed, pg_column_size(a.*)::bigint AS bytes
    FROM public.agent_activity_log a
    JOIN run ON run.id = a.run_id
),
cut AS (
  SELECT
    EXISTS (
      SELECT 1 FROM msg
       WHERE removed AND (created_at, id) < ($4::timestamptz, $5::text)
    ) AS prefix_cut,
    EXISTS (
      SELECT 1 FROM msg
       WHERE removed AND (created_at, id) > ($6::timestamptz, $7::text)
    ) AS tail_cut
),
summ AS (
  SELECT s.id,
         pg_column_size(s.*)::bigint AS bytes,
         (
           s.messages_covered > 0
           AND (
             cut.prefix_cut
             OR (
               cut.tail_cut
               AND COALESCE(
                     (lm.created_at, lm.id) > ($6::timestamptz, $7::text),
                     s.created_at > $6::timestamptz
                   )
             )
           )
         ) AS invalidated
    FROM public.thread_summaries s
    CROSS JOIN cut
    LEFT JOIN public.messages lm ON lm.id = s.last_message_id AND lm.thread_id = $1
   WHERE s.thread_id = $1
),
summ_flag AS (
  SELECT id, bytes, invalidated, $8::boolean AS removed FROM summ
),
summ_emb AS (
  SELECT sf.removed, pg_column_size(e.*)::bigint AS bytes
    FROM public.embeddings e
    JOIN summ_flag sf ON sf.id = e.node_id
)
SELECT
  (SELECT count(*) FROM msg)::text                                             AS total_messages,
  (SELECT count(*) FROM msg WHERE removed)::text                               AS removed_messages,
  (SELECT COALESCE(sum(bytes), 0) FROM msg)::text                              AS total_message_bytes,
  (SELECT COALESCE(sum(bytes), 0) FROM msg WHERE removed)::text                AS removed_message_bytes,
  (SELECT COALESCE(sum(bytes), 0) FROM msg_emb)::text                          AS total_message_embedding_bytes,
  (SELECT COALESCE(sum(bytes), 0) FROM msg_emb WHERE removed)::text            AS removed_message_embedding_bytes,
  (SELECT count(*) FROM run)::text                                             AS total_runs,
  (SELECT count(*) FROM run WHERE removed)::text                               AS removed_runs,
  (SELECT COALESCE(sum(bytes), 0) FROM run)::text                              AS total_run_bytes,
  (SELECT COALESCE(sum(bytes), 0) FROM run WHERE removed)::text                AS removed_run_bytes,
  (SELECT count(*) FROM act)::text                                             AS total_activity,
  (SELECT count(*) FROM act WHERE removed)::text                               AS removed_activity,
  (SELECT COALESCE(sum(bytes), 0) FROM act)::text                              AS total_activity_bytes,
  (SELECT COALESCE(sum(bytes), 0) FROM act WHERE removed)::text                AS removed_activity_bytes,
  (SELECT count(*) FROM summ_flag)::text                                       AS total_summaries,
  (SELECT count(*) FROM summ_flag WHERE removed)::text                         AS removed_summaries,
  (SELECT count(*) FROM summ_flag WHERE invalidated)::text                     AS invalidated_summaries,
  (SELECT COALESCE(sum(bytes), 0) FROM summ_flag)::text                        AS total_summary_bytes,
  (SELECT COALESCE(sum(bytes), 0) FROM summ_flag WHERE removed)::text          AS removed_summary_bytes,
  (SELECT COALESCE(sum(bytes), 0) FROM summ_emb)::text                         AS total_summary_embedding_bytes,
  (SELECT COALESCE(sum(bytes), 0) FROM summ_emb WHERE removed)::text           AS removed_summary_embedding_bytes
`;

/** Totals for a thread with no plan applied — the top-bar figure. */
export async function calculateThreadTotals(
  threadId: string,
  runner?: NodeRunner
): Promise<ThreadTrimTotals> {
  const impact = await calculateTrimImpact(
    {
      threadId,
      trimPrefix: false,
      trimTail: false,
      first: NO_CUT_LOW,
      last: NO_CUT_HIGH,
      removeSummaries: false,
    },
    runner
  );
  return impact.totals;
}

// Timeline geometry

/** Message-count + endpoint fingerprint used for stale-plan detection. */
export interface ThreadTimelineShape {
  messageCount: number;
  firstKey: BoundaryKey | null;
  lastKey: BoundaryKey | null;
  runCount: number;
  activityCount: number;
  summaryCount: number;
}

const TIMELINE_SHAPE_SQL = `
SELECT
  (SELECT count(*) FROM public.messages WHERE thread_id = $1)::text AS message_count,
  (SELECT count(*) FROM public.runs WHERE thread_id = $1)::text     AS run_count,
  (SELECT count(*)
     FROM public.agent_activity_log a
     JOIN public.runs r ON r.id = a.run_id
    WHERE r.thread_id = $1)::text                                   AS activity_count,
  (SELECT count(*) FROM public.thread_summaries WHERE thread_id = $1)::text AS summary_count,
  (SELECT m.created_at FROM public.messages m WHERE m.thread_id = $1
    ORDER BY m.created_at ASC, m.id ASC LIMIT 1)                    AS first_created_at,
  (SELECT m.id FROM public.messages m WHERE m.thread_id = $1
    ORDER BY m.created_at ASC, m.id ASC LIMIT 1)                    AS first_id,
  (SELECT m.created_at FROM public.messages m WHERE m.thread_id = $1
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1)                  AS last_created_at,
  (SELECT m.id FROM public.messages m WHERE m.thread_id = $1
    ORDER BY m.created_at DESC, m.id DESC LIMIT 1)                  AS last_id
`;

/**
 * Cheap shape of a thread's timeline. Every field is an aggregate or an
 * index-backed endpoint lookup, so this stays O(1)-ish on huge threads — the
 * slider never has to download a transcript to know its own domain.
 */
export async function loadTimelineShape(
  threadId: string,
  runner?: NodeRunner
): Promise<ThreadTimelineShape> {
  const r = runner ?? getDb();
  const { rows } = await r.query<{
    message_count: string;
    run_count: string;
    activity_count: string;
    summary_count: string;
    first_created_at: string | null;
    first_id: string | null;
    last_created_at: string | null;
    last_id: string | null;
  }>(TIMELINE_SHAPE_SQL, [threadId]);
  const row = rows[0];
  if (!row) throw new Error('loadTimelineShape: shape query returned no row');
  return {
    messageCount: num(row.message_count),
    runCount: num(row.run_count),
    activityCount: num(row.activity_count),
    summaryCount: num(row.summary_count),
    firstKey:
      row.first_created_at && row.first_id
        ? { createdAt: toIso(row.first_created_at), id: row.first_id }
        : null,
    lastKey:
      row.last_created_at && row.last_id
        ? { createdAt: toIso(row.last_created_at), id: row.last_id }
        : null,
  };
}

/** node-postgres may hand back a Date or a string depending on parser config. */
function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Ordinal spans of every run that owns at least one message in the thread. */
export async function loadRunMessageSpans(
  threadId: string,
  runner?: NodeRunner
): Promise<RunMessageSpan[]> {
  const r = runner ?? getDb();
  const { rows } = await r.query<{ run_id: string; lo: string; hi: string }>(
    `WITH ordered AS (
       SELECT m.run_id,
              ROW_NUMBER() OVER (ORDER BY m.created_at ASC, m.id ASC) - 1 AS ord
         FROM public.messages m
        WHERE m.thread_id = $1
     )
     SELECT run_id, MIN(ord)::text AS lo, MAX(ord)::text AS hi
       FROM ordered
      WHERE run_id IS NOT NULL
      GROUP BY run_id`,
    [threadId]
  );
  return rows.map((row) => ({ runId: row.run_id, lo: num(row.lo), hi: num(row.hi) }));
}

/** A boundary message with its ordinal and author identity, for the panel head. */
export interface ResolvedBoundaryRow {
  index: number;
  messageId: string;
  /** Millisecond ISO, for display only. */
  createdAt: string;
  /**
   * The row's timestamp at full microsecond precision, as Postgres text. Keyset
   * predicates use this, never `createdAt`: a JS `Date` truncates to
   * milliseconds, which moves the boundary earlier and would delete the last
   * retained message on a tail cut (or keep a doomed one on a prefix cut).
   */
  createdAtExact: string;
  role: 'user' | 'assistant';
  agentId: string | null;
  userId: string | null;
  authorLabel: string | null;
}

/** `2026-08-02T21:15:30.943127Z` — full precision, and re-parses as timestamptz. */
const EXACT_TS = `to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const BOUNDARY_SQL = `
WITH ordered AS (
  SELECT m.id, m.created_at, m.role, m.agent_id, m.user_id, m.external_sender,
         ROW_NUMBER() OVER (ORDER BY m.created_at ASC, m.id ASC) - 1 AS ord
    FROM public.messages m
   WHERE m.thread_id = $1
)
SELECT o.ord::text AS ord, o.id, o.created_at, ${EXACT_TS} AS created_at_exact,
       o.role, o.agent_id, o.user_id,
       COALESCE(ag.name, u.name, o.external_sender) AS author_label
  FROM ordered o
  LEFT JOIN public.agents ag ON ag.id = o.agent_id
  LEFT JOIN public.users u   ON u.id = o.user_id
 WHERE o.ord = ANY($2::bigint[]) OR o.id = ANY($3::text[])
`;

/**
 * Resolve boundaries by ordinal AND/OR by message id in one pass.
 *
 * Accepting both is what lets the two previews drive the slider: clicking a
 * message in a preview yields an id, and the slider needs its ordinal, while
 * dragging a handle yields an ordinal and the panel needs the id. Ids that
 * belong to another thread simply do not appear in `ordered`, which is the
 * cross-thread rejection the authorization contract requires.
 */
export async function resolveBoundaries(
  threadId: string,
  ordinals: readonly number[],
  messageIds: readonly string[],
  runner?: NodeRunner
): Promise<ResolvedBoundaryRow[]> {
  const r = runner ?? getDb();
  const { rows } = await r.query<{
    ord: string;
    id: string;
    created_at: string | Date;
    created_at_exact: string;
    role: string;
    agent_id: string | null;
    user_id: string | null;
    author_label: string | null;
  }>(BOUNDARY_SQL, [threadId, ordinals, messageIds]);
  return rows.map((row) => ({
    index: num(row.ord),
    messageId: row.id,
    createdAt: toIso(row.created_at),
    createdAtExact: row.created_at_exact,
    role: row.role === 'user' ? 'user' : 'assistant',
    agentId: row.agent_id,
    userId: row.user_id,
    authorLabel: row.author_label,
  }));
}
