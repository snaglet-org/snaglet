/**
 * AgentModel — public.agents. Agents are actors, not nodes: agents.id does
 * not FK to public.nodes and this model never joins nodes.
 *
 * Archiving: listings (`list`) hide archived agents unless `includeArchived`
 * is set; per-id and per-name lookups still return them, so dispatch can skip
 * an archived participant and attribution can still name it.
 *
 * Permanent delete (`purge()`): deletes the agent's memories and thread
 * summaries, repoints every kept reference (messages, runs, activity log,
 * settings, attribution) to the system agent `ghost`, stamping the original
 * name into repointed messages, then deletes the agent and member rows. Ghost
 * is hidden from listings, resolvable by lookups, and cannot be deleted
 * (guarded here, in the service and by a DB trigger).
 */

import { Model } from '@snaglet/db/Model';
import { transaction, type DbQueryable } from '@snaglet/db/db';
import { TableReferences, type ClearedItemLinks } from '@snaglet/db/tables/table_references';
import { GHOST_AGENT_ID, GHOST_AGENT_NAME, GHOST_MEMBER_ID } from '@snaglet/shared/constants';

/** The transaction runner handed to a `transaction()` callback (the adapter-
 *  agnostic DbClient), derived from the helper's signature so no extra import
 *  of the DbClient type is needed. */
type AgentTx = Parameters<Parameters<typeof transaction>[0]>[0];

export interface AgentRow {
  id: string;
  name: string;
  role: string | null;
  avatarUrl: string | null;
  systemPrompt: string | null;
  identity: string | null;
  modelId: string | null;
  providerId: string | null;
  credentialId: string | null;
  toolAccessMode: string | null;
  toolAccessAllowList: string[] | null;
  toolAccessDenyList: string[] | null;
  /**
   * Opt-in strict advertisement. Only meaningful when toolAccessMode is
   * 'allow_list': the advertised catalog becomes exactly the allow list ∩
   * reachable tools, plus the `tool` discovery rider
   * (excluded if access-gated for the agent). Inert in other modes. Trims
   * advertisement only — callability and ask-escalation are unchanged.
   */
  toolAccessAdvertiseAllowedOnly: boolean;
  toolOverrides: Record<string, unknown> | null;
  /**
   * Agent-scoped confirmation bypass. When true, permitted native and
   * MCP tool calls run without the approval prompt — the MCP server's
   * confirmation default and agent-level per-tool flags are skipped; an
   * explicit thread-level `requiresConfirmation` still wins. Never widens
   * access.
   */
  trustedToolCalls: boolean;
  /** Enabled MCP server ids for this agent (per-agent enablement layer). */
  mcpServers: string[] | null;
  /** Per-turn tool-call ceiling for this agent. Null = global default. */
  maxToolCallsPerTurn: number | null;
  /** Wall-clock ceiling for one of this agent's turns, seconds. Null = no limit. */
  maxDurationSeconds: number | null;
  fallbacks: Array<Record<string, unknown>> | null;
  disableModelFallback: boolean;
  /** Per-agent TTS voice id for voice mode; null → code-level default. */
  voice: string | null;
  /** Agent cursor flower id; null → per-agent default. */
  cursorFlower: string | null;
  /** Agent cursor #rrggbb tint; null → the flower's default color. */
  cursorColor: string | null;
  /** Generated flower avatar spec; null → derived from the agent id in code. */
  cursorSpec: Record<string, unknown> | null;
  /** From public.agents.created_at. */
  createdAt: string;
  /** From public.agents.updated_at. */
  updatedAt: string | null;
  /** Soft-archive state. Listings exclude archived by default; per-id
   *  lookups still surface it so dispatch can skip an archived participant
   *  and attribution can resolve an archived author. */
  archived: boolean;
  archivedAt: string | null;
  /** Unused: no code writes it, so it is always null. Deleted agents are
   *  removed for real (see `purge`). */
  deletedAt: string | null;
  /**
   * Set on a subagent helper: the orchestrator that started it. Helpers
   * are excluded from every listing and from name lookups; per-id lookups
   * still resolve them so dispatch and attribution work. A cleaned-up helper
   * is archived, never purged, so its runs keep their author.
   */
  parentAgentId: string | null;
  /** Whether this agent takes part in DMs. Default true. */
  dmEnabled: boolean;
}

