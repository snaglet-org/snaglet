/**
 * MemoryModel — public.memories.
 *
 * updatedAt lives on the public.nodes spine; embeddings live in
 * public.embeddings keyed by node_id.
 *
 * Ownership: a memory is owned by an agent or a member (a human user), never
 * both; memories_owner_xor_chk enforces it. Methods that scope a query to
 * "the owner" take an `OwnerArg` (see @snaglet/db/ownerRef) so one code path
 * serves both kinds of owner.
 *
 * Trust and lifecycle: `verified` is true for a deliberate save and false
 * (the DB default) for a machine-extracted, unreviewed fact. `status` is
 * 'active' or 'proposed' (an extracted fact about a member, held inert until
 * a human approves it); `hybridSearch` excludes proposed rows.
 *
 * Hard-delete only; `deleteOne` cascades public.embeddings via the nodes FK.
 * The public field is `key`; the column is `memory_key`.
 */

import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { Nodes, type NodeRunner } from '@snaglet/db/tables/nodes';
import { normalizeOwner, ownerColumn, ownerId, type OwnerArg } from '@snaglet/db/ownerRef';
import { anyTermQueryText } from '@snaglet/db/tables/memories/anyTermQuery';
import { vectorLiteral } from '@snaglet/shared/utils';
import { NODE_KIND } from '@snaglet/shared/constants';

/**
 * Memory lifecycle. 'active' is a normal memory; 'proposed' is a
 * machine-extracted fact about a member held inert (excluded from
 * hybridSearch) until a human explicitly approves it.
 */
export type MemoryStatus = 'active' | 'proposed';

