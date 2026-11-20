/**
 * NodeModel — public.nodes (the node spine).
 *
 * Every first-class node (container, doc, thread, message, memory,
 * thread_summary, image, file, tool) has a row here keyed by text id,
 * with `type` as the discriminator. Type tables share the PK and FK to
 * nodes ON DELETE CASCADE. Only thread nodes carry `project_id`, and a
 * thread never has a `container_id`.
 *
 * This Model owns the `INSERT INTO public.nodes ... ON CONFLICT DO NOTHING`
 * and `DELETE FROM public.nodes WHERE id = ... AND type = ...` patterns that
 * every type-table Model needs. `ensure`, `deleteOfType` and `touch` accept
 * an optional `runner` so callers inside a transaction keep the node-row
 * write in the same tx as their type-table insert.
 */

import { Model } from '@snaglet/db/Model';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import { nodeInputError } from './nodeInput';
import { helperThreadExclusionSql } from '@snaglet/db/tables/threads/visibility';

/** Mirror of the SQL `public.node_type` enum. Keep in sync with the DDL.
 *  Links and embeddings are not node types. The SQL enum also holds the
 *  unused labels 'sketch', 'post' and 'discussion' (a Postgres enum value
 *  cannot be dropped in place); no code path mints them. 'post' and
 *  'discussion' are mirrored below, 'sketch' is not. */
export type NodeType =
  | 'container'
  | 'doc'
  | 'thread'
  | 'message'
  | 'memory'
  | 'thread_summary'
  | 'image'
  | 'post'
  | 'discussion'
  | 'calendar_event'
  | 'tool'
  | 'file';

export interface NodeRow {
  id: string;
  type: NodeType;
  createdAt: string;
  updatedAt: string;
}

export interface CreateNodeInput {
  id: string;
  type: NodeType;
}

/** No-op shape — nodes carry no mutable fields besides updated_at (use touch). */
export type UpdateNodeInput = Record<string, never>;

/**
 * Minimal query-runner shape. Satisfied by `pg.Pool`, `pg.PoolClient`,
 * the adapter-agnostic `DbClient`, and any tx-callback object. Lets
 * transactional callers thread their runner through so node-spine writes
 * share the parent tx.
 *
 * One minimal shape so TypeScript resolves `.query()` without overload
 * ambiguity. The return type is permissive because `ensure`/`touch`/
 * `deleteOfType` only read `rows`.
 */
export type NodeRunner = {
  query: <T = unknown>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
};

/** The one error every container_id writer raises for a thread node. */
export function threadPlacementError(nodeId?: string): AppError {
  const subject = nodeId ? `Thread ${nodeId}` : 'A thread';
  return nodeInputError(
    `${subject} cannot be placed in a container: threads are placed by project_id (Threads.setProject), never by container_id`
  );
}

class NodeModelClass extends Model<NodeRow, CreateNodeInput, UpdateNodeInput> {
  constructor() {
    super({ table: 'nodes', primaryKey: 'id' });
  }