/** Outcome of a permanent `purge()` (the ghost repoint). Counts the private
 *  data deleted (memories, thread summaries) and the kept references
 *  repointed to ghost (messages, runs). `originalName` is the
 *  deleted agent's name (stamped into repointed messages' metadata). `null` from
 *  purge() means the agent did not exist (idempotent no-op → route 404). */
export interface AgentPurgeResult {
  originalName: string;
  deletedMemories: number;
  deletedSummaries: number;
  repointedMessages: number;
  repointedRuns: number;
  /**
   * Visible Database entries whose agent relation links to it were cleared
   * (a new agent may take its slug), per table, for realtime reloads.
   */
  clearedTableLinks: ClearedItemLinks[];
}

export interface CreateAgentInput {
  id: string;
  name: string;
  role?: string | null;
  avatarUrl?: string | null;
  systemPrompt?: string | null;
  identity?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  credentialId?: string | null;
  toolAccessMode?: string | null;
  toolAccessAllowList?: string[] | null;
  toolAccessDenyList?: string[] | null;
  toolAccessAdvertiseAllowedOnly?: boolean;
  toolOverrides?: Record<string, unknown> | null;
  trustedToolCalls?: boolean;
  mcpServers?: string[] | null;
  maxToolCallsPerTurn?: number | null;
  maxDurationSeconds?: number | null;
  fallbacks?: Array<Record<string, unknown>> | null;
  disableModelFallback?: boolean;
  voice?: string | null;
  cursorFlower?: string | null;
  cursorColor?: string | null;
  cursorSpec?: Record<string, unknown> | null;
  /** Subagent helpers only. */
  parentAgentId?: string | null;
}

export interface UpdateAgentInput {
  name?: string;
  role?: string | null;
  avatarUrl?: string | null;
  systemPrompt?: string | null;
  identity?: string | null;
  modelId?: string | null;
  providerId?: string | null;
  credentialId?: string | null;
  toolAccessMode?: string | null;
  toolAccessAllowList?: string[] | null;
  toolAccessDenyList?: string[] | null;
  toolAccessAdvertiseAllowedOnly?: boolean;
  toolOverrides?: Record<string, unknown> | null;
  trustedToolCalls?: boolean;
  mcpServers?: string[] | null;
  maxToolCallsPerTurn?: number | null;
  maxDurationSeconds?: number | null;
  fallbacks?: Array<Record<string, unknown>> | null;
  disableModelFallback?: boolean;
  voice?: string | null;
  cursorFlower?: string | null;
  cursorColor?: string | null;
  cursorSpec?: Record<string, unknown> | null;
  dmEnabled?: boolean;
}

class AgentModelClass extends Model<AgentRow, CreateAgentInput, UpdateAgentInput> {
  constructor() {
    super({
      table: 'agents',
      updatedAtColumn: 'updated_at',
      columnMap: {
        avatarUrl: 'avatar_url',
        systemPrompt: 'system_prompt',
        modelId: 'model_id',
        providerId: 'provider_id',
        credentialId: 'credential_id',
        toolAccessMode: 'tool_access_mode',
        toolAccessAllowList: 'tool_access_allow_list',
        toolAccessDenyList: 'tool_access_deny_list',
        toolAccessAdvertiseAllowedOnly: 'tool_access_advertise_allowed_only',
        toolOverrides: 'tool_overrides',
        trustedToolCalls: 'trusted_tool_calls',
        mcpServers: 'mcp_servers',
        maxToolCallsPerTurn: 'max_tool_calls_per_turn',
        maxDurationSeconds: 'max_duration_seconds',
        disableModelFallback: 'disable_model_fallback',
        cursorFlower: 'cursor_flower',
        cursorColor: 'cursor_color',
        cursorSpec: 'cursor_spec',
        parentAgentId: 'parent_agent_id',
        dmEnabled: 'dm_enabled',
      },
    });
  }

