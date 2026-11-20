/**
 * What deleting a thread leaves behind, and its removal.
 *
 * A thread's node delete cascades every row that points at it, but not what
 * those rows own in turn: the `nodes` rows (with their embeddings and links)
 * of its messages, summaries and memories; its subagent helpers' runs (the
 * helper threads themselves go through the subagents trigger, and the helper
 * agents are archived, not deleted); its automations' schedules, run logs and
 * reminder ledger rows. Tray notifications and hook run logs name the thread
 * without a foreign key, so nothing cascades to them.
 *
 * `collectThreadResidue` reads the ids before the caller's mutation, inside
 * the purge transaction; `removeThreadResidue` deletes them after it, in the
 * same transaction; `announceThreadResidueRemoved` tells live views once it
 * has committed. Only threads that are gone after the mutation count, so a
 * clear (the thread stays) removes nothing here.
 */

import type { DbQueryable } from '@snaglet/db';
import { Reminders } from '@snaglet/db/tables/reminders';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { emitAutomationsChanged } from '@server/realtime/surfaces/automations';
import { emitCalendarChanged } from '@server/realtime/surfaces/calendar';
import { emitHookRunsChanged } from '@server/realtime/surfaces/hookRuns';
import { emitNotificationDismissed } from '@server/realtime/surfaces/notifications';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';

/** A row that belongs to one of the threads being purged (`threadId`: that thread). */
interface Owned {
  threadId: string;
  id: string;
}

interface OwnedAutomation extends Owned {
  calendarId: string | null;
}

interface ThreadResidue {
  threadIds: string[];
  /** Subagent helper threads of the purged threads (deleted with them by the subagents trigger). */
  helperThreads: Owned[];
  /** Message, summary and memory nodes whose rows the delete cascades away. */
  childNodeIds: string[];
  /** The threads' runs and their helpers' runs, including retired helpers' thread-less runs. */
  runs: Owned[];
  helperAgents: Owned[];
  automations: OwnedAutomation[];
}

export interface RemovedThreadResidue {
  /** Purged threads and their helper threads, all gone. */
  threadIds: string[];
  dismissedNotificationIds: string[];
  scheduleIds: string[];
  automations: Array<{ id: string; calendarId: string | null }>;
  /** Hooks whose run history lost rows. */
  hookNames: string[];
}

const NOTHING_REMOVED: RemovedThreadResidue = {
  threadIds: [],
  dismissedNotificationIds: [],
  scheduleIds: [],
  automations: [],
  hookNames: [],
};

async function owned(tx: DbQueryable, sql: string, threadIds: string[]): Promise<Owned[]> {
  const { rows } = await tx.query<Owned>(sql, [threadIds]);
  return rows;
}

