/**
 * MemberModel — public.members.
 *
 * The unified principal-identity registry: one row per agent, per human user
 * and per external MCP client key, each with a stable text primary key. It is
 * the single place the agent/user split lives (kind + agent_id or user_id,
 * enforced by members_principal_match). Junction tables (e.g.
 * thread_participants) reference members.id with one NOT NULL foreign key
 * instead of a nullable agent_id/user_id pair, so a blank principal is
 * impossible downstream.
 */

import { Model } from '@snaglet/db/Model';
import type { NodeRunner } from '@snaglet/db/tables/nodes';

export type MemberKind = 'agent' | 'user' | 'external';

export interface MemberRow {
  id: string;
  kind: MemberKind;
  /** Set when kind = 'agent'; FK -> agents(id). Null for user and external members. */
  agentId: string | null;
  /**
   * Set when kind = 'user'; FK -> users(id), surfaced as a string. Null for
   * agent and external members.
   */
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

// user_id is an integer column; cast it to text so MemberRow.userId is a string
// across both DB engines (matching UserRow.id, which is also surfaced as text).
const MEMBER_COLUMNS = `id, kind, agent_id, user_id::text AS user_id, created_at, updated_at`;

class MemberModelClass extends Model<MemberRow> {
  constructor() {
    super({
      table: 'members',
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
   * Return the member row for an agent, creating it on first use. Idempotent:
   * the unique partial index on agent_id collapses concurrent inserts to one
   * row. The agent_id FK guarantees the agent actually exists.
   */
  async ensureForAgent(agentId: string, runner?: NodeRunner): Promise<MemberRow> {
    const row = await this.queryOneOn<MemberRow>(
      runner,
      `INSERT INTO public.members (kind, agent_id)
       VALUES ('agent', $1)
       ON CONFLICT (agent_id) WHERE agent_id IS NOT NULL
       DO UPDATE SET updated_at = NOW()
       RETURNING ${MEMBER_COLUMNS}`,
      [agentId]
    );
    return row!;
  }

  /**
   * Return the member row for a human user, creating it on first use. The
   * userId is passed untyped so it works whether users.id (and therefore
   * members.user_id) is text or integer — Postgres applies the assignment cast.
   */
  async ensureForUser(userId: string, runner?: NodeRunner): Promise<MemberRow> {
    const row = await this.queryOneOn<MemberRow>(
      runner,
      `INSERT INTO public.members (kind, user_id)
       VALUES ('user', $1)
       ON CONFLICT (user_id) WHERE user_id IS NOT NULL
       DO UPDATE SET updated_at = NOW()
       RETURNING ${MEMBER_COLUMNS}`,
      [userId]
    );
    return row!;
  }

  /**
   * Create a member row for an external MCP client (kind = 'external', both
   * principal columns NULL — allowed by the members CHECKs). Not idempotent by
   * design: each minted API key gets its own member so attribution stays
   * per-key. The display name lives on the key (mcp_api_keys.name), not here.
   */
  async createExternal(): Promise<MemberRow> {
    const row = await this.queryOne<MemberRow>(
      `INSERT INTO public.members (kind)
       VALUES ('external')
       RETURNING ${MEMBER_COLUMNS}`
    );
    return row!;
  }

  async findByAgent(agentId: string): Promise<MemberRow | null> {
    return this.queryOne<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM public.members WHERE agent_id = $1`,
      [agentId]
    );
  }

  async findByUser(userId: string): Promise<MemberRow | null> {
    return this.queryOne<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM public.members WHERE user_id::text = $1`,
      [userId]
    );
  }

  override async findById(id: string): Promise<MemberRow | null> {
    return this.queryOne<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM public.members WHERE id = $1`, [
      id,
    ]);
  }
}

export const Members = new MemberModelClass();
