/**
 * Thread history trimming: preview and apply. Deletion rules:
 * - Messages go through their `nodes` row (messages.id references nodes, so a
 *   direct delete leaks the node); the cascade takes embeddings and links.
 * - agent_activity_log goes before runs (its run_id is ON DELETE SET NULL, and
 *   orphans can't be traced to a thread); runs are deleted explicitly.
 * - Summaries go only when the user asks; otherwise their coverage is repaired.
 * - Shared nodes (files, docs…), actors and memories stay. The thread's
 *   last_message_at is corrected, since its trigger only fires on insert.
 */

import type { NodeRunner } from '@snaglet/db';
import { Threads } from '@snaglet/db/tables/threads';
import { AppError, ConflictError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import type {
  ThreadTrimApplyRequest,
  ThreadTrimApplyResult,
  ThreadTrimBoundary,
  ThreadTrimPreview,
  ThreadTrimPreviewRequest,
  ThreadTrimSides,
  ThreadTrimStats,
  ThreadTrimSummaryImpact,
} from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { withReservedThreadTransaction } from '@server/services/ThreadExecutionPurgeService';
import {
  describeTrimSides,
  expandForRunAtomicity,
  normalizeRequestedInterval,
  resolveTrimSides,
  type RetainedInterval,
} from './threadTrimPlan';
import {
  calculateThreadTotals,
  calculateTrimImpact,
  loadRunMessageSpans,
  loadTimelineShape,
  resolveBoundaries,
  type ResolvedBoundaryRow,
  type TrimImpact,
} from './threadTrimQueries';
import {
  assertTokenFresh,
  computeImpactDigest,
  computeThreadRevision,
  issueTrimToken,
  verifyTrimToken,
  TRIM_TOKEN_TTL_MS,
} from './threadTrimToken';

// Stats: the top bar

export async function getThreadTrimStats(threadId: string): Promise<ThreadTrimStats> {
  await assertThreadExists(threadId);
  const [shape, totals] = await Promise.all([
    loadTimelineShape(threadId),
    calculateThreadTotals(threadId),
  ]);
  return {
    threadId,
    messageCount: shape.messageCount,
    totals,
    threadBusy: isThreadBusy(threadId),
  };
}

// Preview

/**
 * A fully resolved plan: the interval that will really be retained, the sides
 * really being cut, and the boundary rows for the panel headings.
 */
interface ResolvedPlan {
  interval: RetainedInterval;
  expanded: boolean;
  trimPrefix: boolean;
  trimTail: boolean;
  /** `trimPrefix`/`trimTail` in words, for confirmation copy and the audit log. */
  sides: ThreadTrimSides;
  first: ResolvedBoundaryRow;
  last: ResolvedBoundaryRow;
}

/**
 * Resolve a requested interval into an executable plan.
 *
 * Runs against whatever `runner` it is given, so `preview` uses the pool and
 * `apply` re-runs the identical derivation inside its locked transaction. That
 * shared path is what makes "the plan you confirmed is the plan that ran" a
 * property of the code rather than a hope.
 */
async function resolvePlan(
  threadId: string,
  requestedFirst: number,
  requestedLast: number,
  messageCount: number,
  runner?: NodeRunner
): Promise<ResolvedPlan> {
  const requested = normalizeRequestedInterval(requestedFirst, requestedLast, messageCount);
  const spans = await loadRunMessageSpans(threadId, runner);
  const grown = expandForRunAtomicity(requested.first, requested.last, spans);
  const interval: RetainedInterval = { first: grown.first, last: grown.last };
  const sides = resolveTrimSides(interval, messageCount);

  const rows = await resolveBoundaries(threadId, [interval.first, interval.last], [], runner);
  const first = rows.find((row) => row.index === interval.first);
  const last = rows.find((row) => row.index === interval.last);
  if (!first || !last) {
    // Only reachable if rows vanished between the count and this lookup; inside
    // apply the transaction prevents it, and preview simply retries.
    throw new ConflictError(
      'The thread changed while the trim plan was being prepared. Nothing was deleted — try again.'
    );
  }
  return {
    interval,
    expanded: grown.expanded,
    trimPrefix: sides.trimPrefix,
    trimTail: sides.trimTail,
    sides: describeTrimSides(sides),
    first,
    last,
  };
}

export async function previewThreadTrim(
  threadId: string,
  request: ThreadTrimPreviewRequest
): Promise<ThreadTrimPreview> {
  await assertThreadExists(threadId);
  const shape = await loadTimelineShape(threadId);
  if (shape.messageCount === 0) {
    throw badRequest('This thread has no messages to trim.');
  }

  const requestedFirst = await resolveRequestedIndex(
    threadId,
    request.firstRetainedMessageId,
    request.firstRetainedIndex,
    0
  );
  const requestedLast = await resolveRequestedIndex(
    threadId,
    request.lastRetainedMessageId,
    request.lastRetainedIndex,
    shape.messageCount - 1
  );

  const plan = await resolvePlan(threadId, requestedFirst, requestedLast, shape.messageCount);

  const impact = await calculateTrimImpact({
    threadId,
    trimPrefix: plan.trimPrefix,
    trimTail: plan.trimTail,
    first: { createdAt: plan.first.createdAtExact, id: plan.first.messageId },
    last: { createdAt: plan.last.createdAtExact, id: plan.last.messageId },
    removeSummaries: request.removeSummaries,
  });

  const revision = computeThreadRevision(shape);
  const digest = impactDigest(impact);
  const token = issueTrimToken({
    t: threadId,
    r: revision,
    f: plan.first.messageId,
    l: plan.last.messageId,
    s: request.removeSummaries,
    d: digest,
    i: Date.now(),
  });

  return {
    threadId,
    sides: plan.sides,
    removeSummaries: request.removeSummaries,
    requested: { firstRetainedIndex: requestedFirst, lastRetainedIndex: requestedLast },
    firstRetained: toBoundary(plan.first),
    lastRetained: toBoundary(plan.last),
    expandedForRunAtomicity: plan.expanded,
    totals: impact.totals,
    removed: impact.removed,
    remaining: impact.remaining,
    summaryImpact: toSummaryImpact(impact),
    noop: impact.removed.messages === 0 && impact.removed.summaries === 0,
    threadBusy: isThreadBusy(threadId),
    token,
    tokenTtlMs: TRIM_TOKEN_TTL_MS,
  };
}

// Apply

export async function applyThreadTrim(
  threadId: string,
  request: ThreadTrimApplyRequest
): Promise<ThreadTrimApplyResult> {
  await assertThreadExists(threadId);

  const payload = verifyTrimToken(request.token);
  if (!payload) {
    throw badRequest(
      'The trim plan token is missing or malformed. Nothing was deleted — reopen the preview.'
    );
  }
  assertTokenFresh(payload);

  // The token must describe this request, on this thread. A token minted for a
  // different plan cannot be replayed against a different set of boundaries.
  if (
    payload.t !== threadId ||
    payload.f !== request.firstRetainedMessageId ||
    payload.l !== request.lastRetainedMessageId ||
    payload.s !== request.removeSummaries
  ) {
    throw badRequest(
      'The trim plan token does not match the submitted plan. Nothing was deleted — reopen the preview.'
    );
  }

  return withReservedThreadTransaction([threadId], async (tx) => {
    // Serialize against concurrent writers on the same thread. Everything below
    // is derived after this lock, so the recount cannot race an insert.
    await tx.query('SELECT id FROM public.threads WHERE id = $1 FOR UPDATE', [threadId]);

    const shape = await loadTimelineShape(threadId, tx);
    if (computeThreadRevision(shape) !== payload.r) {
      throw new ConflictError(
        'This thread changed after the trim preview was generated. Nothing was deleted — reopen the preview and confirm the new plan.'
      );
    }

    // Re-resolve the boundary ids against the live thread. Ids from another
    // thread simply do not resolve here, which is the cross-thread rejection.
    const boundaryRows = await resolveBoundaries(
      threadId,
      [],
      [request.firstRetainedMessageId, request.lastRetainedMessageId],
      tx
    );
    const firstRow = boundaryRows.find((r) => r.messageId === request.firstRetainedMessageId);
    const lastRow = boundaryRows.find((r) => r.messageId === request.lastRetainedMessageId);
    if (!firstRow || !lastRow) {
      throw badRequest('A boundary message does not belong to this thread. Nothing was deleted.');
    }

    // Re-derive the plan from live rows — never from the client's numbers.
    const plan = await resolvePlan(threadId, firstRow.index, lastRow.index, shape.messageCount, tx);
    if (
      plan.first.messageId !== request.firstRetainedMessageId ||
      plan.last.messageId !== request.lastRetainedMessageId
    ) {
      throw new ConflictError(
        'The trim boundaries no longer resolve to the reviewed messages. Nothing was deleted — reopen the preview.'
      );
    }

    const impact = await calculateTrimImpact(
      {
        threadId,
        trimPrefix: plan.trimPrefix,
        trimTail: plan.trimTail,
        first: { createdAt: plan.first.createdAtExact, id: plan.first.messageId },
        last: { createdAt: plan.last.createdAtExact, id: plan.last.messageId },
        removeSummaries: request.removeSummaries,
      },
      tx
    );
    if (impactDigest(impact) !== payload.d) {
      throw new ConflictError(
        'The trim impact recalculated to different figures than the preview showed. Nothing was deleted — reopen the preview.'
      );
    }

    if (!plan.trimPrefix && !plan.trimTail) {
      throw badRequest('This plan would not remove any history.');
    }

    const executed = await executeTrim(threadId, plan, request.removeSummaries, tx);

    // Every count must agree with what the user confirmed — including the
    // summaries the preview promised to keep and repair, since a preview that
    // said "10 kept" while the repair touched 9 is the same broken promise as a
    // miscounted delete. A mismatch means the derivation and the execution
    // disagree; abort rather than guess.
    if (
      executed.messages !== impact.removed.messages ||
      executed.runs !== impact.removed.runs ||
      executed.activity !== impact.removed.activity ||
      executed.summaries !== impact.removed.summaries ||
      executed.summariesRepaired !== impact.summary.repairedCoverage
    ) {
      throw new ConflictError(
        `Trim aborted: executed counts (${executed.messages} messages, ${executed.runs} runs, ` +
          `${executed.activity} activity, ${executed.summaries} summaries deleted, ` +
          `${executed.summariesRepaired} summaries repaired) did not match the confirmed plan ` +
          `(${impact.removed.messages}/${impact.removed.runs}/${impact.removed.activity}/` +
          `${impact.removed.summaries}/${impact.summary.repairedCoverage}). Nothing was deleted.`
      );
    }

    // Audit trail: counts, bytes and boundary ids only — never deleted content.
    // `sides` is derived from the interval that actually ran, so it records what
    // was removed rather than anything the client claimed it wanted.
    logger.info(
      `[thread-trim] thread=${threadId} sides=${plan.sides} ` +
        `retained=[${plan.first.messageId}..${plan.last.messageId}] ` +
        `removeSummaries=${request.removeSummaries} ` +
        `removed={messages:${executed.messages},runs:${executed.runs},activity:${executed.activity},` +
        `summaries:${executed.summaries},bytes:${impact.removed.bytes.total}} ` +
        `repairedSummaries=${executed.summariesRepaired} ` +
        `remaining={messages:${impact.remaining.messages},bytes:${impact.remaining.bytes.total}}`
    );

    return {
      threadId,
      sides: plan.sides,
      removeSummaries: request.removeSummaries,
      firstRetainedMessageId: plan.first.messageId,
      lastRetainedMessageId: plan.last.messageId,
      removed: impact.removed,
      remaining: impact.remaining,
      summaryImpact: toSummaryImpact(impact),
      // Nearest surviving message to the cut the user is looking at: a tail cut
      // lands them on the new end, otherwise on the new beginning.
      anchorMessageId: plan.trimTail ? plan.last.messageId : plan.first.messageId,
    };
  });
}

interface ExecutedCounts {
  messages: number;
  runs: number;
  activity: number;
  summaries: number;
  /** Kept summaries whose coverage bookkeeping was reset. */
  summariesRepaired: number;
}

/**
 * The deletion itself. Order is load-bearing:
 *   1. activity (its `run_id` is ON DELETE SET NULL, so it cannot follow runs)
 *   2. runs
 *   3. summary nodes the user asked to remove
 *   4. coverage repair on kept summaries, before the messages go, so the FK's
 *      ON DELETE SET NULL never races us for the anchor column
 *   5. message nodes, cascading the `messages` rows, embeddings and links
 */
async function executeTrim(
  threadId: string,
  plan: ResolvedPlan,
  removeSummaries: boolean,
  tx: NodeRunner
): Promise<ExecutedCounts> {
  const params = [
    threadId,
    plan.trimPrefix,
    plan.trimTail,
    plan.first.createdAtExact,
    plan.first.messageId,
    plan.last.createdAtExact,
    plan.last.messageId,
  ];

  const removedMessageIds = (
    await tx.query<{ id: string }>(
      `SELECT m.id
         FROM public.messages m
        WHERE m.thread_id = $1
          AND (
            ($2::boolean AND (m.created_at, m.id) < ($4::timestamptz, $5::text))
            OR
            ($3::boolean AND (m.created_at, m.id) > ($6::timestamptz, $7::text))
          )`,
      params
    )
  ).rows.map((r) => r.id);

  const removedRunIds = (
    await tx.query<{ id: string }>(
      `WITH msg AS (
         SELECT m.run_id,
                (
                  ($2::boolean AND (m.created_at, m.id) < ($4::timestamptz, $5::text))
                  OR
                  ($3::boolean AND (m.created_at, m.id) > ($6::timestamptz, $7::text))
                ) AS removed
           FROM public.messages m
          WHERE m.thread_id = $1
       ),
       run_rollup AS (
         SELECT run_id, bool_and(removed) AS all_removed
           FROM msg WHERE run_id IS NOT NULL GROUP BY run_id
       )
       SELECT r.id
         FROM public.runs r
         LEFT JOIN run_rollup rr ON rr.run_id = r.id
        WHERE r.thread_id = $1
          AND COALESCE(
                rr.all_removed,
                ($2::boolean AND r.started_at < $4::timestamptz)
                  OR ($3::boolean AND r.started_at > $6::timestamptz)
              )`,
      params
    )
  ).rows.map((r) => r.id);

  // Safety interlock. `messages.run_id` is ON DELETE SET NULL, so a surviving
  // message pointing at a run we are about to delete would be silently severed
  // from its tool cycles — the exact replay corruption trimming exists to
  // avoid. The run-atomicity rule makes this impossible; verify rather than
  // assume, and roll the whole transaction back if it ever happens.
  if (removedRunIds.length > 0) {
    const { rows: stranded } = await tx.query<{ id: string }>(
      `SELECT m.id
         FROM public.messages m
        WHERE m.thread_id = $1
          AND m.run_id = ANY($8::text[])
          AND NOT (
            ($2::boolean AND (m.created_at, m.id) < ($4::timestamptz, $5::text))
            OR
            ($3::boolean AND (m.created_at, m.id) > ($6::timestamptz, $7::text))
          )
        LIMIT 1`,
      [...params, removedRunIds]
    );
    if (stranded.length > 0) {
      throw new AppError(
        `Trim aborted: retained message ${stranded[0]?.id} belongs to a run scheduled for deletion. Nothing was deleted.`,
        ErrorCode.INTERNAL_ERROR,
        HTTP_STATUS.INTERNAL_SERVER_ERROR
      );
    }
  }

  // One statement, one predicate, two fates: `repair` splits the summaries this
  // plan keeps-and-corrects from the ones it deletes. Deriving both from a
  // single snapshot is what makes the pair provably disjoint — and it is the
  // same predicate `calculateTrimImpact` measured, so the preview's promise and
  // this execution cannot describe different rows.
  const summaryFates = (
    await tx.query<{ id: string; repair: boolean }>(
      `WITH msg AS (
         SELECT m.id, m.created_at,
                (
                  ($2::boolean AND (m.created_at, m.id) < ($4::timestamptz, $5::text))
                  OR
                  ($3::boolean AND (m.created_at, m.id) > ($6::timestamptz, $7::text))
                ) AS removed
           FROM public.messages m
          WHERE m.thread_id = $1
       ),
       cut AS (
         SELECT
           EXISTS (SELECT 1 FROM msg WHERE removed AND (created_at, id) < ($4::timestamptz, $5::text)) AS prefix_cut,
           EXISTS (SELECT 1 FROM msg WHERE removed AND (created_at, id) > ($6::timestamptz, $7::text)) AS tail_cut
       ),
       summ AS (
         SELECT s.id,
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
       )
       SELECT id, (invalidated AND NOT $8::boolean) AS repair
         FROM summ
        WHERE $8::boolean OR invalidated`,
      [...params, removeSummaries]
    )
  ).rows;
  const removedSummaryIds = summaryFates.filter((r) => !r.repair).map((r) => r.id);
  const repairedSummaryIds = summaryFates.filter((r) => r.repair).map((r) => r.id);

  // 1. activity, strictly before runs.
  let activityDeleted = 0;
  if (removedRunIds.length > 0) {
    const res = await tx.query(
      `DELETE FROM public.agent_activity_log WHERE run_id = ANY($1::text[])`,
      [removedRunIds]
    );
    activityDeleted = res.rowCount ?? 0;
  }

  // 1b. persisted compactions. A compaction summarizes turns up to a cut; once any history is
  //     removed it may describe turns that are gone, and a kept record would also keep hiding
  //     the units before its cut. Dropping them makes replay use the retained history in full,
  //     and the next fold summarizes what is still there. Joined through runs, so before step 2.
  if (removedMessageIds.length > 0) {
    await tx.query(
      `DELETE FROM public.agent_activity_log a
        USING public.runs r
        WHERE r.id = a.run_id
          AND r.thread_id = $1
          AND a.tool = 'compaction_summary'`,
      [threadId]
    );
    // The same for a fold saved as a thread summary: its text stays as an ordinary summary, but
    // replay stops applying it as a cut. Its coverage is zeroed with the column: it counts
    // replay units, not messages, so it must not feed the digest's watermark as a message count.
    await tx.query(
      `UPDATE public.thread_summaries
          SET compaction = NULL, messages_covered = 0, last_message_id = NULL
        WHERE thread_id = $1 AND compaction IS NOT NULL`,
      [threadId]
    );
  }

  // 2. runs.
  let runsDeleted = 0;
  if (removedRunIds.length > 0) {
    const res = await tx.query(`DELETE FROM public.runs WHERE id = ANY($1::text[])`, [
      removedRunIds,
    ]);
    runsDeleted = res.rowCount ?? 0;
  }

  // 3. summaries the user asked to remove, via the node spine (cascades
  //    thread_summaries + embeddings).
  let summariesDeleted = 0;
  if (removedSummaryIds.length > 0) {
    const res = await tx.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
      removedSummaryIds,
    ]);
    summariesDeleted = res.rowCount ?? 0;
  }

  // 4. Coverage repair on kept summaries. `messages_covered` is the watermark
  // SummaryService.shouldSummarize subtracts from the live message count; left
  // as is it would exceed that count and freeze summarization. Zero plus a NULL
  // anchor means "covers none of the remaining messages", so the next pass folds
  // the whole retained transcript into the existing summary. `version` and
  // `is_current` stay: clearing `is_current` would hide the memory from prompts.
  let summariesRepaired = 0;
  if (repairedSummaryIds.length > 0) {
    const res = await tx.query(
      `UPDATE public.thread_summaries
          SET messages_covered = 0,
              last_message_id  = NULL
        WHERE id = ANY($1::text[])`,
      [repairedSummaryIds]
    );
    summariesRepaired = res.rowCount ?? 0;
  }

  // 5. messages, via the node spine (cascades messages + embeddings + links).
  let messagesDeleted = 0;
  if (removedMessageIds.length > 0) {
    const res = await tx.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
      removedMessageIds,
    ]);
    messagesDeleted = res.rowCount ?? 0;
  }

  // The INSERT-only `update_thread_last_message` trigger cannot see a tail cut,
  // so correct the watermark by hand. Only the tail can move it.
  if (plan.trimTail) {
    await tx.query(`UPDATE public.threads SET last_message_at = $2 WHERE id = $1`, [
      threadId,
      plan.last.createdAtExact,
    ]);
  }

  return {
    messages: messagesDeleted,
    runs: runsDeleted,
    activity: activityDeleted,
    summaries: summariesDeleted,
    summariesRepaired,
  };
}