/** Read what a delete of `threadIds` would leave behind. Call before the mutation. */
export async function collectThreadResidue(
  threadIds: string[],
  tx: DbQueryable
): Promise<ThreadResidue> {
  if (threadIds.length === 0) {
    return {
      threadIds,
      helperThreads: [],
      childNodeIds: [],
      runs: [],
      helperAgents: [],
      automations: [],
    };
  }
  const helperThreads = await owned(
    tx,
    `SELECT parent_thread_id AS "threadId", id FROM public.threads WHERE parent_thread_id = ANY($1::text[])
     UNION
     SELECT parent_thread_id, thread_id FROM public.subagents
      WHERE parent_thread_id = ANY($1::text[]) AND thread_id IS NOT NULL`,
    threadIds
  );
  const scope = [...threadIds, ...helperThreads.map((helper) => helper.id)];
  const { rows: children } = await tx.query<{ id: string }>(
    `SELECT id FROM public.messages WHERE thread_id = ANY($1::text[])
     UNION ALL
     SELECT id FROM public.thread_summaries WHERE thread_id = ANY($1::text[])
     UNION ALL
     SELECT id FROM public.memories WHERE source_thread_id = ANY($1::text[])`,
    [scope]
  );
  // A helper's runs are found through its thread while that exists, and
  // through its agent once a retire has deleted the thread (runs.thread_id is
  // SET NULL then).
  const runs = await owned(
    tx,
    `SELECT thread_id AS "threadId", id FROM public.runs WHERE thread_id = ANY($1::text[])
     UNION
     SELECT t.parent_thread_id, r.id
       FROM public.threads t JOIN public.runs r ON r.thread_id = t.id
      WHERE t.parent_thread_id = ANY($1::text[])
     UNION
     SELECT s.parent_thread_id, r.id
       FROM public.subagents s
       JOIN public.runs r ON r.agent_id = s.agent_id AND r.thread_id IS NULL
      WHERE s.parent_thread_id = ANY($1::text[])`,
    threadIds
  );
  const helperAgents = await owned(
    tx,
    `SELECT parent_thread_id AS "threadId", agent_id AS id
       FROM public.subagents WHERE parent_thread_id = ANY($1::text[])`,
    threadIds
  );
  const helperParent = new Map(helperThreads.map((helper) => [helper.id, helper.threadId]));
  const { rows: automationRows } = await tx.query<{
    id: string;
    threadId: string;
    calendarId: string | null;
  }>(
    `SELECT id, thread_id AS "threadId", calendar_id AS "calendarId"
       FROM public.automations WHERE thread_id = ANY($1::text[])`,
    [scope]
  );
  const automations = automationRows.map((row) => ({
    ...row,
    threadId: helperParent.get(row.threadId) ?? row.threadId,
  }));
  return {
    threadIds,
    helperThreads,
    childNodeIds: children.map((row) => row.id),
    runs,
    helperAgents,
    automations,
  };
}

/**
 * Delete what the mutation left behind, in its transaction. Child nodes go
 * whenever their row is gone; everything else only for threads that are gone.
 */