  private get agentSelect(): string {
    // No JOIN to public.nodes: agents are actors, not nodes. This SELECT does
    // not filter archived rows; callers decide: `list()` filters by default,
    // per-id/name lookups keep archived rows.
    return `
      SELECT
        a.id,
        a.name,
        a.role,
        a.avatar_url              AS "avatarUrl",
        a.system_prompt           AS "systemPrompt",
        a.identity,
        a.model_id                AS "modelId",
        a.provider_id             AS "providerId",
        a.credential_id           AS "credentialId",
        a.tool_access_mode        AS "toolAccessMode",
        a.tool_access_allow_list  AS "toolAccessAllowList",
        a.tool_access_deny_list   AS "toolAccessDenyList",
        a.tool_access_advertise_allowed_only AS "toolAccessAdvertiseAllowedOnly",
        a.tool_overrides          AS "toolOverrides",
        a.trusted_tool_calls      AS "trustedToolCalls",
        a.mcp_servers             AS "mcpServers",
        a.max_tool_calls_per_turn AS "maxToolCallsPerTurn",
        a.max_duration_seconds    AS "maxDurationSeconds",
        a.fallbacks,
        a.disable_model_fallback  AS "disableModelFallback",
        a.voice,
        a.cursor_flower           AS "cursorFlower",
        a.cursor_color            AS "cursorColor",
        a.cursor_spec             AS "cursorSpec",
        a.created_at              AS "createdAt",
        a.updated_at              AS "updatedAt",
        a.archived,
        a.archived_at             AS "archivedAt",
        a.deleted_at              AS "deletedAt",
        a.parent_agent_id         AS "parentAgentId",
        a.dm_enabled              AS "dmEnabled"
      FROM ${this.qualifiedTable} a
    `.trim();
  }

  override async findById(id: string): Promise<AgentRow | null> {
    const { rows } = await this.pool.query(`${this.agentSelect} WHERE a.id = $1`, [id]);
    return (rows[0] as AgentRow) ?? null;
  }

  /**
   * Atomically add one tool id to the agent's allow-list without lost updates.
   * Returns the revision this write set (read the row with findById), or null
   * when no such agent.
   */
  async appendToolAccessAllowList(
    id: string,
    toolId: string
  ): Promise<{ id: string; updatedAt: string } | null> {
    return this.queryOne<{ id: string; updatedAt: string }>(
      `UPDATE public.agents a
          SET tool_access_allow_list =
                CASE
                  WHEN COALESCE(a.tool_access_allow_list, '[]'::jsonb)
                       @> to_jsonb(ARRAY[$2]::text[])
                    THEN COALESCE(a.tool_access_allow_list, '[]'::jsonb)
                  ELSE COALESCE(a.tool_access_allow_list, '[]'::jsonb)
                       || to_jsonb(ARRAY[$2]::text[])
                END,
              updated_at = NOW()
        WHERE a.id = $1
      RETURNING a.id, a.updated_at AS "updatedAt"`,
      [id, toolId]
    );
  }

