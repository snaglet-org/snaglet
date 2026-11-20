/**
 * RunModel — Model class for the runs table.
 *
 * Extends the base Model with run-specific status management
 * (marking completed, failed, bulk failure of running runs).
 */

import { Model } from '@snaglet/db/Model';
import { isoNow } from '@snaglet/shared/utils';

export interface RunRow {
  id: string;
  /**
   * NULL once a subagent helper's thread is retired: the run stays as usage of
   * the parent thread until that thread is deleted. A thread's own hard delete
   * removes its runs (ThreadExecutionPurgeService).
   */
  threadId: string | null;
  /** NULL once the owning agent is deleted — the run survives as usage history. */
  agentId: string | null;
  providerId: string;
  model: string;
  status: string;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Prompt-cache usage across the run. NULL means never recorded; 0 means
   * recorded and the provider reported no cache activity. Cache reads come
   * from the Anthropic, Gemini and OpenAI-style chat-completions adapters;
   * only the Anthropic adapter reports cache writes.
   */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** Provider round-trips in the run — turns run totals into per-call averages. */
  providerCalls: number | null;
  createdAt: string;
}

interface RunCompletionUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  providerCalls?: number | null;
  finishedAt?: string;
}

export interface CreateRunInput {
  id: string;
  threadId: string;
  agentId: string;
  providerId: string;
  model: string;
  status?: string;
  startedAt?: string;
}

export interface UpdateRunInput {
  status?: string;
  error?: string | null;
  finishedAt?: string | null;
}

class RunModelClass extends Model<RunRow, CreateRunInput, UpdateRunInput> {
  constructor() {
    super({
      table: 'runs',
      primaryKey: 'id',
      updatedAtColumn: null, // runs table has no updated_at column
    });
  }

  /**
   * Create a new run with status defaulting to 'running'
   * and started_at defaulting to now.
   */
  override async create(input: CreateRunInput): Promise<RunRow> {
    return super.create({
      ...input,
      status: input.status ?? 'running',
      startedAt: input.startedAt ?? isoNow(),
    });
  }

