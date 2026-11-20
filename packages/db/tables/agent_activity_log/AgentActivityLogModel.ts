/**
 * AgentActivityLogModel — Model class for the agent_activity_log table.
 *
 * Tracks agent actions (tool calls, messages, skips)
 * with budget and trigger metadata.
 */

import { Model } from '@snaglet/db/Model';

export interface AgentActivityLogRow {
  id: string;
  agentId: string;
  runId: string | null;
  actionType:
    | 'comment'
    | 'message_reply'
    | 'skip'
    | 'browse_web'
    | 'tool_call'
    | 'tool_discovery_failure'
    | 'thinking';
  triggerType: 'cron' | 'chat_nudge' | 'mention' | 'message_received' | 'manual';
  reason: string | null;
  /** Text payload for the step — the accumulated prose for `thinking` rows. */
  content: string | null;
  tokenEstimate: number;
  tool: string | null;
  toolInput: Record<string, unknown> | null;
  toolOutput: Record<string, unknown> | null;
  durationMs: number | null;
  createdAt: string;
}

export interface ThreadActivityLogRow extends AgentActivityLogRow {
  threadId: string;
  runStatus: string;
  runStartedAt: string;
  runFinishedAt: string | null;
  runProviderId: string | null;
  runModel: string | null;
  /**
   * Persisted run totals from the joined `runs` row, written at run end by the
   * dispatch pipeline (see runTokenMeter.ts). `runInputTokens` is the run's
   * cumulative billed input (Σ across every provider call, cache re-reads
   * included), not a context-window size. NULL = never recorded (run still in
   * flight, or an older row); 0 = recorded as zero. Exposed
   * read-only so the client can rehydrate a finished run's token counter after
   * reload.
   */
  runInputTokens: number | null;
  runOutputTokens: number | null;
  runCacheReadTokens: number | null;
  runCacheCreationTokens: number | null;
  runProviderCalls: number | null;
}

/** Row filters applied in SQL, before LIMIT, so a filter never misses rows past the limit. */
export interface ActivityRowFilter {
  actionType?: string;
  /** Matches the stored `tool` column against any of these names (canonical and alias ids). */
  tools?: string[];
}

/** Append ActivityRowFilter conditions; `values` is mutated and placeholders are numbered from its length. */
function pushActivityRowFilter(
  conditions: string[],
  values: unknown[],
  filter: ActivityRowFilter | undefined
): void {
  if (filter?.actionType) {
    values.push(filter.actionType);
    conditions.push(`a.action_type = $${values.length}`);
  }
  if (filter?.tools && filter.tools.length > 0) {
    values.push(filter.tools);
    conditions.push(`a.tool = ANY($${values.length}::text[])`);
  }
}

export interface CreateActivityLogInput {
  agentId: string;
  runId?: string;
  actionType: AgentActivityLogRow['actionType'];
  triggerType: AgentActivityLogRow['triggerType'];
  reason?: string;
  /** Text payload for the step — required for `thinking` rows. */
  content?: string;
  tokenEstimate?: number;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: Record<string, unknown>;
  durationMs?: number;
}

class AgentActivityLogModelClass extends Model<
  AgentActivityLogRow,
  CreateActivityLogInput,
  object
