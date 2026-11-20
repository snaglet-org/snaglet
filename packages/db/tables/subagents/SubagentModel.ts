/**
 * SubagentModel — one row per helper an agent started.
 *
 * A helper is an ordinary agent row (agents.parent_agent_id set) running in an
 * ordinary but hidden thread (threads.parent_thread_id set). This row is the
 * lifecycle that ties them to the orchestrator and its thread: status, the
 * latest result row, and the orchestrator run that received it. A cleaned-up
 * helper keeps its row with `deletedAt` set; live queries skip it.
 *
 * `stopped` means paused: the helper is kept with its thread and work and
 * runs again only when it gets a new task, or at `resumeAt` when the
 * pause was timed.
 */

import { Model } from '@snaglet/db/Model';

export type SubagentStatus = 'running' | 'finished' | 'failed' | 'stopped';
export const SUBAGENT_STATUSES: readonly SubagentStatus[] = [
  'running',
  'finished',
  'failed',
  'stopped',
] as const;

export interface SubagentRow {
  id: string;
  parentThreadId: string;
  orchestratorAgentId: string;
  agentId: string;
  /** Null once the helper thread is gone. */
  threadId: string | null;
  startedByRunId: string | null;
  name: string;
  providerId: string;
  modelId: string;
  status: SubagentStatus;
  error: string | null;
  lastResultMessageId: string | null;
  /** The helper reply the latest result carried. */
  lastReplyMessageId: string | null;
  deliveredRunId: string | null;
  /** When a timed pause ends; only ever set while `status` is 'stopped'. */
  resumeAt: string | null;
  taskCount: number;
  lastTaskAt: string;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

type CreateSubagentInput = Pick<
  SubagentRow,
  | 'parentThreadId'
  | 'orchestratorAgentId'
  | 'agentId'
  | 'threadId'
  | 'startedByRunId'
  | 'name'
  | 'providerId'
  | 'modelId'
> & { id?: string };

const LIVE = 'deleted_at IS NULL';

class SubagentModelClass extends Model<SubagentRow, CreateSubagentInput> {
  constructor() {
    super({ table: 'subagents', primaryKey: 'id' });
  }

