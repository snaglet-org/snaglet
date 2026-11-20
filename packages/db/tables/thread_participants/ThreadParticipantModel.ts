/**
 * ThreadParticipantModel — public.thread_participants.
 *
 * The junction between threads and principals (agents or human users). A
 * participant references one principal via member_id (NOT NULL FK ->
 * public.members); members rows are the one place the agent/user split
 * lives, so a participant can never point at a blank or absent principal.
 *
 * Reads expose agentId / userId / kind, derived by joining members; only
 * member_id is stored. Mutations resolve the member (creating it on first
 * use via Members.ensureFor*) and key off member_id or the participant row's
 * own id, never a derived principal that might be absent.
 */

import { Model } from '@snaglet/db/Model';
import { Members } from '@snaglet/db/tables/members';
import type { NodeRunner } from '@snaglet/db/tables/nodes';

export interface ThreadParticipantRow {
  id: string;
  threadId: string;
  /** FK -> members(id). The participant's stable principal identity. */
  memberId: string;
  /** 'agent' | 'user', derived from the member. */
  kind: 'agent' | 'user';
  /** Derived from the member: set for agent participants, null for users. */
  agentId: string | null;
  /** Derived from the member: set for user participants, null for agents. */
  userId: string | null;
  /** Per-participant model/provider override. Null = use agent's default. */
  credentialId: string | null;
  providerId: string | null;
  modelId: string | null;
  /** Appended to the agent's base system prompt for this thread only. */
  systemPromptAddendum: string | null;
  /** ToolAccessConfig.mode override for this agent in this thread. */
  toolAccessMode: string | null;
  /** ToolAccessConfig.allowList — only meaningful when toolAccessMode = 'allow_list'. */
  toolAccessAllowList: string[] | null;
  /** ToolAccessConfig.denyList — explicit denies win in both list modes. */
  toolAccessDenyList: string[] | null;
  /** Per-tool setting overrides (Record<toolId, ToolOverride>). */
  toolOverrides: Record<string, unknown> | null;
  /** Per-turn tool-call ceiling override for this agent in this thread. */
  maxToolCallsPerTurn: number | null;
  /** Wall-clock ceiling override for one turn, seconds. */
  maxDurationSeconds: number | null;
  /**
   * When false, this agent only wakes on explicit @mention regardless of the
   * thread's dispatch_mode. Defaults to true.
   */
  autoRespond: boolean;
  /** When true, skip the fallback model chain for this agent in this thread. */
  disableModelFallback: boolean;
  /** Unread cursor: messages from others after this are unread; null = none read yet. */
  lastReadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AddThreadParticipantInput {
  threadId: string;
  agentId: string;
  credentialId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  systemPromptAddendum?: string | null;
  toolAccessMode?: string | null;
  toolAccessAllowList?: string[] | null;
  toolAccessDenyList?: string[] | null;
  toolOverrides?: Record<string, unknown> | null;
  maxToolCallsPerTurn?: number | null;
  maxDurationSeconds?: number | null;
  autoRespond?: boolean;
}

export interface AddThreadUserParticipantInput {
  threadId: string;
  userId: string;
}

export interface UpdateThreadParticipantModelInput {
  credentialId?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  disableModelFallback?: boolean;
}

interface UpdateThreadParticipantOverridesInput {
  expectedSystemPromptAddendum?: string | null;
  systemPromptAddendum?: string | null;
  toolAccessMode?: string | null;
  toolAccessAllowList?: string[] | null;
  toolAccessDenyList?: string[] | null;
  toolOverrides?: Record<string, unknown> | null;
  maxToolCallsPerTurn?: number | null;
  maxDurationSeconds?: number | null;
  autoRespond?: boolean;
}

// Participant rows always carry their principal's identity, joined from members.
// user_id is an integer column on members; cast it to text so userId is a string.
const PARTICIPANT_COLUMNS = `tp.*, m.kind, m.agent_id, m.user_id::text AS user_id`;
const PARTICIPANT_JOIN = `public.thread_participants tp JOIN public.members m ON m.id = tp.member_id`;

class ThreadParticipantModelClass extends Model<ThreadParticipantRow> {
  constructor() {
    super({
      table: 'thread_participants',
      primaryKey: 'id',
    });
  }