export async function removeThreadResidue(
  residue: ThreadResidue,
  tx: DbQueryable
): Promise<RemovedThreadResidue> {
  // A dead message node keeps a doc's link to it alive (every doc save
  // re-creates the link); a dead summary or memory node keeps its embeddings.
  if (residue.childNodeIds.length > 0) {
    await tx.query(
      `DELETE FROM public.nodes n
        WHERE n.id = ANY($1::text[])
          AND (   (n.type = 'message'
                   AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.id = n.id))
               OR (n.type = 'thread_summary'
                   AND NOT EXISTS (SELECT 1 FROM public.thread_summaries s WHERE s.id = n.id))
               OR (n.type = 'memory'
                   AND NOT EXISTS (SELECT 1 FROM public.memories m WHERE m.id = n.id)))`,
      [residue.childNodeIds]
    );
  }
  if (residue.threadIds.length === 0) return NOTHING_REMOVED;

  const { rows: survivors } = await tx.query<{ id: string }>(
    `SELECT id FROM public.threads WHERE id = ANY($1::text[])`,
    [residue.threadIds]
  );
  const kept = new Set(survivors.map((row) => row.id));
  const gone = residue.threadIds.filter((id) => !kept.has(id));
  if (gone.length === 0) return NOTHING_REMOVED;
  const isGone = (row: Owned) => !kept.has(row.threadId);
  const goneThreads = [...gone, ...residue.helperThreads.filter(isGone).map((helper) => helper.id)];
  const runIds = residue.runs.filter(isGone).map((run) => run.id);

  // Activity first: its run_id is ON DELETE SET NULL, so deleting the runs
  // first would strand it.
  if (runIds.length > 0) {
    await tx.query(`DELETE FROM public.agent_activity_log WHERE run_id = ANY($1::text[])`, [
      runIds,
    ]);
    await tx.query(`DELETE FROM public.runs WHERE id = ANY($1::text[])`, [runIds]);
  }

  // The helper agents stay, archived and out of every other thread, as a
  // retire or the subagent sweep leaves them: docs, containers and calendar
  // events a helper wrote name its member, and deleting it would erase that
  // authorship. Their runs went above; their memories and summaries of the
  // deleted threads went with the child nodes.
  const helperAgentIds = residue.helperAgents.filter(isGone).map((helper) => helper.id);
  if (helperAgentIds.length > 0) {
    await tx.query(
      `WITH gone AS (
         DELETE FROM public.thread_participants tp
          USING public.members m, public.agents a
          WHERE m.id = tp.member_id AND a.id = m.agent_id
            AND a.id = ANY($1::text[]) AND a.parent_agent_id IS NOT NULL
         RETURNING tp.thread_id, m.agent_id
       )
       DELETE FROM public.agent_skill_assignments s
        USING gone g
        WHERE s.agent_id = g.agent_id AND s.thread_id = g.thread_id`,
      [helperAgentIds]
    );
    await tx.query(
      `UPDATE public.agents SET archived = true, archived_at = COALESCE(archived_at, now())
        WHERE id = ANY($1::text[]) AND parent_agent_id IS NOT NULL`,
      [helperAgentIds]
    );
  }

  // An automation's schedule points back at it only by id in action_json.
  const automations = residue.automations.filter(isGone);
  const { rows: schedules } = automations.length
    ? await tx.query<{ id: string }>(
        `DELETE FROM public.schedules s
          WHERE s.action_kind = 'automation'
            AND s.action_json->>'automationId' = ANY($1::text[])
            AND NOT EXISTS (
              SELECT 1 FROM public.automations a WHERE a.id = s.action_json->>'automationId'
            )
          RETURNING s.id`,
        [automations.map((automation) => automation.id)]
      )
    : { rows: [] };

  // The reminders those automations fired: their ledger keys hold the automation id.
  await Reminders.deleteDeliveriesOf(
    automations.map((automation) => ({ kind: 'automation' as const, automationId: automation.id })),
    tx
  );

  const { rows: notifications } = await tx.query<{ id: string; dismissed: boolean }>(
    `DELETE FROM public.notifications
      WHERE thread_id = ANY($1::text[]) OR run_id = ANY($2::text[])
      RETURNING id, dismissed`,
    [goneThreads, runIds]
  );
  // A hook run's output can quote the conversation, so its finished runs go
  // with the thread even past the keep-latest-per-hook rule, which only
  // protects history from age pruning. A run still going is left alone: its
  // runner writes the result into that row when it finishes.
  const { rows: hookRuns } = await tx.query<{ hook_name: string }>(
    `DELETE FROM public.hook_runs
      WHERE thread_id = ANY($1::text[]) AND status <> 'running'
      RETURNING hook_name`,
    [goneThreads]
  );

  return {
    threadIds: goneThreads,
    dismissedNotificationIds: notifications.filter((row) => !row.dismissed).map((row) => row.id),
    scheduleIds: schedules.map((row) => row.id),
    automations: automations.map(({ id, calendarId }) => ({ id, calendarId })),
    hookNames: [...new Set(hookRuns.map((row) => row.hook_name))],
  };
}

/** Run one announcement; a failure is logged and the rest still run. */
async function attempt(what: string, announce: () => unknown): Promise<void> {
  try {
    await announce();
  } catch (err) {
    logger.warn(`[threads] after a thread delete, ${what} failed: ${getErrorMessage(err)}`);
  }
}

/**
 * After commit: refresh the scheduler, drop queued messages and tell open
 * views. Best-effort and each on its own: the data is gone already.
 */
export async function announceThreadResidueRemoved(removed: RemovedThreadResidue): Promise<void> {
  if (removed.scheduleIds.length > 0) {
    await attempt('the schedule refresh', async () => {
      // Loaded lazily: the scheduler reaches the thread services this module serves.
      const { scheduleService } = await import('@server/services/ScheduleService');
      scheduleService.notifySchedulesChanged(removed.scheduleIds);
    });
  }
  for (const threadId of removed.threadIds) {
    await attempt('dropping queued messages', () => pendingAgentMessages.clearThread(threadId));
  }
  for (const id of removed.dismissedNotificationIds) {
    await attempt('a notification dismissal', () => emitNotificationDismissed(id));
  }
  for (const automation of removed.automations) {
    await attempt('an automation refresh', () => {
      emitAutomationsChanged({ automationId: automation.id });
      emitCalendarChanged({
        kind: 'automation',
        automationId: automation.id,
        ...(automation.calendarId ? { calendarId: automation.calendarId } : {}),
      });
    });
  }
  await attempt('the hook run refresh', () =>
    emitHookRunsChanged(removed.hookNames, 'thread-delete')
  );
}