  /** The live helper called `name` (case-insensitive) in a parent thread. */
  async findLiveByName(parentThreadId: string, name: string): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `SELECT * FROM public.subagents
        WHERE parent_thread_id = $1 AND lower(name) = lower($2) AND ${LIVE}`,
      [parentThreadId, name]
    );
  }

  /** Live helpers of a parent thread, oldest first. */
  async listLiveForParent(parentThreadId: string): Promise<SubagentRow[]> {
    return this.query<SubagentRow>(
      `SELECT * FROM public.subagents
        WHERE parent_thread_id = $1 AND ${LIVE}
        ORDER BY created_at, id`,
      [parentThreadId]
    );
  }

  /** The live row whose hidden thread is `threadId`. */
  async findLiveByThreadId(threadId: string): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `SELECT * FROM public.subagents WHERE thread_id = $1 AND ${LIVE}`,
      [threadId]
    );
  }

  /** The row backed by helper agent `agentId` (live or not). */
  async findByAgentId(agentId: string): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(`SELECT * FROM public.subagents WHERE agent_id = $1`, [
      agentId,
    ]);
  }

  /** The model the helper now runs on (a model override in its own thread). */
  async updateModel(
    id: string,
    model: { providerId: string; modelId: string }
  ): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `UPDATE public.subagents SET provider_id = $2, model_id = $3, updated_at = now()
        WHERE id = $1 AND ${LIVE}
        RETURNING *`,
      [id, model.providerId, model.modelId]
    );
  }

  /** A new task for an existing helper: back to running. A timed pause it was in is over. */
  async markRunning(id: string): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `UPDATE public.subagents
          SET status = 'running', finished_at = NULL, error = NULL, resume_at = NULL,
              task_count = task_count + CASE WHEN status = 'running' THEN 0 ELSE 1 END,
              last_task_at = now(), updated_at = now()
        WHERE id = $1 AND ${LIVE}
        RETURNING *`,
      [id]
    );
  }

  /**
   * A run of the helper ended. Only a running row moves, so a late duplicate
   * signal cannot overwrite a newer result.
   */
  async markEnded(
    id: string,
    input: {
      status: Exclude<SubagentStatus, 'running'>;
      error: string | null;
      resultMessageId: string;
      replyMessageId: string | null;
    }
  ): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `UPDATE public.subagents
          SET status = $2, error = $3, last_result_message_id = $4, last_reply_message_id = $5,
              delivered_run_id = NULL, finished_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running' AND ${LIVE}
        RETURNING *`,
      [id, input.status, input.error, input.resultMessageId, input.replyMessageId]
    );
  }

  /**
   * Paused (from any live state): kept with its thread, `resumeAt` set for a
   * timed pause. The pause notice becomes the latest result, undelivered.
   */
  async markPaused(
    id: string,
    input: { resultMessageId: string; replyMessageId: string | null; resumeAt: string | null }
  ): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `UPDATE public.subagents
          SET status = 'stopped', error = NULL, resume_at = $4,
              last_result_message_id = $2,
              last_reply_message_id = COALESCE($3, last_reply_message_id),
              delivered_run_id = NULL, finished_at = now(), updated_at = now()
        WHERE id = $1 AND ${LIVE}
        RETURNING *`,
      [id, input.resultMessageId, input.replyMessageId, input.resumeAt]
    );
  }

  /**
   * Paused while its latest result still waits for the orchestrator: that
   * result stays the latest and undelivered, so it is still delivered.
   */
  async markPausedKeepingResult(id: string, resumeAt: string | null): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `UPDATE public.subagents
          SET status = 'stopped', resume_at = $2, finished_at = now(), updated_at = now()
        WHERE id = $1 AND status <> 'running' AND ${LIVE}
        RETURNING *`,
      [id, resumeAt]
    );
  }

  /**
   * A timed pause is due: back to running in one statement, so the minute
   * check and boot recovery can never both resume the same helper.
   */
  async claimDueResume(id: string): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `UPDATE public.subagents
          SET status = 'running', finished_at = NULL, error = NULL, resume_at = NULL,
              task_count = task_count + 1, last_task_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'stopped' AND resume_at IS NOT NULL
          AND resume_at <= now() AND ${LIVE}
        RETURNING *`,
      [id]
    );
  }

  /** Live helpers whose timed pause has ended, oldest first. */
  async listResumeDue(): Promise<SubagentRow[]> {
    return this.query<SubagentRow>(
      `SELECT * FROM public.subagents
        WHERE resume_at IS NOT NULL AND resume_at <= now() AND ${LIVE}
        ORDER BY resume_at, id`
    );
  }

  /** Drop a timed pause's timer (the helper stays paused). */
  async clearResumeAt(id: string): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `UPDATE public.subagents SET resume_at = NULL, updated_at = now()
        WHERE id = $1 AND resume_at IS NOT NULL AND ${LIVE}
        RETURNING *`,
      [id]
    );
  }

  /**
   * Someone other than the helper wrote in its thread: that new task replaces
   * a scheduled resume. Returns the row whose timer was cleared, if any.
   */
  async clearResumeAtForThread(
    threadId: string,
    authorAgentId: string | null
  ): Promise<SubagentRow | null> {
    return this.queryOne<SubagentRow>(
      `UPDATE public.subagents SET resume_at = NULL, updated_at = now()
        WHERE thread_id = $1 AND resume_at IS NOT NULL
          AND agent_id IS DISTINCT FROM $2::text AND ${LIVE}
        RETURNING *`,
      [threadId, authorAgentId]
    );
  }

  /** Live helpers of one orchestrator in one parent thread whose latest result is undelivered. */
  async listUndelivered(
    parentThreadId: string,
    orchestratorAgentId: string
  ): Promise<SubagentRow[]> {
    return this.query<SubagentRow>(
      `SELECT * FROM public.subagents
        WHERE parent_thread_id = $1 AND orchestrator_agent_id = $2 AND ${LIVE}
          AND status <> 'running' AND last_result_message_id IS NOT NULL
          AND delivered_run_id IS NULL
        ORDER BY finished_at, id`,
      [parentThreadId, orchestratorAgentId]
    );
  }

  /** Live helpers whose latest result was delivered and that got no new task since. */
  async listDelivered(): Promise<SubagentRow[]> {
    return this.query<SubagentRow>(
      `SELECT * FROM public.subagents
        WHERE delivered_run_id IS NOT NULL AND status <> 'running' AND ${LIVE}`
    );
  }

  /**
   * Helper agents that no live row backs any more (a parent thread was
   * deleted, so its rows cascaded away) and that are not archived yet.
   */
  async listOrphanHelperAgentIds(): Promise<string[]> {
    const rows = await this.query<{ id: string }>(
      `SELECT a.id FROM public.agents a
        WHERE a.parent_agent_id IS NOT NULL AND a.archived = false
          AND NOT EXISTS (
            SELECT 1 FROM public.subagents s WHERE s.agent_id = a.id AND s.deleted_at IS NULL
          )`
    );
    return rows.map((r) => r.id);
  }

  /**
   * Take retired helpers out of every thread they are still a participant
   * in (for example through an @mention): archived `subagent-…` helper agents
   * that no live row backs.
   * Their skill picks for those threads go too. Regular agents, archived or
   * not, keep their rows. Idempotent; returns how many rows went.
   */
  async removeRetiredHelperParticipants(): Promise<number> {
    const rows = await this.query<{ removed: number }>(
      `WITH retired AS (
         SELECT m.id AS member_id, a.id AS agent_id
           FROM public.members m
           JOIN public.agents a ON a.id = m.agent_id
          WHERE a.id LIKE 'subagent-%' AND a.parent_agent_id IS NOT NULL AND a.archived = true
            AND NOT EXISTS (
              SELECT 1 FROM public.subagents s WHERE s.agent_id = a.id AND s.${LIVE}
            )
       ),
       gone AS (
         DELETE FROM public.thread_participants tp
          USING retired r
          WHERE tp.member_id = r.member_id
         RETURNING tp.thread_id, r.agent_id
       ),
       picks AS (
         DELETE FROM public.agent_skill_assignments sa
          USING gone g
          WHERE sa.agent_id = g.agent_id AND sa.thread_id = g.thread_id
       )
       SELECT count(*)::int AS removed FROM gone`
    );
    return rows[0]?.removed ?? 0;
  }

  /** The orchestrator run `runId` received this helper's latest result. */
  async markDelivered(id: string, runId: string): Promise<void> {
    await this.query(
      `UPDATE public.subagents SET delivered_run_id = $2, updated_at = now()
        WHERE id = $1 AND status <> 'running' AND ${LIVE}`,
      [id, runId]
    );
  }

  /**
   * Helpers the orchestrator is done with after `runId`: their latest result
   * reached that run and they were not given another task since.
   */
  async listDoneAfterRun(runId: string): Promise<SubagentRow[]> {
    return this.query<SubagentRow>(
      `SELECT * FROM public.subagents
        WHERE delivered_run_id = $1 AND status <> 'running' AND ${LIVE}`,
      [runId]
    );
  }

  /**
   * Live helpers with no activity for `idleMs`. A helper with a timed pause
   * is never idle: its resume is scheduled work.
   */
  async listIdleSince(idleMs: number): Promise<SubagentRow[]> {
    return this.query<SubagentRow>(
      `SELECT * FROM public.subagents
        WHERE ${LIVE} AND resume_at IS NULL
          AND GREATEST(last_task_at, COALESCE(finished_at, last_task_at))
              < now() - ($1::double precision * interval '1 millisecond')`,
      [idleMs]
    );
  }

  /** Every live helper still marked running (boot recovery). */
  async listRunning(): Promise<SubagentRow[]> {
    return this.query<SubagentRow>(
      `SELECT * FROM public.subagents WHERE status = 'running' AND ${LIVE}`
    );
  }

  /**
   * Mark cleaned up. The caller deletes the thread and retires the agent.
   * `resultMessageId` (a removal notice) becomes the latest result, so an
   * op:wait on the helper returns it.
   */
  async markDeleted(id: string, resultMessageId: string | null = null): Promise<void> {
    await this.query(
      `UPDATE public.subagents
          SET deleted_at = now(), updated_at = now(), resume_at = NULL,
              status = CASE WHEN status = 'running' THEN 'stopped' ELSE status END,
              finished_at = COALESCE(finished_at, now()),
              last_result_message_id = COALESCE($2::text, last_result_message_id),
              delivered_run_id = CASE WHEN $2::text IS NULL THEN delivered_run_id END
        WHERE id = $1 AND ${LIVE}`,
      [id, resultMessageId]
    );
  }
}

export const Subagents = new SubagentModelClass();