  async findByIds(ids: string[]): Promise<AgentRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query(`${this.agentSelect} WHERE a.id = ANY($1)`, [ids]);
    return rows as AgentRow[];
  }

  async findByName(name: string): Promise<AgentRow | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const { rows } = await this.pool.query(
      // Subagent helpers may share a real agent's name; a name always
      // means the real agent.
      `${this.agentSelect} WHERE LOWER(a.name) = LOWER($1) AND a.parent_agent_id IS NULL LIMIT 1`,
      [trimmed]
    );
    return (rows[0] as AgentRow) ?? null;
  }

  override async list(opts?: {
    limit?: number;
    offset?: number;
    includeArchived?: boolean;
  }): Promise<AgentRow[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    // Archived agents are excluded by default; pass `includeArchived` to
    // surface them (the archive and restore surfaces, and any probe that must
    // count every agent).
    //
    // Ghost is always excluded, even with includeArchived: rosters, pickers,
    // palette, dispatch and the default-seed count (ensureDefaults) all flow
    // through here and must never see the system attribution actor. It stays
    // resolvable via the per-id / per-name lookups.
    //
    // Subagent helpers are excluded the same way: they live inside one parent
    // thread and are reached only through it.
    const conds: string[] = ['a.id <> $3', 'a.parent_agent_id IS NULL'];
    if (!opts?.includeArchived) conds.push('a.archived = false');
    const { rows } = await this.pool.query(
      `${this.agentSelect} WHERE ${conds.join(' AND ')} ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset, GHOST_AGENT_ID]
    );
    return rows as AgentRow[];
  }

  /**
   * List only archived agents, most-recently-archived first. Backs the
   * ArchivedDrawer's agent rows (GET /api/archive). Uses the
   * idx_agents_archived_at partial index.
   *
   * Ghost is excluded defensively: it is never archived, but the explicit
   * `a.id <> ghost` guard keeps it out of the drawer even if its flag flipped.
   */
  async listArchived(): Promise<AgentRow[]> {
    const { rows } = await this.pool.query(
      `${this.agentSelect} WHERE a.archived = true AND a.id <> $1 AND a.parent_agent_id IS NULL ORDER BY a.archived_at DESC`,
      [GHOST_AGENT_ID]
    );
    return rows as AgentRow[];
  }

  /**
   * Soft-archive an agent: archived=true + archived_at=now(). Idempotent — a
   * re-archive keeps the original archived_at (COALESCE). Touches nothing else:
   * messages, runs, memories, and thread_participants rows are all
   * preserved, so history and attribution stay intact. Returns the updated row,
   * or null if no such agent. Mirrors the nodes archive UPDATE (no updated_at
   * bump — archiving is a lifecycle flag, not a config edit).
   */
  async archive(id: string): Promise<AgentRow | null> {
    const res = await this.pool.query(
      `UPDATE ${this.qualifiedTable}
          SET archived = true, archived_at = COALESCE(archived_at, NOW())
        WHERE id = $1`,
      [id]
    );
    if (res.rowCount === 0) return null;
    return this.findById(id);
  }

  /**
   * Restore a soft-archived agent: archived=false + archived_at=NULL. Idempotent
   * on an already-live agent. Returns the updated row, or null if no such agent.
   */
  async restore(id: string): Promise<AgentRow | null> {
    const res = await this.pool.query(
      `UPDATE ${this.qualifiedTable}
          SET archived = false, archived_at = NULL
        WHERE id = $1`,
      [id]
    );
    if (res.rowCount === 0) return null;
    return this.findById(id);
  }

  /**
   * Seed / repair the ghost agent + its member inside a transaction, returning
   * ghost's member id. Idempotent (ON CONFLICT DO NOTHING). seeds/ghost-agent.sql
   * is the canonical seed; this defensive upsert guarantees a repoint target can
   * never be missing (e.g. immediately after a clean-slate reset, before the
   * seed replay). The member id is looked up (not assumed) in case a prior
   * `ensureForAgent` created ghost's member with a different id.
   */
  private async ensureGhost(tx: AgentTx): Promise<string> {
    await tx.query(
      `INSERT INTO ${this.qualifiedTable} (id, name, role)
       VALUES ($1, $2, 'System') ON CONFLICT DO NOTHING`,
      [GHOST_AGENT_ID, GHOST_AGENT_NAME]
    );
    await tx.query(
      `INSERT INTO public.members (id, kind, agent_id)
       VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING`,
      [GHOST_MEMBER_ID, GHOST_AGENT_ID]
    );
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM public.members WHERE agent_id = $1`,
      [GHOST_AGENT_ID]
    );
    return rows[0]?.id ?? GHOST_MEMBER_ID;
  }

  /**
   * Permanently delete an agent, repointing its history to ghost.
   * Transactional, idempotent, and FOR UPDATE-serialized so a concurrent
   * second delete sees no row and no-ops.
   *
   * 1. Deletes the agent's memories and thread summaries via their `nodes`
   *    spine (node, row and embeddings all go).
   * 2. Repoints every kept reference to ghost so history never goes
   *    authorless:
   *      agents(id)  → ghost: messages (+ originalAgentName stamp), runs,
   *                    agent_activity_log, settings.updated_by_agent_id.
   *      members(id) → ghost's member: containers/docs created_by and
   *                    last_edited_by, placement_events.moved_by, and the
   *                    non-FK docs.assigned_to and doc_snapshots.created_by.
   * 3. Deletes the member row (cascading thread_participants and
   *    mcp_api_keys), then the agent row (cascading socket_sessions; its peer
   *    id is also removed from other live sessions). Every kept reference
   *    already points at ghost, so nothing is nulled or lost.
   *
   * Returns the counts and original name, or null if the agent does not
   * exist (the route reports 404). Throws if `id` is ghost, which is
   * undeletable (also checked in routes, the service, and a BEFORE DELETE
   * trigger).
   */
  async purge(id: string): Promise<AgentPurgeResult | null> {
    if (id === GHOST_AGENT_ID) {
      throw new Error('The ghost system agent is permanent and cannot be deleted');
    }
    return transaction(async (tx) => {
      // Lock the target row; FOR UPDATE serializes concurrent deletes so the
      // loser re-reads no row and no-ops (idempotent 404). The row is deleted
      // for real, so a second delete simply finds nothing.
      const existing = await tx.query<{ id: string; name: string }>(
        `SELECT id, name FROM ${this.qualifiedTable} WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (existing.rows.length === 0) return null; // no such agent
      const originalName = existing.rows[0].name;

      // Ensure the repoint target exists (seeded by seeds/ghost-agent.sql; defensive here).
      const ghostMemberId = await this.ensureGhost(tx);
      const billMemberRes = await tx.query<{ id: string }>(
        `SELECT id FROM public.members WHERE agent_id = $1`,
        [id]
      );
      const billMemberId = billMemberRes.rows[0]?.id ?? null;

      // Repoint kept agents(id) references → ghost.
      // Messages: stamp the original author name into metadata first (only
      // where not already stamped) so the name survives; then repoint
      // agent_id to ghost.
      await tx.query(
        `UPDATE public.messages
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                                     '{originalAgentName}', to_jsonb($2::text), true)
          WHERE agent_id = $1
            AND (metadata ->> 'originalAgentName') IS NULL`,
        [id, originalName]
      );
      const msgRes = await tx.query(
        `UPDATE public.messages SET agent_id = $2 WHERE agent_id = $1`,
        [id, GHOST_AGENT_ID]
      );
      const runRes = await tx.query(`UPDATE public.runs SET agent_id = $2 WHERE agent_id = $1`, [
        id,
        GHOST_AGENT_ID,
      ]);
      await tx.query(`UPDATE public.agent_activity_log SET agent_id = $2 WHERE agent_id = $1`, [
        id,
        GHOST_AGENT_ID,
      ]);
      await tx.query(
        `UPDATE public.settings SET updated_by_agent_id = $2 WHERE updated_by_agent_id = $1`,
        [id, GHOST_AGENT_ID]
      );
      // Non-FK live-session peer arrays: drop the deleted id (ephemeral; ghost
      // never joins a session, so it is not added).
      await tx.query(
        `UPDATE public.socket_sessions
            SET participant_agent_ids = array_remove(participant_agent_ids, $1)
          WHERE $1 = ANY(participant_agent_ids)`,
        [id]
      );

      // Repoint kept members(id) references → ghost's member.
      if (billMemberId && billMemberId !== ghostMemberId) {
        const memberRepoints: ReadonlyArray<readonly [string, string]> = [
          ['public.containers', 'created_by'],
          ['public.containers', 'last_edited_by'],
          ['public.docs', 'created_by'],
          ['public.docs', 'last_edited_by'],
          ['public.placement_events', 'moved_by'],
          // Non-FK member-id columns — best-effort (no match ⇒ harmless no-op).
          ['public.docs', 'assigned_to'],
          ['public.doc_snapshots', 'created_by'],
        ];
        for (const [table, col] of memberRepoints) {
          await tx.query(`UPDATE ${table} SET ${col} = $2 WHERE ${col} = $1`, [
            billMemberId,
            ghostMemberId,
          ]);
        }
      }

      // Delete the private data.
      const memRes = await tx.query(
        `DELETE FROM public.nodes
          WHERE id IN (SELECT id FROM public.memories WHERE agent_id = $1)`,
        [id]
      );
      const sumRes = await tx.query(
        `DELETE FROM public.nodes
          WHERE id IN (SELECT id FROM public.thread_summaries WHERE agent_id = $1)`,
        [id]
      );

      // Clear Database links to it.
      // Agent relations in custom tables hold the id without a foreign key; a
      // later agent with the same name would take the same slug and inherit them.
      const clearedTableLinks = await TableReferences.clearAgentLinks(id, tx);

      // Delete the agent's own principal rows.
      // Member first: cascades thread_participants (live roster state) and its
      // mcp_api_keys (revoked credentials). Then the agent row: cascades its
      // socket_sessions (ephemeral). All kept refs already point at ghost.
      if (billMemberId && billMemberId !== ghostMemberId) {
        await tx.query(`DELETE FROM public.members WHERE id = $1`, [billMemberId]);
      }
      await tx.query(`DELETE FROM ${this.qualifiedTable} WHERE id = $1`, [id]);

      return {
        originalName,
        deletedMemories: memRes.rowCount ?? 0,
        deletedSummaries: sumRes.rowCount ?? 0,
        repointedMessages: msgRes.rowCount ?? 0,
        repointedRuns: runRes.rowCount ?? 0,
        clearedTableLinks,
      };
    });
  }

  override async create(input: CreateAgentInput): Promise<AgentRow> {
    // Agents are not nodes: no Nodes.ensure. The row stands alone.
    // Load the column map first so mapInput recognizes jsonb columns; otherwise
    // array-valued jsonb fields (mcp_servers, tool_access_*_list) get serialized
    // as Postgres array literals — an empty [] lands as {} and a non-empty array
    // is invalid jsonb. The base create() and our update() both do this.
    await this.ensureColumnMap();
    const { columns, values, placeholders } = this.mapInput(input);
    await this.pool.query(
      `INSERT INTO ${this.qualifiedTable} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );
    // Every agent is a workspace member from birth, so member pickers (a
    // Database `member` relation, for instance) list it before it has ever
    // joined a thread. Idempotent with Members.ensureForAgent's upsert.
    await this.pool.query(
      `INSERT INTO public.members (kind, agent_id) VALUES ('agent', $1)
       ON CONFLICT (agent_id) WHERE agent_id IS NOT NULL DO NOTHING`,
      [input.id]
    );
    const created = await this.findById(input.id);
    if (!created) throw new Error(`Failed to create agent: ${input.id}`);
    return created;
  }

  override async update(id: string, input: UpdateAgentInput): Promise<AgentRow | null> {
    await this.ensureColumnMap();
    const { columns, values } = this.mapInput(input);
    if (columns.length === 0) return this.findById(id);

    const setClauses = columns.map((col, i) => `${col} = $${i + 1}`);
    setClauses.push('updated_at = NOW()');
    values.push(id);

    const res = await this.pool.query<{ updatedAt: string }>(
      `UPDATE ${this.qualifiedTable} SET ${setClauses.join(', ')} WHERE id = $${values.length}
       RETURNING updated_at AS "updatedAt"`,
      values
    );
    if (res.rowCount === 0) return null;
    const row = await this.findById(id);
    // Report this write's own revision, from the UPDATE: another write can
    // land before the read-back, and realtime receivers compare revisions.
    return row ? { ...row, updatedAt: res.rows[0]?.updatedAt ?? row.updatedAt } : null;
  }

  /**
   * Strip a removed MCP server's id from every agent's `mcp_servers` array.
   *
   * One set-based UPDATE: `jsonb - text` deletes every matching string element
   * (an emptied array stays `[]`, never NULL — the column's not-null invariant
   * holds), and the `?` filter touches only rows that actually reference the
   * id, so non-referencing agents get no write at all. Pass the transaction
   * client when the prune must commit or roll back with the server row's
   * DELETE (see `McpServers.removeAndPruneAgents`). Returns the ids of the
   * agents it pruned, so the delete can be undone.
   */
  async pruneMcpServerId(serverId: string, client?: DbQueryable): Promise<string[]> {
    const runner = client ?? this.pool;
    const res = await runner.query<{ id: string }>(
      `UPDATE ${this.qualifiedTable}
          SET mcp_servers = mcp_servers - $1::text, updated_at = NOW()
        WHERE mcp_servers ? $1::text
        RETURNING id`,
      [serverId]
    );
    return res.rows.map((row) => row.id);
  }

  /**
   * Add an MCP server id back to the given agents' `mcp_servers` arrays (the
   * inverse of `pruneMcpServerId`, for undoing a delete). Agents that no
   * longer exist or already list the id are skipped. Returns the ids of the
   * agents that gained it.
   */
  async grantMcpServerId(
    serverId: string,
    agentIds: readonly string[],
    client?: DbQueryable
  ): Promise<string[]> {
    if (agentIds.length === 0) return [];
    const runner = client ?? this.pool;
    const res = await runner.query<{ id: string }>(
      `UPDATE ${this.qualifiedTable}
          SET mcp_servers = mcp_servers || jsonb_build_array($1::text), updated_at = NOW()
        WHERE id = ANY($2::text[]) AND NOT (mcp_servers ? $1::text)
        RETURNING id`,
      [serverId, agentIds]
    );
    return res.rows.map((row) => row.id);
  }
}

export const Agents = new AgentModelClass();