  /** `queryOne`, optionally on a caller's transaction so the write joins it. */
  private async queryOneOn<T extends object>(
    runner: NodeRunner | undefined,
    sql: string,
    params: unknown[]
  ): Promise<T | null> {
    if (!runner) return this.queryOne<T>(sql, params);
    await this.ensureColumnMap();
    const { rows } = await runner.query<Record<string, unknown>>(sql, params);
    return this.transformRow<T>(rows[0]);
  }

  /**
   * Add an agent to a thread (upsert on (thread_id, member_id)).
   *
   * When the agent was not already a participant, any thread skill picks it
   * still has there are cleared in the same statement: they are leftovers
   * from an earlier membership (before removal cleaned them up) and must not
   * come back when someone later sets Add or Override. An upsert on an
   * existing participant keeps its picks. CTEs share one snapshot, so the
   * NOT EXISTS sees the table as it was before this insert.
   */
  async addParticipant(
    input: AddThreadParticipantInput,
    runner?: NodeRunner
  ): Promise<ThreadParticipantRow> {
    // Resolve (creating on first use) the agent's principal identity. The
    // members.agent_id FK guarantees the agent actually exists, so a missing or
    // blank agentId fails loudly here instead of becoming a ghost participant.
    const member = await Members.ensureForAgent(input.agentId, runner);
    const row = await this.queryOneOn<ThreadParticipantRow>(
      runner,
      `WITH upsert AS (
         INSERT INTO public.thread_participants (
           thread_id, member_id,
           credential_id, provider_id, model_id,
           system_prompt_addendum,
           tool_access_mode, tool_access_allow_list, tool_access_deny_list,
           tool_overrides, max_tool_calls_per_turn, max_duration_seconds,
           auto_respond
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, COALESCE($13, TRUE))
         ON CONFLICT (thread_id, member_id) DO UPDATE SET
           credential_id          = EXCLUDED.credential_id,
           provider_id            = EXCLUDED.provider_id,
           model_id               = EXCLUDED.model_id,
           system_prompt_addendum = EXCLUDED.system_prompt_addendum,
           tool_access_mode       = EXCLUDED.tool_access_mode,
           tool_access_allow_list = EXCLUDED.tool_access_allow_list,
           tool_access_deny_list  = EXCLUDED.tool_access_deny_list,
           tool_overrides         = EXCLUDED.tool_overrides,
           max_tool_calls_per_turn = EXCLUDED.max_tool_calls_per_turn,
           max_duration_seconds   = EXCLUDED.max_duration_seconds,
           auto_respond           = EXCLUDED.auto_respond,
           updated_at             = NOW()
         RETURNING *
       ),
       stale_picks AS (
         DELETE FROM public.agent_skill_assignments a
          WHERE a.agent_id = $14 AND a.thread_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM public.thread_participants tp
               WHERE tp.thread_id = $1 AND tp.member_id = $2)
       )
       SELECT u.*, m.kind, m.agent_id, m.user_id::text AS user_id
         FROM upsert u JOIN public.members m ON m.id = u.member_id`,
      [
        input.threadId,
        member.id,
        input.credentialId ?? null,
        input.providerId ?? null,
        input.modelId ?? null,
        input.systemPromptAddendum ?? null,
        input.toolAccessMode ?? null,
        input.toolAccessAllowList == null ? null : JSON.stringify(input.toolAccessAllowList),
        input.toolAccessDenyList == null ? null : JSON.stringify(input.toolAccessDenyList),
        input.toolOverrides == null ? null : JSON.stringify(input.toolOverrides),
        input.maxToolCallsPerTurn ?? null,
        input.maxDurationSeconds ?? null,
        input.autoRespond ?? null,
        input.agentId,
      ]
    );
    return row!;
  }