export interface MemoryRow {
  id: string;
  /** Exactly one of agentId/memberId is non-null (memories_owner_xor_chk). */
  agentId: string | null;
  memberId: string | null;
  key: string | null;
  content: string;
  sourceThreadId: string | null;
  /** False for machine-extracted, unreviewed facts. */
  verified: boolean;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMemoryInput {
  id: string;
  /** Exactly one of agentId/memberId must be set — the caller's resolved owner. */
  agentId?: string | null;
  memberId?: string | null;
  key?: string | null;
  content: string;
  sourceThreadId?: string | null;
  /** Defaults to false: unspecified writes are treated as unreviewed. */
  verified?: boolean;
  /** Defaults to 'active'. */
  status?: MemoryStatus;
}

/**
 * Test-only seam for `listAllByAgent`.
 *
 * Its snapshot guarantee is only testable if something can commit a write
 * while the read transaction is open, at a known point. PostgreSQL takes a
 * REPEATABLE READ snapshot at the first statement, not at BEGIN, so a write
 * racing the first page may legitimately land inside the snapshot.
 *
 * `onPage` is awaited inside the transaction after each page, letting a test
 * hold the read open, commit through a separately acquired connection, and
 * then release. Production callers pass nothing and this costs one undefined
 * check per page.
 */
interface MemoryPageObserver {
  onPage(pageIndex: number, rows: readonly MemoryRow[]): Promise<void>;
}

export interface UpdateMemoryInput {
  key?: string | null;
  content?: string;
  sourceThreadId?: string | null;
  verified?: boolean;
  status?: MemoryStatus;
}

/**
 * A memory with the names a person reads beside it (GET /api/memories/:id,
 * the memory preview). Each name is null when there is nothing to name: a
 * member-owned memory has no agent, and a memory saved outside a thread, or
 * from a thread that is untitled or archived, has no thread title.
 */
export interface MemoryDetailRow extends MemoryRow {
  /** The owning agent's display name. */
  agentName: string | null;
  /** The source thread's title. */
  sourceThreadTitle: string | null;
}

export interface MemorySearchResult extends MemoryRow {
  combinedScore: number;
  vectorScore: number | null;
  keywordScore: number | null;
  baseScore?: number;
  adjustedScore?: number;
}

interface MemoryRawRow {
  id: string;
  agent_id: string | null;
  member_id: string | null;
  key: string | null;
  content: string;
  source_thread_id: string | null;
  verified: boolean;
  status: MemoryStatus;
  created_at: string;
  updated_at: string;
}

function mapRow(raw: MemoryRawRow): MemoryRow {
  return {
    id: raw.id,
    agentId: raw.agent_id,
    memberId: raw.member_id,
    key: raw.key,
    content: raw.content,
    sourceThreadId: raw.source_thread_id,
    verified: raw.verified,
    status: raw.status,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

class MemoryModelClass extends Model<MemoryRow, CreateMemoryInput, UpdateMemoryInput> {
  constructor() {
    super({
      table: 'memories',
      primaryKey: 'id',
      updatedAtColumn: null, // updatedAt lives on public.nodes
      columnMap: {
        agentId: 'agent_id',
        memberId: 'member_id',
        key: 'memory_key',
        sourceThreadId: 'source_thread_id',
      },
    });
  }

  /** Projection that JOINs public.nodes for updatedAt. */
  private get memorySelect(): string {
    return `
      SELECT
        m.id, m.agent_id, m.member_id, m.memory_key AS key, m.content, m.source_thread_id,
        m.verified, m.status, m.created_at, n.updated_at
      FROM ${this.qualifiedTable} m
      JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = m.id
    `.trim();
  }

  override async create(input: CreateMemoryInput): Promise<MemoryRow> {
    // Spine row and memories row commit together, so a failed insert never
    // leaves an orphan `nodes` row behind.
    await transaction(async (tx) => {
      await Nodes.ensure(input.id, NODE_KIND.MEMORY, { runner: tx });
      await tx.query(
        `INSERT INTO ${this.qualifiedTable} (id, agent_id, member_id, memory_key, content, source_thread_id, verified, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.id,
          input.agentId ?? null,
          input.memberId ?? null,
          input.key ?? null,
          input.content,
          input.sourceThreadId ?? null,
          input.verified ?? false,
          input.status ?? 'active',
        ]
      );
    });

    const row = await this.findById(input.id);
    if (!row) throw new Error(`MemoryModel.create: row ${input.id} missing after insert`);
    return row;
  }

  override async update(id: string, input: UpdateMemoryInput): Promise<MemoryRow | null> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.key !== undefined) {
      values.push(input.key);
      fields.push(`memory_key = $${values.length}`);
    }
    if (input.content !== undefined) {
      values.push(input.content);
      fields.push(`content = $${values.length}`);
    }
    if (input.sourceThreadId !== undefined) {
      values.push(input.sourceThreadId);
      fields.push(`source_thread_id = $${values.length}`);
    }
    if (input.verified !== undefined) {
      values.push(input.verified);
      fields.push(`verified = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      fields.push(`status = $${values.length}`);
    }

    if (fields.length === 0) return this.findById(id);

    values.push(id);
    await this.pool.query(
      `UPDATE ${this.qualifiedTable} SET ${fields.join(', ')} WHERE id = $${values.length}`,
      values
    );
    return this.findById(id);
  }

  override async findById(id: string): Promise<MemoryRow | null> {
    const raw = await this.rawQueryOne<MemoryRawRow>(
      `${this.memorySelect} WHERE m.id = $1 LIMIT 1`,
      [id]
    );
    return raw ? mapRow(raw) : null;
  }

  /**
   * One memory plus its agent's name and its source thread's title, for the
   * memory preview. An archived agent still has its name (attribution keeps
   * naming archived authors); an archived thread's title is left out, so the
   * preview shows its generic thread label.
   */
  async findDetailById(id: string): Promise<MemoryDetailRow | null> {
    const schema = quoteIdentifier(this.schema);
    const raw = await this.rawQueryOne<
      MemoryRawRow & { agent_name: string | null; source_thread_title: string | null }
    >(
      `SELECT
         m.id, m.agent_id, m.member_id, m.memory_key AS key, m.content, m.source_thread_id,
         m.verified, m.status, m.created_at, n.updated_at,
         a.name AS agent_name,
         CASE WHEN tn.archived = false THEN t.title END AS source_thread_title
       FROM ${this.qualifiedTable} m
       JOIN ${schema}.${quoteIdentifier('nodes')} n ON n.id = m.id
       LEFT JOIN ${schema}.${quoteIdentifier('agents')} a ON a.id = m.agent_id
       LEFT JOIN ${schema}.${quoteIdentifier('threads')} t ON t.id = m.source_thread_id
       LEFT JOIN ${schema}.${quoteIdentifier('nodes')} tn ON tn.id = m.source_thread_id
       WHERE m.id = $1
       LIMIT 1`,
      [id]
    );
    if (!raw) return null;
    return {
      ...mapRow(raw),
      agentName: raw.agent_name?.trim() || null,
      sourceThreadTitle: raw.source_thread_title?.trim() || null,
    };
  }

  /**
   * Override base Model.list so the custom projection is used.
   */
  override async list(opts?: { limit?: number; offset?: number }): Promise<MemoryRow[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const raws = await this.rawQuery<MemoryRawRow>(
      `${this.memorySelect} ORDER BY m.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return raws.map(mapRow);
  }

  /**
   * The calling agent's memories (agent-only by design: this backs the
   * memories HTTP panel, which is an agent-scoped admin view; it does not
   * (yet) surface member-owned memories). Owner-scoped Model methods used by
   * the memory_store/recall/forget tools (findByKey/findNearDuplicate/
   * hybridSearch/deleteByQuery below) accept an OwnerArg instead.
   */
  async listByAgent(
    agentId: string,
    opts?: { limit?: number; offset?: number; threadId?: string }
  ): Promise<MemoryRow[]> {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const threadId = opts?.threadId;

    // Optional thread scoping: callers wiring the per-thread memory panel
    // pass the host thread's id so the list narrows to memories recorded in
    // this conversation (source_thread_id): the agent's own, plus the facts
    // about the human that were proposed here and kept (member-owned, active;
    // a proposal still waiting is never listed here). Bound positions stay
    // stable across the two query shapes — limit and offset always come last.
    const sql = threadId
      ? `${this.memorySelect}
         WHERE m.source_thread_id = $2
           AND (m.agent_id = $1 OR (m.member_id IS NOT NULL AND m.status = 'active'))
         ORDER BY n.updated_at DESC, m.id LIMIT $3 OFFSET $4`
      : `${this.memorySelect} WHERE m.agent_id = $1
         ORDER BY n.updated_at DESC LIMIT $2 OFFSET $3`;
    const params: unknown[] = threadId
      ? [agentId, threadId, limit, offset]
      : [agentId, limit, offset];

    const raws = await this.rawQuery<MemoryRawRow>(sql, params);
    return raws.map(mapRow);
  }

  /**
   * Proposals (status 'proposed') recorded in one thread, newest first. They are
   * member-owned and inert, so no agent-scoped list reaches them; the thread's
   * approval view reads them here. `m.id` breaks ties so a page never repeats a row.
   */
  async listProposedByThread(threadId: string, opts?: { limit?: number }): Promise<MemoryRow[]> {
    const raws = await this.rawQuery<MemoryRawRow>(
      `${this.memorySelect} WHERE m.status = 'proposed' AND m.source_thread_id = $1
       ORDER BY n.updated_at DESC, m.id LIMIT $2`,
      [threadId, opts?.limit ?? 100]
    );
    return raws.map(mapRow);
  }

  /**
   * Every memory owned by `agentId`, as one consistent set.
   *
   * Looping the paged `listByAgent` is not safe for completeness: its
   * `ORDER BY n.updated_at DESC` has no tie-break (memories written in one
   * turn share a timestamp) and `updated_at` is mutable, so LIMIT/OFFSET can
   * skip and duplicate rows and produce a short export that calls itself
   * complete.
   *
   * One REPEATABLE READ transaction gives every page the same snapshot, and
   * keyset paging on `(updated_at, id)` gives a total order, so the result is
   * exactly the set that existed when the export began.
   */
  async listAllByAgent(
    agentId: string,
    pageSize = 200,
    observer?: MemoryPageObserver
  ): Promise<MemoryRow[]> {
    return transaction(async (tx): Promise<MemoryRow[]> => {
      // Must be the first statement in the transaction; `transaction()` has
      // issued BEGIN and nothing else.
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');

      const out: MemoryRow[] = [];
      let cursor: { updatedAt: string; id: string } | null = null;
      let pageIndex = 0;

      for (;;) {
        // Row-value comparison `(a, b) < (x, y)` is a true lexicographic
        // compare in PostgreSQL, so this is one index-friendly predicate
        // rather than a hand-expanded OR chain.
        const sql = cursor
          ? `${this.memorySelect} WHERE m.agent_id = $1 AND (n.updated_at, m.id) < ($2, $3)
             ORDER BY n.updated_at DESC, m.id DESC LIMIT $4`
          : `${this.memorySelect} WHERE m.agent_id = $1
             ORDER BY n.updated_at DESC, m.id DESC LIMIT $2`;
        const params = cursor
          ? [agentId, cursor.updatedAt, cursor.id, pageSize]
          : [agentId, pageSize];

        // Annotated rather than inferred: `cursor` is assigned from the last
        // row at the bottom of this loop, so inference would have to resolve
        // the loop's back edge to type the query that produces it.
        const rows: MemoryRow[] = (await tx.query<MemoryRawRow>(sql, params)).rows.map(mapRow);
        out.push(...rows);

        // Test-only seam (see MemoryPageObserver). Awaited inside the snapshot
        // transaction so a test can commit a concurrent write at a known point
        // between two pages instead of racing the first statement.
        if (observer) await observer.onPage(pageIndex, rows);
        pageIndex += 1;

        if (rows.length < pageSize) return out;
        const last: MemoryRow = rows[rows.length - 1];
        cursor = { updatedAt: last.updatedAt ?? last.createdAt, id: last.id };
      }
    });
  }

  async deleteOne(id: string): Promise<boolean> {
    // Deleting the public.nodes row cascades public.memories and any public.embeddings
    // pointing at this memory (via shared-PK FK from public.embeddings.id).
    const deleted = await Nodes.deleteOfType(id, NODE_KIND.MEMORY);
    if (!deleted) return false;
    // Also clean up embeddings that pointed at this memory as their target node.
    await this.pool.query(
      `DELETE FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}
       WHERE id IN (SELECT id FROM public.embeddings WHERE node_id = $1)`,
      [id]
    );
    return true;
  }

  async deleteByQuery(ownerArg: OwnerArg, opts: { query: string }): Promise<number> {
    const owner = normalizeOwner(ownerArg);
    const column = ownerColumn(owner);
    // search_text is a stored generated vector, weighted memory_key (A) +
    // content (B) and GIN-indexed, so this uses the index and matches keys too.
    const ids = await this.rawQuery<{ id: string }>(
      // Deliberately all-terms (plainto_tsquery), never anyTermQueryText: this match decides a destructive delete.
      `SELECT id FROM ${this.qualifiedTable}
       WHERE ${column} = $1
         AND search_text @@ plainto_tsquery('english', $2)`,
      [ownerId(owner), opts.query]
    );
    if (ids.length === 0) return 0;
    // Cascade-delete the memory rows + their embeddings via public.nodes.
    await this.pool.query(
      `DELETE FROM ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}
       WHERE id = ANY($1::text[])
          OR id IN (SELECT id FROM public.embeddings WHERE node_id = ANY($1::text[]))`,
      [ids.map((r) => r.id)]
    );
    return ids.length;
  }

  async deleteByThread(threadId: string, runner?: NodeRunner): Promise<number> {
    const r = runner ?? this.pool;
    const { rows: ids } = await r.query<{ id: string }>(
      `SELECT id FROM ${this.qualifiedTable} WHERE source_thread_id = $1`,
      [threadId]
    );
    if (ids.length === 0) return 0;
    await Nodes.deleteByIds(
      ids.map((row) => row.id),
      r
    );
    return ids.length;
  }

  /**
   * Vector + keyword search over the owner's memories (an agent's own, or a
   * member/user's own — see @snaglet/db/ownerRef), never across owners, except
   * that `alsoMemberId` adds one member's memories (the thread's human) to an
   * agent's search.
   *
   * Proposed rows are excluded in every arm: a proposal awaiting human
   * approval must never surface as recalled knowledge.
   *
   * Optional `projectScope` (auto-recall only): memories have no project
   * column, so a memory's project is its source thread's nodes.project_id.
   * With a scope, a memory is a candidate only if it is agent-global (no
   * source thread, or a flat one; a deleted source thread cascades its
   * memories away) or its source thread's project is in `allowedProjectIds`.
   * The predicate sits inside every candidate arm so other-project memories
   * never consume the candidate pool. No scope means unscoped (explicit
   * memory-tool recall); an empty `allowedProjectIds` means agent-global
   * memories only.
   */
  async hybridSearch(
    embedding: number[] | null,
    queryText: string,
    ownerArg: OwnerArg,
    opts?: {
      limit?: number;
      projectScope?: { allowedProjectIds: string[] };
      /**
       * Also admit this member's memories (an agent's recall in a thread whose
       * human is this member): the owner filter becomes "the owner's OR this
       * member's" inside every arm, so both share one candidate pool.
       */
      alsoMemberId?: string | null;
    }
  ): Promise<MemorySearchResult[]> {
    const owner = normalizeOwner(ownerArg);
    const column = ownerColumn(owner);
    const id = ownerId(owner);
    const limit = opts?.limit ?? 10;
    const scopeIds = opts?.projectScope ? [...new Set(opts.projectScope.allowedProjectIds)] : null;
    const alsoMemberId = opts?.alsoMemberId ?? null;
    const nodesTable = `${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')}`;
    // Each arm binds its own params first ($1..$base), then the optional
    // member and project-scope params after them. Returns those trailing
    // params with the owner and scope SQL that reference them.
    const tail = (base: number) => {
      const params: unknown[] = [];
      let ownerSql = `m.${column} = $1`;
      if (alsoMemberId) {
        params.push(alsoMemberId);
        ownerSql = `(m.${column} = $1 OR m.member_id = $${base + params.length})`;
      }
      let scopeSql = '';
      if (scopeIds !== null) {
        params.push(scopeIds);
        scopeSql = `AND NOT EXISTS (
            SELECT 1 FROM ${nodesTable} st
            WHERE st.id = m.source_thread_id
              AND st.project_id IS NOT NULL
              AND st.project_id <> ALL($${base + params.length}::text[])
          )`;
      }
      return { params, owner: ownerSql, scope: scopeSql };
    };
    const select = `
      m.id, m.agent_id AS "agentId", m.member_id AS "memberId", m.memory_key AS "key", m.content,
      m.source_thread_id AS "sourceThreadId", m.verified, m.status,
      m.created_at AS "createdAt", n.updated_at AS "updatedAt"
    `;
    const fromJoin = `
      FROM ${this.qualifiedTable} m
      JOIN ${quoteIdentifier(this.schema)}.${quoteIdentifier('nodes')} n ON n.id = m.id
    `;

    if (embedding && queryText) {
      const t = tail(4);
      const { rows } = await this.pool.query<MemorySearchResult>(
        `WITH vector_matches AS (
          -- Ordered scan + LIMIT is the index-servable shape. The
          -- owner filter is usually far more selective than the ANN
          -- traversal, so the planner is free to drive from memories and
          -- sort — both plans are correct; distances re-rank below either way.
          -- No vector_dims() guard is needed: the column is typed
          -- vector(768), so every row has the same width.
          SELECT m.id, 1 - (e.vector <=> $2::vector) AS vector_score
          FROM ${this.qualifiedTable} m
          JOIN public.embeddings e ON e.node_id = m.id
          WHERE ${t.owner} AND m.status <> 'proposed'
            ${t.scope}
          ORDER BY e.vector <=> $2::vector
          LIMIT 50
        ),
        keyword_matches AS (
          -- Any-term match: $3 is anyTermQueryText(queryText), so
          -- a memory sharing some of the query's words qualifies. Rank
          -- normalization 32 (rank/(rank+1)) bounds the score to [0, 1) so a
          -- long memory repeating common words cannot swamp the vector arm.
          -- ORDER BY before LIMIT: any-term can match more than 50 rows, and
          -- the cap must keep the best ones, not an arbitrary 50.
          SELECT m.id,
                 ts_rank_cd('{0.1, 0.2, 0.4, 1.0}'::float4[], m.search_text, websearch_to_tsquery('english', $3), 32) AS keyword_score
          FROM ${this.qualifiedTable} m
          WHERE ${t.owner} AND m.status <> 'proposed'
            AND m.search_text @@ websearch_to_tsquery('english', $3)
            ${t.scope}
          ORDER BY keyword_score DESC
          LIMIT 50
        )
        SELECT ${select},
          COALESCE(v.vector_score, 0)::real AS "vectorScore",
          COALESCE(k.keyword_score, 0)::real AS "keywordScore",
          (COALESCE(v.vector_score, 0) * 0.7
           + COALESCE(k.keyword_score, 0) * 0.3
           - EXTRACT(EPOCH FROM (NOW() - m.created_at)) / (86400.0 * 365) * 0.05
          )::real AS "combinedScore"
        ${fromJoin}
        LEFT JOIN vector_matches v ON m.id = v.id
        LEFT JOIN keyword_matches k ON m.id = k.id
        WHERE ${t.owner} AND m.status <> 'proposed'
          AND (v.id IS NOT NULL OR k.id IS NOT NULL)
        ORDER BY "combinedScore" DESC
        LIMIT $4`,
        [id, vectorLiteral(embedding), anyTermQueryText(queryText), limit, ...t.params]
      );
      return rows;
    }

    if (embedding) {
      const t = tail(3);
      const { rows } = await this.pool.query<MemorySearchResult>(
        `SELECT ${select},
          (1 - (e.vector <=> $2::vector))::real AS "vectorScore",
          NULL::real AS "keywordScore",
          ((1 - (e.vector <=> $2::vector)) * 0.7
           - EXTRACT(EPOCH FROM (NOW() - m.created_at)) / (86400.0 * 365) * 0.05
          )::real AS "combinedScore"
        ${fromJoin}
        JOIN public.embeddings e ON e.node_id = m.id
        WHERE ${t.owner} AND m.status <> 'proposed'
          ${t.scope}
        ORDER BY e.vector <=> $2::vector
        LIMIT $3`,
        [id, vectorLiteral(embedding), limit, ...t.params]
      );
      return rows;
    }

    const t = tail(3);
    const { rows } = await this.pool.query<MemorySearchResult>(
      `SELECT ${select},
        NULL::real AS "vectorScore",
        ts_rank_cd('{0.1, 0.2, 0.4, 1.0}'::float4[], m.search_text, plainto_tsquery('english', $2))::real AS "keywordScore",
        (ts_rank_cd('{0.1, 0.2, 0.4, 1.0}'::float4[], m.search_text, plainto_tsquery('english', $2)) * 0.3
         - EXTRACT(EPOCH FROM (NOW() - m.created_at)) / (86400.0 * 365) * 0.05
        )::real AS "combinedScore"
      ${fromJoin}
      WHERE ${t.owner} AND m.status <> 'proposed'
        AND m.search_text @@ plainto_tsquery('english', $2)
        ${t.scope}
      ORDER BY "combinedScore" DESC
      LIMIT $3`,
      [id, queryText, limit, ...t.params]
    );
    return rows;
  }

  async findNearDuplicate(
    ownerArg: OwnerArg,
    embedding: number[],
    threshold = 0.95
  ): Promise<MemoryRow | null> {
    const owner = normalizeOwner(ownerArg);
    const column = ownerColumn(owner);
    const raw = await this.rawQueryOne<MemoryRawRow>(
      `${this.memorySelect}
       JOIN public.embeddings e ON e.node_id = m.id
       WHERE m.${column} = $1
         AND 1 - (e.vector <=> $2::vector) > $3
       ORDER BY e.vector <=> $2::vector
       LIMIT 1`,
      [ownerId(owner), vectorLiteral(embedding), threshold]
    );
    return raw ? mapRow(raw) : null;
  }

  async findByKey(ownerArg: OwnerArg, key: string): Promise<MemoryRow | null> {
    const owner = normalizeOwner(ownerArg);
    const column = ownerColumn(owner);
    const raw = await this.rawQueryOne<MemoryRawRow>(
      `${this.memorySelect}
       WHERE m.${column} = $1 AND LOWER(m.memory_key) = LOWER($2)
       ORDER BY n.updated_at DESC LIMIT 1`,
      [ownerId(owner), key]
    );
    return raw ? mapRow(raw) : null;
  }

  async getStats(agentId: string): Promise<{ total: number }> {
    const row = await this.queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.qualifiedTable} WHERE agent_id = $1`,
      [agentId]
    );
    return { total: Number(row?.count ?? 0) };
  }
}

export const Memories = new MemoryModelClass();