> {
  constructor() {
    super({
      table: 'agent_activity_log',
      primaryKey: 'id',
      updatedAtColumn: null,
    });
  }

  /** Log a new activity entry. */
  async logActivity(input: CreateActivityLogInput): Promise<AgentActivityLogRow> {
    const rows = await this.query<AgentActivityLogRow>(
      `INSERT INTO agent_activity_log
         (agent_id, run_id, action_type, trigger_type, reason, content, token_estimate, tool, tool_input, tool_output, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.agentId,
        input.runId ?? null,
        input.actionType,
        input.triggerType,
        input.reason ?? null,
        input.content ?? null,
        input.tokenEstimate ?? 0,
        input.tool ?? null,
        input.toolInput ? JSON.stringify(input.toolInput) : null,
        input.toolOutput ? JSON.stringify(input.toolOutput) : null,
        input.durationMs ?? null,
      ]
    );
    return rows[0];
  }

  /** Get all activity for a specific run, optionally scoped to its thread. */
  async getByRunId(
    runId: string,
    limit = 100,
    opts?: { threadId?: string; before?: Date } & ActivityRowFilter
  ): Promise<AgentActivityLogRow[]> {
    const conditions: string[] = ['a.run_id = $1'];
    const values: unknown[] = [runId];
    let paramIdx = 2;

    if (opts?.threadId) {
      conditions.push(
        `EXISTS (
         SELECT 1 FROM runs r
         WHERE r.id = a.run_id AND r.thread_id = $${paramIdx++}
       )`
      );
      values.push(opts.threadId);
    }

    if (opts?.before) {
      conditions.push(`a.created_at < $${paramIdx++}`);
      values.push(opts.before.toISOString());
    }

    pushActivityRowFilter(conditions, values, opts);

    values.push(limit);
    const limitParam = values.length;

    return this.query<AgentActivityLogRow>(
      `SELECT a.* FROM agent_activity_log a
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at ASC
       LIMIT $${limitParam}`,
      values
    );
  }

  /** Newest activity window for a thread, returned chronologically for replay. */
  async getByThreadId(threadId: string, limit = 5000): Promise<AgentActivityLogRow[]> {
    const rows = await this.query<AgentActivityLogRow>(
      `SELECT a.* FROM agent_activity_log a
       JOIN runs r ON r.id = a.run_id
       WHERE r.thread_id = $1
       ORDER BY a.created_at DESC
       LIMIT $2`,
      [threadId, limit]
    );
    return rows.reverse();
  }

  /**
   * Characters of tool input and output an agent logged in a thread after `afterCreatedAt` (null:
   * from the start), each row counted up to `perRowCapChars` the way replay would trim it.
   * Summary bookkeeping rows are not conversation and are left out. One aggregate query, so the
   * digest trigger can size tool-heavy work without loading the rows.
   */
  async sumToolChars(
    threadId: string,
    agentId: string,
    afterCreatedAt: string | null,
    perRowCapChars = 12_000
  ): Promise<number> {
    const rows = await this.query<{ chars: string | number | null }>(
      `SELECT COALESCE(SUM(LEAST(
                length(COALESCE(a.tool_input::text, '')) + length(COALESCE(a.tool_output::text, '')),
                $4::int)), 0) AS chars
         FROM agent_activity_log a
         JOIN runs r ON r.id = a.run_id
        WHERE r.thread_id = $1
          AND a.agent_id = $2
          AND a.action_type = 'tool_call'
          AND COALESCE(a.tool, '') NOT IN ('thread_summary', 'compaction_summary')
          AND ($3::timestamptz IS NULL OR a.created_at > $3::timestamptz)`,
      [threadId, agentId, afterCreatedAt, perRowCapChars]
    );
    return Number(rows[0]?.chars ?? 0);
  }

  /** The newest row of one tool that an agent logged in a thread, or null. */
  async getLatestByTool(
    threadId: string,
    agentId: string,
    tool: string
  ): Promise<AgentActivityLogRow | null> {
    const rows = await this.query<AgentActivityLogRow>(
      `SELECT a.* FROM agent_activity_log a
         JOIN runs r ON r.id = a.run_id
        WHERE r.thread_id = $1 AND a.agent_id = $2 AND a.tool = $3
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 1`,
      [threadId, agentId, tool]
    );
    return rows[0] ?? null;
  }

  /**
   * Hard-delete every activity row attached to a thread's runs. Must run before
   * Runs.deleteByThread — the run_id FK is ON DELETE SET NULL, so deleting runs
   * first would strand these rows as unattributable orphans instead of removing
   * them. Powers the "Clear thread" action. Returns the number removed.
   */
  async deleteByThread(threadId: string): Promise<number> {
    const rows = await this.query<{ id: string }>(
      `DELETE FROM agent_activity_log a
       USING runs r
       WHERE r.id = a.run_id AND r.thread_id = $1
       RETURNING a.id`,
      [threadId]
    );
    return rows.length;
  }

  /** Get activity for an agent's most recent N runs, optionally within a thread. */
  async getRecentRunActivity(
    agentId: string,
    opts?: {
      runCount?: number;
      limit?: number;
      threadId?: string;
      before?: Date;
    } & ActivityRowFilter
  ): Promise<AgentActivityLogRow[]> {
    const runCount = opts?.runCount ?? 1;
    const limit = opts?.limit ?? 200;
    const threadJoin = opts?.threadId ? 'JOIN runs r ON r.id = a.run_id' : '';
    const conditions = ['a.agent_id = $1', 'a.run_id IS NOT NULL'];
    const values: unknown[] = [agentId];

    if (opts?.threadId) {
      values.push(opts.threadId);
      conditions.push(`r.thread_id = $${values.length}`);
    }

    if (opts?.before) {
      values.push(opts.before.toISOString());
      conditions.push(`a.created_at < $${values.length}`);
    }

    // Filter both the run pick and the returned rows: "last N runs that called X".
    const filterConditions: string[] = [];
    pushActivityRowFilter(filterConditions, values, opts);
    conditions.push(...filterConditions);

    values.push(runCount);
    const runCountParam = values.length;
    values.push(limit);
    const limitParam = values.length;

    return this.query<AgentActivityLogRow>(
      `WITH recent_runs AS (
         SELECT a.run_id, MIN(a.created_at) AS first_activity
         FROM agent_activity_log a
         ${threadJoin}
         WHERE ${conditions.join(' AND ')}
         GROUP BY a.run_id
         ORDER BY first_activity DESC
         LIMIT $${runCountParam}
       )
       SELECT a.*
       FROM agent_activity_log a
       JOIN recent_runs r ON a.run_id = r.run_id
       ${filterConditions.length > 0 ? `WHERE ${filterConditions.join(' AND ')}` : ''}
       ORDER BY a.created_at ASC
       LIMIT $${limitParam}`,
      values
    );
  }

  /** Count activities of a given type since a date. */
  async getActivityCountByType(agentId: string, actionType: string, since: Date): Promise<number> {
    const rows = await this.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM agent_activity_log
       WHERE agent_id = $1 AND action_type = $2 AND created_at >= $3`,
      [agentId, actionType, since.toISOString()]
    );
    return parseInt(rows[0].count, 10);
  }

  /** Get the most recent activity of a given type for an agent. */
  async getLastActivityByType(
    agentId: string,
    actionType: string
  ): Promise<AgentActivityLogRow | null> {
    return this.queryOne<AgentActivityLogRow>(
      `SELECT * FROM agent_activity_log
       WHERE agent_id = $1 AND action_type = $2
       ORDER BY created_at DESC LIMIT 1`,
      [agentId, actionType]
    );
  }

  /** List recent activity, optionally filtered by agent, run, and/or thread. */
  async listRecentActivity(
    opts?: {
      agentId?: string;
      runId?: string;
      threadId?: string;
      limit?: number;
      before?: Date;
    } & ActivityRowFilter
  ): Promise<AgentActivityLogRow[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    if (opts?.agentId) {
      conditions.push(`a.agent_id = $${paramIdx++}`);
      values.push(opts.agentId);
    }

    if (opts?.runId) {
      conditions.push(`a.run_id = $${paramIdx++}`);
      values.push(opts.runId);
    }

    if (opts?.threadId) {
      conditions.push(
        `EXISTS (
          SELECT 1 FROM runs r
          WHERE r.id = a.run_id AND r.thread_id = $${paramIdx++}
        )`
      );
      values.push(opts.threadId);
    }

    if (opts?.before) {
      conditions.push(`a.created_at < $${paramIdx++}`);
      values.push(opts.before.toISOString());
    }

    pushActivityRowFilter(conditions, values, opts);

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 50;

    return this.query<AgentActivityLogRow>(
      `SELECT a.* FROM agent_activity_log a ${where}
       ORDER BY a.created_at DESC LIMIT $${values.length + 1}`,
      [...values, limit]
    );
  }

  /** List recent activity for a thread via run linkage. */
  async listThreadActivity(opts: {
    threadId: string;
    agentIds?: string[];
    limit?: number;
  }): Promise<ThreadActivityLogRow[]> {
    const conditions: string[] = ['r.thread_id = $1'];
    const values: unknown[] = [opts.threadId];
    let paramIdx = 2;

    if (opts.agentIds && opts.agentIds.length > 0) {
      conditions.push(`a.agent_id = ANY($${paramIdx++}::text[])`);
      values.push(opts.agentIds);
    }

    const limit = Math.min(Math.max(opts.limit ?? 300, 1), 300);
    values.push(limit);

    return this.query<ThreadActivityLogRow>(
      `SELECT
         a.*,
         r.thread_id,
         r.status AS run_status,
         r.started_at AS run_started_at,
         r.finished_at AS run_finished_at,
         r.provider_id AS run_provider_id,
         r.model AS run_model,
         r.input_tokens AS run_input_tokens,
         r.output_tokens AS run_output_tokens,
         r.cache_read_tokens AS run_cache_read_tokens,
         r.cache_creation_tokens AS run_cache_creation_tokens,
         r.provider_calls AS run_provider_calls
       FROM agent_activity_log a
       JOIN runs r ON r.id = a.run_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.created_at DESC
       LIMIT $${paramIdx}`,
      values
    );
  }
}

export const AgentActivityLog = new AgentActivityLogModelClass();