  /** Add a human user to a thread (upsert on (thread_id, member_id)). */
  async addUserParticipant(
    input: AddThreadUserParticipantInput,
    runner?: NodeRunner
  ): Promise<ThreadParticipantRow> {
    const member = await Members.ensureForUser(input.userId, runner);
    const row = await this.queryOneOn<ThreadParticipantRow>(
      runner,
      `WITH upsert AS (
         INSERT INTO public.thread_participants (thread_id, member_id)
         VALUES ($1, $2)
         ON CONFLICT (thread_id, member_id) DO UPDATE SET
           updated_at = NOW()
         RETURNING *
       )
       SELECT u.*, m.kind, m.agent_id, m.user_id::text AS user_id
         FROM upsert u JOIN public.members m ON m.id = u.member_id`,
      [input.threadId, member.id]
    );
    return row!;
  }

  /**
   * Move the member's read cursor in a thread forward to `at` (default: the
   * database's now(), the clock `messages.created_at` is written with). It
   * never moves back: a stale or out-of-order mark keeps the later cursor.
   */
  async markRead(threadId: string, memberId: string, at?: Date): Promise<void> {
    await this.query(
      `UPDATE public.thread_participants
          SET last_read_at = GREATEST(
                COALESCE(last_read_at, '-infinity'::timestamptz),
                COALESCE($3::timestamptz, now()))
        WHERE thread_id = $1 AND member_id = $2`,
      [threadId, memberId, at ?? null]
    );
  }

  /** Update per-participant overrides for this agent in this thread. */
  async updateOverrides(
    threadId: string,
    agentId: string,
    input: UpdateThreadParticipantOverridesInput
  ): Promise<ThreadParticipantRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.systemPromptAddendum !== undefined) {
      values.push(input.systemPromptAddendum);
      fields.push(`system_prompt_addendum = $${values.length}`);
    }
    if (input.toolAccessMode !== undefined) {
      values.push(input.toolAccessMode);
      fields.push(`tool_access_mode = $${values.length}`);
    }
    if (input.toolAccessAllowList !== undefined) {
      values.push(
        input.toolAccessAllowList === null ? null : JSON.stringify(input.toolAccessAllowList)
      );
      fields.push(`tool_access_allow_list = $${values.length}::jsonb`);
    }
    if (input.toolAccessDenyList !== undefined) {
      values.push(
        input.toolAccessDenyList === null ? null : JSON.stringify(input.toolAccessDenyList)
      );
      fields.push(`tool_access_deny_list = $${values.length}::jsonb`);
    }
    if (input.toolOverrides !== undefined) {
      values.push(input.toolOverrides === null ? null : JSON.stringify(input.toolOverrides));
      fields.push(`tool_overrides = $${values.length}::jsonb`);
    }
    if (input.maxToolCallsPerTurn !== undefined) {
      values.push(input.maxToolCallsPerTurn);
      fields.push(`max_tool_calls_per_turn = $${values.length}`);
    }
    if (input.maxDurationSeconds !== undefined) {
      values.push(input.maxDurationSeconds);
      fields.push(`max_duration_seconds = $${values.length}`);
    }
    if (input.autoRespond !== undefined) {
      values.push(input.autoRespond);
      fields.push(`auto_respond = $${values.length}`);
    }

    if (fields.length === 0) return null;