  /** Mark a run as completed, optionally recording token usage and finish time. */
  async markCompleted(id: string, usage: RunCompletionUsage = {}): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET status = 'completed',
           finished_at = $2,
           input_tokens = $3,
           output_tokens = $4,
           cache_read_tokens = $5,
           cache_creation_tokens = $6,
           provider_calls = $7
       WHERE id = $1`,
      [
        id,
        usage.finishedAt ?? isoNow(),
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.cacheReadTokens ?? null,
        usage.cacheCreationTokens ?? null,
        usage.providerCalls ?? null,
      ]
    );
  }

  /** Mark a run as failed, optionally recording partial token usage. */
  async markFailed(id: string, error: string, usage: RunCompletionUsage = {}): Promise<void> {
    await this.pool.query(
      `UPDATE runs
       SET status = 'failed',
           error = $2,
           finished_at = $3,
           input_tokens = $4,
           output_tokens = $5,
           cache_read_tokens = $6,
           cache_creation_tokens = $7,
           provider_calls = $8
       WHERE id = $1`,
      [
        id,
        error,
        usage.finishedAt ?? isoNow(),
        usage.inputTokens ?? null,
        usage.outputTokens ?? null,
        usage.cacheReadTokens ?? null,
        usage.cacheCreationTokens ?? null,
        usage.providerCalls ?? null,
      ]
    );
  }

  /** Mark all currently running runs as failed. Returns the number of rows affected. */
  async markAllRunningFailed(error: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE runs SET status = 'failed', error = $1, finished_at = now() WHERE status = 'running'`,
      [error]
    );
    return rowCount ?? 0;
  }

  /**
   * One agent's most recent run in a thread other than `excludeRunId` (the run
   * starting now, whose row the turn loop creates before it builds the
   * context). A null `excludeRunId` excludes nothing.
   */
  async getPreviousForAgent(
    threadId: string,
    agentId: string,
    excludeRunId: string | null
  ): Promise<RunRow | null> {
    return this.queryOne<RunRow>(
      `SELECT * FROM runs
        WHERE thread_id = $1 AND agent_id = $2 AND ($3::text IS NULL OR id <> $3::text)
        ORDER BY created_at DESC
        LIMIT 1`,
      [threadId, agentId, excludeRunId]
    );
  }

  /** Get the most recent run for a given thread. */
  async getLastByThread(threadId: string): Promise<RunRow | null> {
    return this.queryOne<RunRow>(
      `SELECT * FROM runs WHERE thread_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [threadId]
    );
  }

  /** All runs for a thread, oldest first. Used by turn replay for per-agent run
   *  windows (the defer-ordering rule). */
  async listByThreadId(threadId: string): Promise<RunRow[]> {
    return this.query<RunRow>(`SELECT * FROM runs WHERE thread_id = $1 ORDER BY started_at ASC`, [
      threadId,
    ]);
  }

  /**
   * Hard-delete a thread's runs. Call AgentActivityLog.deleteByThread first
   * (its run_id FK is SET NULL, not CASCADE). messages.run_id also SET-NULLs,
   * which is moot when clearing a thread — those messages are deleted too.
   * Powers the "Clear thread" action. Returns the number removed.
   */
  async deleteByThread(threadId: string): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `DELETE FROM runs WHERE thread_id = $1 RETURNING id`,
      [threadId]
    );
    return rows.length;
  }

  /**
   * Recent runs for a thread, newest first, joined with the agent's display
   * name — backs the sidebar "Runs" dropdown (each row: agent name + run id).
   *
   * LEFT JOIN because `agent_id` is SET NULL when an agent is deleted (the run
   * survives as usage history), so `agentName` is nullable and the caller must
   * render a fallback rather than assume a name.
   *
   * Ordered by `started_at DESC` to match how the user thinks about runs
   * ("the one I just kicked off" first); `id` breaks ties deterministically so
   * pagination can't repeat or skip a row when timestamps collide.
   */
  async listRecentByThread(
    threadId: string,
    limit = 50,
    agentId?: string | null
  ): Promise<
    Array<{
      id: string;
      agentId: string | null;
      agentName: string | null;
      status: string;
      startedAt: string;
      finishedAt: string | null;
    }>
  > {
    // Optional per-agent narrowing. Filtering in SQL rather than client-side
    // matters for completeness, not just bytes: with N agents sharing a busy
    // thread, one chatty agent can fill the whole LIMIT window and a quieter
    // agent's runs never appear at all. Scoping the query gives each agent its
    // own newest-N.
    const scoped = typeof agentId === 'string' && agentId.trim() !== '';
    return this.query(
      `SELECT r.id,
              r.agent_id,
              a.name AS agent_name,
              r.status,
              r.started_at,
              r.finished_at
         FROM runs r
         LEFT JOIN agents a ON a.id = r.agent_id
        WHERE r.thread_id = $1${scoped ? ' AND r.agent_id = $3' : ''}
        ORDER BY r.started_at DESC, r.id DESC
        LIMIT $2`,
      scoped ? [threadId, limit, agentId] : [threadId, limit]
    );
  }

  /**
   * (runId, threadId, agentName) triples for currently-running runs across a
   * set of threads — one batched query that backs the active-thread activity
   * markers so the caller never issues one lookup per thread. Joins agents for
   * the display name; a run whose agent row was deleted yields a null name. The
   * DB `status='running'` flag can lag a dead process, so callers must gate this
   * with the in-memory liveness signal (ActiveRunTracker): the `runId` lets the
   * caller keep only the run(s) the tracker still considers live, dropping stale
   * sibling `running` rows from crashed/reaped priors on the same thread.
   */
  async getRunningAgentNamesByThread(
    threadIds: string[]
  ): Promise<Array<{ runId: string; threadId: string; agentName: string | null }>> {
    if (threadIds.length === 0) return [];
    return this.query<{ runId: string; threadId: string; agentName: string | null }>(
      `SELECT r.id AS run_id, r.thread_id, a.name AS agent_name
         FROM runs r
         LEFT JOIN agents a ON a.id = r.agent_id
        WHERE r.thread_id = ANY($1::text[]) AND r.status = 'running'`,
      [threadIds]
    );
  }
}

export const Runs = new RunModelClass();
