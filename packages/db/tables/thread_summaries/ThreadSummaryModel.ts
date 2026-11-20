/**
 * ThreadSummaryModel — public.thread_summaries.
 *
 * Manages LLM-generated thread summaries used for context compression.
 * Keeps a full history of summaries per (thread, agent) pair with an
 * `is_current` flag (a unique index allows one current row per pair).
 * agent_id NULL = shared fallback. updatedAt lives on public.nodes via the
 * shared-PK FK and is surfaced via JOIN.
 */

import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { Nodes, type NodeRunner } from '../nodes';
import { NODE_KIND } from '@snaglet/shared/constants';

export interface ThreadSummaryRow {
  id: string;
  threadId: string;
  agentId: string | null;
  summaryText: string;
  messagesCovered: number;
  /**
   * Derived on read, never stored: how many messages this version folded in —
   * `messages_covered` minus the largest `messages_covered` of any earlier
   * version in the same (thread, agent) scope, clamped to >= 0.
   *
   * `messages_covered` itself is cumulative across versions (the trim service
   * depends on that meaning), so the raw column reads as a lifetime running
   * total. Using MAX over all earlier versions (not just v-1) keeps the delta
   * sane when trim repair resets an intermediate version's coverage to 0, and
   * the GREATEST(…, 0) clamp keeps a repaired current row from going negative.
   */
  messagesInWindow: number;
  lastMessageId: string | null;
  modelUsed: string | null;
  version: number;
  isCurrent: boolean;
  /**
   * Set on a fold (the summary the agent reads in place of the history it folded): where it
   * stopped, how many replay units it stands in for, the carry-forward note. Null on a digest.
   */
  compaction?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

interface ThreadSummaryRawRow {
  id: string;
  thread_id: string;
  agent_id: string | null;
  summary_text: string;
  messages_covered: number;
  messages_in_window: number;
  last_message_id: string | null;
  model_used: string | null;
  version: number;
  is_current: boolean;
  compaction: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function toThreadSummaryRow(raw: ThreadSummaryRawRow): ThreadSummaryRow {
  return {
    id: raw.id,
    threadId: raw.thread_id,
    agentId: raw.agent_id,
    summaryText: raw.summary_text,
    messagesCovered: raw.messages_covered,
    messagesInWindow: raw.messages_in_window,
    lastMessageId: raw.last_message_id,
    modelUsed: raw.model_used,
    version: raw.version,
    isCurrent: raw.is_current,
    compaction: raw.compaction ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export interface InsertThreadSummaryInput {
  id: string;
  threadId: string;
  agentId?: string | null;
  summaryText: string;
  messagesCovered: number;
  lastMessageId?: string;
  modelUsed?: string;
  /** Set when this version is a fold; see ThreadSummaryRow.compaction. */
  compaction?: Record<string, unknown> | null;
}

class ThreadSummaryModelClass extends Model<ThreadSummaryRow> {
  constructor() {
    super({
      table: 'thread_summaries',
      primaryKey: 'id',
      updatedAtColumn: null,
    });
  }

  private get summarySelect(): string {
    // `messages_in_window` is a read-time derivation (see ThreadSummaryRow doc
    // comment). A correlated subquery — not a window function — so it stays
    // correct even when the outer WHERE narrows to a single row (findByIdWithNode).
    return `
      SELECT ts.id, ts.thread_id, ts.agent_id, ts.summary_text,
             ts.messages_covered,
             GREATEST(
               ts.messages_covered - COALESCE((
                 SELECT MAX(prior.messages_covered)
                   FROM ${this.qualifiedTable} prior
                  WHERE prior.thread_id = ts.thread_id
                    AND COALESCE(prior.agent_id, '__none__') = COALESCE(ts.agent_id, '__none__')
                    AND prior.version < ts.version
               ), 0),
               0
             ) AS messages_in_window,
             ts.last_message_id, ts.model_used,
             ts.version, ts.is_current, ts.compaction,
             ts.created_at, n.updated_at
      FROM ${this.qualifiedTable} ts
      JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = ts.id
    `.trim();
  }

  /**
   * Override base Model.list so the custom projection is used.
   */
  override async list(opts?: { limit?: number; offset?: number }): Promise<ThreadSummaryRow[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const { rows } = await this.pool.query<ThreadSummaryRawRow>(
      `${this.summarySelect} ORDER BY ts.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows.map(toThreadSummaryRow);
  }

  /** Get the current summary for a specific agent in a thread. */
  async getByThreadAndAgent(threadId: string, agentId: string): Promise<ThreadSummaryRow | null> {
    const { rows } = await this.pool.query<ThreadSummaryRawRow>(
      `${this.summarySelect} WHERE ts.thread_id = $1 AND ts.agent_id = $2 AND ts.is_current = true`,
      [threadId, agentId]
    );
    return rows[0] ? toThreadSummaryRow(rows[0]) : null;
  }

  /** Get the current shared (agent_id IS NULL) summary for a thread. */
  async getByThread(threadId: string): Promise<ThreadSummaryRow | null> {
    const { rows } = await this.pool.query<ThreadSummaryRawRow>(
      `${this.summarySelect} WHERE ts.thread_id = $1 AND ts.agent_id IS NULL AND ts.is_current = true`,
      [threadId]
    );
    return rows[0] ? toThreadSummaryRow(rows[0]) : null;
  }

  /**
   * The newest fold for an agent in a thread: the latest version whose `compaction` is set. Not
   * necessarily the current row; a digest written later can be current while the fold is still
   * what the agent reads.
   */
  async getLatestCompaction(threadId: string, agentId: string): Promise<ThreadSummaryRow | null> {
    const { rows } = await this.pool.query<ThreadSummaryRawRow>(
      `${this.summarySelect} WHERE ts.thread_id = $1 AND ts.agent_id = $2 AND ts.compaction IS NOT NULL
       ORDER BY ts.version DESC LIMIT 1`,
      [threadId, agentId]
    );
    return rows[0] ? toThreadSummaryRow(rows[0]) : null;
  }

  /** Get all summaries for a thread, ordered by version (oldest first). */
  async getHistoryByThread(threadId: string): Promise<ThreadSummaryRow[]> {
    const { rows } = await this.pool.query<ThreadSummaryRawRow>(
      `${this.summarySelect} WHERE ts.thread_id = $1 ORDER BY ts.version ASC`,
      [threadId]
    );
    return rows.map(toThreadSummaryRow);
  }

  /**
   * Find one summary by id, joined to public.nodes so `createdAt` /
   * `updatedAt` come back populated. The base Model.findById would
   * skip the join and return nulls for those timestamps. Backs the
   * single-summary preview surface (WikiLinkPreviewModal).
   */
  async findByIdWithNode(id: string): Promise<ThreadSummaryRow | null> {
    const { rows } = await this.pool.query<ThreadSummaryRawRow>(
      `${this.summarySelect} WHERE ts.id = $1 LIMIT 1`,
      [id]
    );
    return rows[0] ? toThreadSummaryRow(rows[0]) : null;
  }

  /**
   * Get the full history of summaries scoped to a single (thread, agent)
   * pair, newest first. Backs the per-agent "thread summaries" panel in
   * thread settings → Agents tab. Distinct from `getHistoryByThread`
   * because that one returns every summary across all participating
   * agents; this one narrows by agent_id (and excludes the shared,
   * agent_id IS NULL summaries by design — the panel is the *agent's*
   * memory of the thread, not the shared compaction).
   */
  async getHistoryByThreadAndAgent(threadId: string, agentId: string): Promise<ThreadSummaryRow[]> {
    const { rows } = await this.pool.query<ThreadSummaryRawRow>(
      `${this.summarySelect} WHERE ts.thread_id = $1 AND ts.agent_id = $2
       ORDER BY ts.version DESC`,
      [threadId, agentId]
    );
    return rows.map(toThreadSummaryRow);
  }

  /**
   * Insert a new summary version. Sequential statements inside a transaction
   * (not a CTE chain) so the partial unique index on
   * (thread_id, COALESCE(agent_id,'__none__')) WHERE is_current=true sees
   * each prior statement's effects.
   */
  async insertNewVersion(input: InsertThreadSummaryInput): Promise<ThreadSummaryRow> {
    const agentId = input.agentId ?? null;
    const agentCondition = agentId ? 'agent_id = $2' : 'agent_id IS NULL';
    const scopeParams: unknown[] = agentId ? [input.threadId, agentId] : [input.threadId];
    const v2 = quoteIdentifier(this.schema);

    return transaction(async (client) => {
      // Serialize on the public.threads row so concurrent compacts can't race.
      await client.query(`SELECT id FROM ${v2}.threads WHERE id = $1 FOR UPDATE`, [input.threadId]);

      // Deactivate any prior current row for this (thread, agent).
      await client.query(
        `UPDATE ${this.qualifiedTable}
            SET is_current = false
          WHERE thread_id = $1 AND ${agentCondition} AND is_current = true`,
        scopeParams
      );

      const { rows: versionRows } = await client.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM ${this.qualifiedTable}
          WHERE thread_id = $1 AND ${agentCondition}`,
        scopeParams
      );
      const nextVersion = versionRows[0]?.next_version ?? 1;

      // public.thread_summaries.id FKs to public.nodes; create the node-spine row first.
      await Nodes.ensure(input.id, NODE_KIND.THREAD_SUMMARY, { runner: client });

      await client.query(
        `INSERT INTO ${this.qualifiedTable}
           (id, thread_id, agent_id, summary_text, messages_covered, last_message_id,
            model_used, version, is_current, compaction)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9::jsonb)`,
        [
          input.id,
          input.threadId,
          agentId,
          input.summaryText,
          input.messagesCovered,
          input.lastMessageId ?? null,
          input.modelUsed ?? null,
          nextVersion,
          input.compaction ? JSON.stringify(input.compaction) : null,
        ]
      );

      const { rows } = await client.query<ThreadSummaryRawRow>(
        `${this.summarySelect} WHERE ts.id = $1`,
        [input.id]
      );

      const row = rows[0];
      if (!row) {
        throw new Error(
          `ThreadSummaryModel.insertNewVersion: insert succeeded but row not visible (id=${input.id})`
        );
      }
      return toThreadSummaryRow(row);
    });
  }

  /** Delete all summaries for a thread; cascades node rows + embeddings. */
  async deleteByThread(threadId: string, runner?: NodeRunner): Promise<boolean> {
    const r = runner ?? this.pool;
    const { rows: ids } = await r.query<{ id: string }>(
      `SELECT id FROM ${this.qualifiedTable} WHERE thread_id = $1`,
      [threadId]
    );
    if (ids.length === 0) return false;
    await Nodes.deleteByIds(
      ids.map((row) => row.id),
      r
    );
    return true;
  }
}

export const ThreadSummaries = new ThreadSummaryModelClass();