    let expectedCondition = '';
    if (input.expectedSystemPromptAddendum !== undefined) {
      values.push(input.expectedSystemPromptAddendum);
      expectedCondition = `AND tp.system_prompt_addendum IS NOT DISTINCT FROM $${values.length}::text`;
    }
    values.push(threadId, agentId);
    return this.queryOne<ThreadParticipantRow>(
      `UPDATE public.thread_participants tp
          SET ${fields.join(', ')}, updated_at = NOW()
         FROM public.members m
        WHERE m.id = tp.member_id
          AND tp.thread_id = $${values.length - 1}
          AND m.agent_id = $${values.length}
          ${expectedCondition}
       RETURNING tp.*, m.kind, m.agent_id, m.user_id::text AS user_id`,
      values
    );
  }

  /**
   * Atomically materialize an allow-list override and append one tool. Existing
   * thread edits win over the issuance-time fallback, while the fallback deny
   * rules are copied when this is the first thread-specific access override.
   */
  async grantToolAccess(
    threadId: string,
    agentId: string,
    toolId: string,
    fallbackAllowList: string[],
    fallbackDenyList: string[]
  ): Promise<ThreadParticipantRow | null> {
    return this.queryOne<ThreadParticipantRow>(
      `WITH target AS (
         SELECT tp.id,
                CASE
                  WHEN tp.tool_access_mode = 'allow_list'
                   AND jsonb_typeof(tp.tool_access_allow_list) = 'array'
                    THEN tp.tool_access_allow_list
                  ELSE $4::jsonb
                END AS allow_list,
                CASE
                  WHEN jsonb_typeof(tp.tool_access_deny_list) = 'array'
                    THEN tp.tool_access_deny_list
                  ELSE $5::jsonb
                END AS deny_list
           FROM public.thread_participants tp
           JOIN public.members m ON m.id = tp.member_id
          WHERE tp.thread_id = $1 AND m.agent_id = $2
          FOR UPDATE OF tp
       ), updated AS (
         UPDATE public.thread_participants tp
            SET tool_access_mode = 'allow_list',
                tool_access_allow_list =
                  CASE
                    WHEN target.allow_list @> to_jsonb(ARRAY[$3]::text[])
                      THEN target.allow_list
                    ELSE target.allow_list || to_jsonb(ARRAY[$3]::text[])
                  END,
                tool_access_deny_list = target.deny_list,
                updated_at = NOW()
           FROM target
          WHERE tp.id = target.id
      RETURNING tp.*
       )
       SELECT u.*, m.kind, m.agent_id, m.user_id::text AS user_id
         FROM updated u
         JOIN public.members m ON m.id = u.member_id`,
      [
        threadId,
        agentId,
        toolId,
        JSON.stringify(fallbackAllowList),
        JSON.stringify(fallbackDenyList),
      ]
    );
  }

  /**
   * Atomically append text to one agent's thread-specific system-prompt
   * addendum. The concat happens in-SQL to avoid a read-then-write race;
   * when the existing addendum is NULL the appended text becomes the whole
   * value (no leading separator). Returns null when the agent is not in
   * the thread.
   */
  async appendSystemPromptAddendum(
    threadId: string,
    agentId: string,
    text: string
  ): Promise<ThreadParticipantRow | null> {
    return this.queryOne<ThreadParticipantRow>(
      `UPDATE public.thread_participants tp
          SET system_prompt_addendum =
                CASE
                  WHEN tp.system_prompt_addendum IS NULL OR tp.system_prompt_addendum = ''
                    THEN $3
                  ELSE tp.system_prompt_addendum || $3
                END,
              updated_at = NOW()
         FROM public.members m
        WHERE m.id = tp.member_id
          AND tp.thread_id = $1 AND m.agent_id = $2
        RETURNING tp.*, m.kind, m.agent_id, m.user_id::text AS user_id`,
      [threadId, agentId, text]
    );
  }

  /**
   * True when the agent is currently a participant of the thread. Cheap
   * membership predicate (SELECT 1 … LIMIT 1) used at message-post time to
   * mute an in-flight run whose agent was removed mid-run: a removed agent is
   * no longer a participant, so its utterances are dropped instead of posting.
   */
  async isAgentParticipant(threadId: string, agentId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1
         FROM ${PARTICIPANT_JOIN}
        WHERE tp.thread_id = $1 AND m.agent_id = $2
        LIMIT 1`,
      [threadId, agentId]
    );
    return (rowCount ?? 0) > 0;
  }

  /** List all participants in a thread. */
  async listByThread(threadId: string): Promise<ThreadParticipantRow[]> {
    return this.query<ThreadParticipantRow>(
      `SELECT ${PARTICIPANT_COLUMNS}
         FROM ${PARTICIPANT_JOIN}
        WHERE tp.thread_id = $1
        ORDER BY tp.created_at ASC, tp.id ASC`,
      [threadId]
    );
  }

  /** List all threads an agent participates in. */
  async listByAgent(agentId: string): Promise<ThreadParticipantRow[]> {
    return this.query<ThreadParticipantRow>(
      `SELECT ${PARTICIPANT_COLUMNS}
         FROM ${PARTICIPANT_JOIN}
        WHERE m.agent_id = $1
        ORDER BY tp.created_at DESC`,
      [agentId]
    );
  }

  /**
   * Remove an agent from a thread. Its skill picks for this thread go in the
   * same statement, so a later re-add starts with none.
   */
  async removeParticipant(threadId: string, agentId: string): Promise<boolean> {
    const row = await this.queryOne<{ removed: number }>(
      `WITH gone AS (
         DELETE FROM public.thread_participants tp
          USING public.members m
          WHERE m.id = tp.member_id
            AND tp.thread_id = $1
            AND m.agent_id = $2
         RETURNING tp.id
       ),
       picks AS (
         DELETE FROM public.agent_skill_assignments a
          WHERE a.agent_id = $2 AND a.thread_id = $1
            AND EXISTS (SELECT 1 FROM gone)
       )
       SELECT count(*)::int AS removed FROM gone`,
      [threadId, agentId]
    );
    return (row?.removed ?? 0) > 0;
  }

  /**
   * Remove an agent from every thread it is in, with its skill picks for
   * those threads (a retired subagent helper leaves no participant row
   * behind). `runner` keeps it inside the caller's transaction. Returns how
   * many participant rows went.
   */
  async removeAgentFromAllThreads(agentId: string, runner?: NodeRunner): Promise<number> {
    const { rows } = await (runner ?? this.pool).query<{ removed: number }>(
      `WITH gone AS (
         DELETE FROM public.thread_participants tp
          USING public.members m
          WHERE m.id = tp.member_id AND m.agent_id = $1
         RETURNING tp.thread_id
       ),
       picks AS (
         DELETE FROM public.agent_skill_assignments a
          USING gone g
          WHERE a.agent_id = $1 AND a.thread_id = g.thread_id
       )
       SELECT count(*)::int AS removed FROM gone`,
      [agentId]
    );
    return rows[0]?.removed ?? 0;
  }

  /**
   * Remove a participant by its own primary key. This is the robust removal
   * path: it targets the row directly and never depends on resolving a
   * principal, so a participant is always removable once it is listed.
   */
  async removeById(participantId: string): Promise<boolean> {
    // An agent participant's skill picks for this thread go in the same
    // statement (a human member has no agent_id, so nothing matches).
    const row = await this.queryOne<{ removed: number }>(
      `WITH gone AS (
         DELETE FROM public.thread_participants WHERE id = $1
         RETURNING thread_id, member_id
       ),
       picks AS (
         DELETE FROM public.agent_skill_assignments a
          USING gone g JOIN public.members m ON m.id = g.member_id
          WHERE a.agent_id = m.agent_id AND a.thread_id = g.thread_id
       )
       SELECT count(*)::int AS removed FROM gone`,
      [participantId]
    );
    return (row?.removed ?? 0) > 0;
  }

  /** Update per-participant model override for a thread member. */
  async updateModel(
    threadId: string,
    agentId: string,
    input: UpdateThreadParticipantModelInput
  ): Promise<ThreadParticipantRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.credentialId !== undefined) {
      values.push(input.credentialId);
      fields.push(`credential_id = $${values.length}`);
    }
    if (input.providerId !== undefined) {
      values.push(input.providerId);
      fields.push(`provider_id = $${values.length}`);
    }
    if (input.modelId !== undefined) {
      values.push(input.modelId);
      fields.push(`model_id = $${values.length}`);
    }
    if (input.disableModelFallback !== undefined) {
      values.push(input.disableModelFallback);
      fields.push(`disable_model_fallback = $${values.length}`);
    }

    if (fields.length === 0) return null;

    values.push(threadId, agentId);
    return this.queryOne<ThreadParticipantRow>(
      `UPDATE public.thread_participants tp
          SET ${fields.join(', ')}, updated_at = NOW()
         FROM public.members m
        WHERE m.id = tp.member_id
          AND tp.thread_id = $${values.length - 1}
          AND m.agent_id = $${values.length}
       RETURNING tp.*, m.kind, m.agent_id, m.user_id::text AS user_id`,
      values
    );
  }
}

export const ThreadParticipants = new ThreadParticipantModelClass();