// Helpers

/** 400 — the caller asked for something this thread cannot do. */
function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

async function assertThreadExists(threadId: string): Promise<void> {
  const thread = await Threads.findById(threadId);
  if (!thread) {
    throw new AppError('Thread not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
}

/**
 * The DB `status='running'` flag can outlive a dead process, so the in-memory
 * tracker is the authority on liveness — same rule the run markers use.
 */
function isThreadBusy(threadId: string): boolean {
  return (
    activeRunTracker.hasActiveThread(threadId) || activeRunTracker.isThreadPurgeReserved(threadId)
  );
}

/** Resolve a requested edge from an id (preferred) or an ordinal. */
async function resolveRequestedIndex(
  threadId: string,
  messageId: string | undefined,
  index: number | undefined,
  fallback: number
): Promise<number> {
  if (typeof messageId === 'string' && messageId.trim() !== '') {
    const rows = await resolveBoundaries(threadId, [], [messageId]);
    const row = rows.find((r) => r.messageId === messageId);
    if (!row) {
      throw badRequest(`Message ${messageId} does not belong to this thread.`);
    }
    return row.index;
  }
  if (typeof index === 'number' && Number.isFinite(index)) return Math.trunc(index);
  return fallback;
}

/**
 * The exact figures the confirmation dialog showed, in a fixed order. `apply`
 * recomputes this from live rows and refuses if it differs — so a preview that
 * silently drifted cannot be confirmed.
 */
function impactDigest(impact: TrimImpact): string {
  return computeImpactDigest([
    impact.removed.messages,
    impact.removed.summaries,
    impact.removed.runs,
    impact.removed.activity,
    impact.removed.bytes.total,
    impact.remaining.messages,
    impact.remaining.summaries,
    impact.remaining.runs,
    impact.remaining.activity,
    impact.remaining.bytes.total,
    // The kept-and-repaired count is part of the promise, so it is part of what
    // the token binds: a plan whose repair set moved is a plan to re-confirm.
    impact.summary.repairedCoverage,
  ]);
}

function toBoundary(row: ResolvedBoundaryRow): ThreadTrimBoundary {
  return {
    messageId: row.messageId,
    index: row.index,
    createdAt: row.createdAt,
    role: row.role,
    agentId: row.agentId,
    userId: row.userId,
    authorLabel: row.authorLabel,
  };
}

function toSummaryImpact(impact: TrimImpact): ThreadTrimSummaryImpact {
  return {
    removedByChoice: impact.summary.removedByChoice,
    removedAsInvalidated: impact.summary.removedAsInvalidated,
    preserved: impact.summary.preserved,
    repairedCoverage: impact.summary.repairedCoverage,
    removed: impact.summary.removedByChoice + impact.summary.removedAsInvalidated,
    removedBytes: impact.summary.removedBytes,
  };
}