  /**
   * Idempotently ensure a node spine row exists for (id, type). Returns the
   * id back so callers can chain it into the type-table insert that follows.
   *
   * `ON CONFLICT (id) DO NOTHING` makes this safe to call when the id may
   * already exist (e.g. re-imports, retries).
   *
   * `options.containerId` sets `nodes.container_id` on first insert (optional
   * for every kind that lives in the folder tree — placement is never
   * required). Threads are never placed in the tree: they are scoped by
   * `project_id` instead, and a `containerId` for a thread is refused here.
   */
  async ensure(
    id: string,
    type: NodeType,
    options?: { containerId?: string | null; runner?: NodeRunner }
  ): Promise<string> {
    const r = options?.runner ?? this.pool;
    if (type === 'thread' && options?.containerId != null) {
      throw threadPlacementError(id);
    }
    if (options?.containerId !== undefined) {
      await r.query(
        `INSERT INTO public.nodes (id, type, container_id) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, type, options.containerId]
      );
    } else {
      await r.query(
        `INSERT INTO public.nodes (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [id, type]
      );
    }
    return id;
  }

  /** Bulk variant of {@link ensure}. Single-statement insert. */
  async ensureMany(
    items: ReadonlyArray<{ id: string; type: NodeType }>,
    runner?: NodeRunner
  ): Promise<void> {
    if (items.length === 0) return;
    const r = runner ?? this.pool;
    const values: unknown[] = [];
    const placeholders = items.map((it, i) => {
      values.push(it.id, it.type);
      return `($${i * 2 + 1}, $${i * 2 + 2})`;
    });
    await r.query(
      `INSERT INTO public.nodes (id, type) VALUES ${placeholders.join(', ')} ON CONFLICT (id) DO NOTHING`,
      values
    );
  }

  /** Bump `updated_at = NOW()` for a single node. */
  async touch(id: string, runner?: NodeRunner): Promise<void> {
    const r = runner ?? this.pool;
    await r.query(`UPDATE public.nodes SET updated_at = NOW() WHERE id = $1`, [id]);
  }

  /** Read the type discriminator for a node id. */
  async getType(id: string): Promise<NodeType | null> {
    const row = await this.queryOne<{ type: NodeType }>(
      `SELECT type FROM public.nodes WHERE id = $1 LIMIT 1`,
      [id]
    );
    return row?.type ?? null;
  }

  /**
   * Read the current container (placement parent) for a node id, or null if the
   * node is at the root or does not exist. Used by the per-model `moveTo()`
   * methods to capture the pre-move container so a container-changing move can
   * be recorded in placement_events.
   */
  async getContainerId(id: string, runner?: NodeRunner): Promise<string | null> {
    const r = runner ?? this.pool;
    const { rows } = await r.query<{ container_id: string | null }>(
      `SELECT container_id FROM public.nodes WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0]?.container_id ?? null;
  }

  /**
   * Read a thread's project scope (`nodes.project_id`), or null when the
   * thread is flat or the id is unknown. Only thread nodes carry a project.
   */
  async getProjectId(id: string, runner?: NodeRunner): Promise<string | null> {
    const r = runner ?? this.pool;
    const { rows } = await r.query<{ project_id: string | null }>(
      `SELECT project_id FROM public.nodes WHERE id = $1 LIMIT 1`,
      [id]
    );
    return rows[0]?.project_id ?? null;
  }

  /**
   * Refuse any placement parent that is not a live container. The
   * `nodes.container_id` FK accepts any node and cascades on delete, so a doc
   * or thread used as a parent would take the whole placed subtree with it
   * when it is deleted, and an archived parent hides a live child. `null`
   * (root) always passes. `FOR SHARE` holds the parent row until the caller's
   * transaction ends, so a concurrent archive or delete of that parent waits
   * for the placement to commit instead of racing it.
   *
   * Pass `childType` when known: a thread is never placed in the tree (it is
   * scoped by `project_id`), so any placement of a thread — even at the root —
   * is refused before the parent is looked at.
   */
  async assertPlacementParent(
    parentId: string | null,
    runner?: NodeRunner,
    childType?: NodeType
  ): Promise<void> {
    if (childType === 'thread') throw threadPlacementError();
    if (parentId === null) return;
    const r = runner ?? this.pool;
    const { rows } = await r.query<{ type: NodeType; archived: boolean }>(
      `SELECT type, archived FROM public.nodes WHERE id = $1 FOR SHARE`,
      [parentId]
    );
    const parent = rows[0];
    if (!parent) {
      throw new AppError(`Destination container ${parentId} not found`, ErrorCode.NOT_FOUND, 404);
    }
    if (parent.type !== 'container') {
      throw new AppError(
        `Destination ${parentId} is a ${parent.type}, not a container; only containers can hold other nodes`,
        ErrorCode.VALIDATION_ERROR,
        400
      );
    }
    if (parent.archived) {
      throw new AppError(
        `Destination container ${parentId} is archived; restore it or choose a live container`,
        ErrorCode.VALIDATION_ERROR,
        400
      );
    }
  }

  /**
   * Count active (non-archived) nodes of the kinds that gauge whether a
   * workspace has anything worth retrieving. Restricted to non-message types so
   * it never scans the large message row set. Subagent helper threads are not
   * counted.
   */
  async countWorkspaceContent(): Promise<{
    docs: number;
    threads: number;
    memories: number;
    projects: number;
    files: number;
    images: number;
    tools: number;
  }> {
    const row = await this.queryOne<{
      docs: string;
      threads: string;
      memories: string;
      projects: string;
      files: string;
      images: string;
      tools: string;
    }>(
      // Projects are not a node type: count active project containers
      // (containers.category='project') with a scalar subquery.
      `SELECT
         COUNT(*) FILTER (WHERE type = 'doc')::text AS docs,
         COUNT(*) FILTER (WHERE type = 'thread' AND ${helperThreadExclusionSql('nodes.id')})::text AS threads,
         COUNT(*) FILTER (WHERE type = 'memory')::text AS memories,
         COUNT(*) FILTER (WHERE type = 'file')::text AS files,
         COUNT(*) FILTER (WHERE type = 'image')::text AS images,
         COUNT(*) FILTER (WHERE type = 'tool')::text AS tools,
         (SELECT COUNT(*)
            FROM public.containers c
            JOIN public.nodes cn ON cn.id = c.id
           WHERE c.category = 'project' AND cn.archived = false)::text AS projects
       FROM public.nodes
       WHERE archived = false
         AND type IN ('doc', 'thread', 'memory', 'file', 'image', 'tool')`,
      []
    );
    return {
      docs: row ? parseInt(row.docs, 10) : 0,
      threads: row ? parseInt(row.threads, 10) : 0,
      memories: row ? parseInt(row.memories, 10) : 0,
      projects: row ? parseInt(row.projects, 10) : 0,
      files: row ? parseInt(row.files, 10) : 0,
      images: row ? parseInt(row.images, 10) : 0,
      tools: row ? parseInt(row.tools, 10) : 0,
    };
  }

  /**
   * Delete a node iff it has the expected `type`. Cascades to the
   * type-table child row via the shared-PK FK. Returns true when a row
   * was deleted. Use this in type-table `delete()` overrides as a
   * type-safety guard against cross-type deletion.
   */
  async deleteOfType(id: string, type: NodeType, runner?: NodeRunner): Promise<boolean> {
    const r = runner ?? this.pool;
    const { rowCount } = await r.query(`DELETE FROM public.nodes WHERE id = $1 AND type = $2`, [
      id,
      type,
    ]);
    return (rowCount ?? 0) > 0;
  }

  /** Bulk variant of {@link deleteOfType}. Returns the number of rows deleted. */
  async deleteManyOfType(
    ids: ReadonlyArray<string>,
    type: NodeType,
    runner?: NodeRunner
  ): Promise<number> {
    if (ids.length === 0) return 0;
    const r = runner ?? this.pool;
    const { rowCount } = await r.query(
      `DELETE FROM public.nodes WHERE id = ANY($1::text[]) AND type = $2`,
      [ids, type]
    );
    return rowCount ?? 0;
  }

  /**
   * Untyped bulk delete by id. Use when the caller has already validated
   * the type via a subquery against the type table (e.g. cascading deletes
   * from `embeddings.node_id` where the ids set is derived from the child
   * row, not the spine).
   */
  async deleteByIds(ids: ReadonlyArray<string>, runner?: NodeRunner): Promise<number> {
    if (ids.length === 0) return 0;
    const r = runner ?? this.pool;
    const { rowCount } = await r.query(`DELETE FROM public.nodes WHERE id = ANY($1::text[])`, [
      ids,
    ]);
    return rowCount ?? 0;
  }

  /**
   * Override base `create` so the contract still resolves to a NodeRow,
   * but the underlying insert is idempotent (matches how every type-table
   * Model wants to use it).
   */
  override async create(input: CreateNodeInput): Promise<NodeRow> {
    await this.ensure(input.id, input.type);
    const row = await this.findById(input.id);
    if (!row) throw new Error(`NodeModel.create: row ${input.id} missing after insert`);
    return row;
  }
}

export const Nodes = new NodeModelClass();
