/**
 * LinkModel — public.links, the graph linking any node to any node.
 *
 * Links are edges between nodes, not nodes themselves. source_id and
 * target_id FK into public.nodes(id), but a link's own id is a uuid with no
 * node row backing it. Timestamps live directly on this table.
 */

import { randomUUID } from 'crypto';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import { Model } from '@snaglet/db/Model';
import { isValidLinkTriple, InvalidLinkTripleError } from './linkTypeMatrix';

/**
 * Node-scheme namespace for content references like `[Title](type:uuid)`.
 * Not stored on public.links itself; canonical vocabulary used by content-ref
 * parsing and unified-search source mapping. Edit this list to change the
 * universe; agent tool schemas + content-ref parsing derive from it.
 */
export const LINK_NODE_TYPES = [
  'doc',
  'page', // bare-UUID scheme still found in older content refs
  'container',
  'library_node',
  'thread',
  'thread_summary',
  'message',
  'memory',
  // 'agent', 'block', 'project' and 'task' are not link node types: agents
  // are actors, not nodes, so a link can never resolve to one.
] as const;
export type LinkNodeType = (typeof LINK_NODE_TYPES)[number];

/**
 * The vocabulary of edge labels stored in `public.links.relation`.
 *
 * `links` is for **associative** relationships only —
 * content references, semantic similarity, derived summaries, provenance.
 * Structural / ownership relationships (parent-child, container membership,
 * project of-record) live as FK columns instead, where they get DB-level
 * integrity, indexes, and 1:N enforcement.
 *
 * The vocabulary is deliberately small — three relations:
 *
 *   references — author-created associative links (doc embeds via
 *                `![](id)` / `[](id)`, explicit cross-refs). Default.
 *   summarizes — agent/system-generated summarization edges
 *                (thread_summary → message, memory → thread).
 *   context    — provenance / "derived from" edges
 *                (memory → source thread, memory → summary).
 *
 * Add to this list only when a real feature needs to query for it.
 * The closed set is enforced at the DB level via `links_relation_check`.
 */
export const LINK_RELATIONS = ['references', 'summarizes', 'context'] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface LinkRow {
  id: string;
  sourceId: string;
  targetId: string;
  relation: LinkRelation;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Same shape as `LinkRow` plus the source/target node types resolved via
 * a JOIN on `public.nodes`. Returned by `filterWithTypes` for debug /
 * inspector surfaces that need to render the chip kind without doing
 * per-id lookups round-trips.
 */
export interface LinkRowWithTypes extends LinkRow {
  sourceType: string | null;
  targetType: string | null;
}

export interface CreateLinkInput {
  sourceId: string;
  targetId: string;
  relation?: LinkRelation;
  metadata?: Record<string, unknown>;
}

export interface UpdateLinkInput {
  relation?: LinkRelation;
  metadata?: Record<string, unknown>;
}

export interface LinkFilter {
  sourceId?: string;
  targetId?: string;
  relation?: LinkRelation;
  limit?: number;
  offset?: number;
}

/** Inspector / debug-surface filter: superset of `LinkFilter` with the
 *  source/target node-type narrowing that only makes sense when the
 *  query is doing the JOIN on `public.nodes`. Consumed by
 *  `filterWithTypes`. */
export type LinkSort = 'updated_desc' | 'updated_asc' | 'created_desc' | 'created_asc';

export interface LinkInspectorFilter extends LinkFilter {
  sourceType?: string;
  targetType?: string;
  sort?: LinkSort;
}

interface LinkRawRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: LinkRelation;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = `l.id, l.source_id, l.target_id, l.relation, l.metadata,
                     l.created_at, l.updated_at`;

class LinkModelClass extends Model<LinkRow, CreateLinkInput, UpdateLinkInput> {
  constructor() {
    super({ table: 'links', primaryKey: 'id', updatedAtColumn: null });
  }

  private mapRow(raw: LinkRawRow): LinkRow {
    return {
      id: raw.id,
      sourceId: raw.source_id,
      targetId: raw.target_id,
      relation: raw.relation,
      metadata: raw.metadata ?? {},
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  /** Insert public.nodes row + public.links row, return the new link. */
  private async insertLink(
    id: string,
    sourceId: string,
    targetId: string,
    relation: LinkRelation,
    metadata: Record<string, unknown>
  ): Promise<LinkRow> {
    await this.pool.query(
      `INSERT INTO ${this.qualifiedTable} (id, source_id, target_id, relation, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [id, sourceId, targetId, relation, JSON.stringify(metadata)]
    );

    const row = await this.findById(id);
    if (!row) throw new Error(`LinkModel.insertLink: row ${id} missing after insert`);
    return row;
  }

  /**
   * Upsert a link. If a row with (source_id, target_id, relation) already
   * exists, merge metadata; otherwise insert a new link.
   */
  async upsert(input: CreateLinkInput): Promise<LinkRow> {
    // Default to 'references' — the catch-all for author-created associative
    // edges. Callers that care about the specific edge label must pass
    // `relation` explicitly.
    const relation = input.relation ?? 'references';
    const metadata = input.metadata ?? {};

    // Validate the (source_type, relation, target_type) triple against the
    // canonical matrix before going to DB. The DB has a trigger that does the
    // same check; doing it here gives callers a clean TS error and avoids a
    // pointless round-trip on bad input.
    const types = await this.rawQueryOne<{ source_type: string; target_type: string }>(
      `SELECT
         (SELECT type::text FROM public.nodes WHERE id = $1) AS source_type,
         (SELECT type::text FROM public.nodes WHERE id = $2) AS target_type`,
      [input.sourceId, input.targetId]
    );
    if (!types?.source_type) {
      throw new AppError(
        `LinkModel.upsert: source node ${input.sourceId} not found`,
        ErrorCode.NOT_FOUND,
        404
      );
    }
    if (!types?.target_type) {
      throw new AppError(
        `LinkModel.upsert: target node ${input.targetId} not found`,
        ErrorCode.NOT_FOUND,
        404
      );
    }
    if (!isValidLinkTriple(types.source_type, relation, types.target_type)) {
      throw new InvalidLinkTripleError(types.source_type, relation, types.target_type);
    }

    const existing = await this.rawQueryOne<LinkRawRow>(
      `SELECT ${SELECT_COLS}
       FROM ${this.qualifiedTable} l
       WHERE l.source_id = $1 AND l.target_id = $2 AND l.relation = $3
       LIMIT 1`,
      [input.sourceId, input.targetId, relation]
    );

    if (existing) {
      const merged = { ...existing.metadata, ...metadata };
      await this.pool.query(
        `UPDATE ${this.qualifiedTable} SET metadata = $1::jsonb WHERE id = $2`,
        [JSON.stringify(merged), existing.id]
      );
      const updated = await this.findById(existing.id);
      if (!updated) throw new Error(`LinkModel.upsert: row ${existing.id} vanished mid-update`);
      return updated;
    }

    return this.insertLink(randomUUID(), input.sourceId, input.targetId, relation, metadata);
  }

  override async update(id: string, input: UpdateLinkInput): Promise<LinkRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (input.relation !== undefined) {
      sets.push(`relation = $${idx++}`);
      values.push(input.relation);
    }
    if (input.metadata !== undefined) {
      sets.push(`metadata = $${idx++}::jsonb`);
      values.push(JSON.stringify(input.metadata));
    }

    if (sets.length === 0) return this.findById(id);

    values.push(id);
    await this.pool.query(
      `UPDATE ${this.qualifiedTable} SET ${sets.join(', ')} WHERE id = $${values.length}`,
      values
    );
    return this.findById(id);
  }

  override async findById(id: string): Promise<LinkRow | null> {
    const raw = await this.rawQueryOne<LinkRawRow>(
      `SELECT ${SELECT_COLS}
       FROM ${this.qualifiedTable} l
       WHERE l.id = $1 LIMIT 1`,
      [id]
    );
    return raw ? this.mapRow(raw) : null;
  }

  /** Delete the link by id. */
  override async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM ${this.qualifiedTable} WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async filter(opts: LinkFilter = {}): Promise<LinkRow[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (opts.sourceId) {
      where.push(`l.source_id = $${idx++}`);
      values.push(opts.sourceId);
    }
    if (opts.targetId) {
      where.push(`l.target_id = $${idx++}`);
      values.push(opts.targetId);
    }
    if (opts.relation) {
      where.push(`l.relation = $${idx++}`);
      values.push(opts.relation);
    }

    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);
    values.push(limit, offset);

    const raws = await this.rawQuery<LinkRawRow>(
      `SELECT ${SELECT_COLS}
       FROM ${this.qualifiedTable} l
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY l.updated_at DESC
       LIMIT $${idx++} OFFSET $${idx}`,
      values
    );
    return raws.map((r) => this.mapRow(r));
  }

  /**
   * Same as `filter` but additionally resolves `sourceType` / `targetType`
   * via a JOIN on `public.nodes`. Supports type filtering and explicit
   * sort, and returns the total matching count alongside the page so
   * consumers (notably the links-inspector debug page) can paginate
   * against tables with tens of thousands of rows without re-running
   * count queries client-side.
   */
  async filterWithTypes(
    opts: LinkInspectorFilter = {}
  ): Promise<{ rows: LinkRowWithTypes[]; total: number }> {
    const where: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (opts.sourceId) {
      where.push(`l.source_id = $${idx++}`);
      values.push(opts.sourceId);
    }
    if (opts.targetId) {
      where.push(`l.target_id = $${idx++}`);
      values.push(opts.targetId);
    }
    if (opts.relation) {
      where.push(`l.relation = $${idx++}`);
      values.push(opts.relation);
    }
    if (opts.sourceType) {
      where.push(`ns.type::text = $${idx++}`);
      values.push(opts.sourceType);
    }
    if (opts.targetType) {
      where.push(`nt.type::text = $${idx++}`);
      values.push(opts.targetType);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    // Explicit allowlist — the sort key reaches SQL untouched, so we
    // can never let an arbitrary string land here.
    const orderBy = (() => {
      switch (opts.sort) {
        case 'updated_asc':
          return 'l.updated_at ASC';
        case 'created_desc':
          return 'l.created_at DESC';
        case 'created_asc':
          return 'l.created_at ASC';
        case 'updated_desc':
        default:
          return 'l.updated_at DESC';
      }
    })();

    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const pageValues = [...values, limit, offset];

    const baseFrom = `FROM ${this.qualifiedTable} l
       LEFT JOIN public.nodes ns ON ns.id = l.source_id
       LEFT JOIN public.nodes nt ON nt.id = l.target_id
       ${whereClause}`;

    const [raws, countRow] = await Promise.all([
      this.rawQuery<LinkRawRow & { source_type: string | null; target_type: string | null }>(
        `SELECT ${SELECT_COLS},
                ns.type::text AS source_type,
                nt.type::text AS target_type
         ${baseFrom}
         ORDER BY ${orderBy}
         LIMIT $${idx++} OFFSET $${idx}`,
        pageValues
      ),
      this.rawQueryOne<{ total: string }>(`SELECT COUNT(*)::text AS total ${baseFrom}`, values),
    ]);

    return {
      rows: raws.map((r) => ({
        ...this.mapRow(r),
        sourceType: r.source_type ?? null,
        targetType: r.target_type ?? null,
      })),
      total: parseInt(countRow?.total ?? '0', 10),
    };
  }

  /** All links touching a node (as source or target). */
  async forId(id: string, opts?: { relation?: LinkRelation; limit?: number }): Promise<LinkRow[]> {
    const limit = Math.min(Math.max(opts?.limit ?? 200, 1), 5000);
    const values: unknown[] = [id, limit];
    let relationClause = '';
    if (opts?.relation) {
      relationClause = 'AND l.relation = $3';
      values.push(opts.relation);
    }

    const raws = await this.rawQuery<LinkRawRow>(
      `SELECT ${SELECT_COLS}
       FROM ${this.qualifiedTable} l
       WHERE (l.source_id = $1 OR l.target_id = $1) ${relationClause}
       ORDER BY l.updated_at DESC
       LIMIT $2`,
      values
    );
    return raws.map((r) => this.mapRow(r));
  }

  /** Delete a specific edge by (source, target, relation). */
  async removeLink(sourceId: string, targetId: string, relation: LinkRelation): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM ${this.qualifiedTable}
       WHERE source_id = $1 AND target_id = $2 AND relation = $3`,
      [sourceId, targetId, relation]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Replace all outgoing links of a given relation for a source node.
   * Used by content-ref sync to align reference edges with markdown body.
   *
   * A target that is not a node, or that the type matrix does not let the
   * source link to, is skipped rather than failing the rest, the same rule
   * the doc-link trigger follows.
   */
  async replaceOutgoing(
    sourceId: string,
    relation: LinkRelation,
    targetIds: string[]
  ): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.qualifiedTable}
       WHERE source_id = $1 AND relation = $2`,
      [sourceId, relation]
    );

    for (const tid of await this.linkableTargets(sourceId, relation, targetIds)) {
      await this.insertLink(randomUUID(), sourceId, tid, relation, {});
    }
  }

  /** The `targetIds` that exist and that `sourceId` may link to by `relation`, in order. */
  private async linkableTargets(
    sourceId: string,
    relation: LinkRelation,
    targetIds: string[]
  ): Promise<string[]> {
    if (targetIds.length === 0) return [];
    const rows = await this.rawQuery<{ id: string; type: string }>(
      `SELECT id, type::text AS type FROM public.nodes WHERE id = ANY($1::text[])`,
      [[sourceId, ...targetIds]]
    );
    const typeById = new Map(rows.map((row) => [row.id, row.type]));
    const sourceType = typeById.get(sourceId);
    if (!sourceType) return [];
    return targetIds.filter((id) => {
      const targetType = typeById.get(id);
      return targetType !== undefined && isValidLinkTriple(sourceType, relation, targetType);
    });
  }

  /** Remove all links touching a node (as source or target). */
  async removeAllForId(id: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${this.qualifiedTable} WHERE source_id = $1 OR target_id = $1`,
      [id]
    );
    return result.rowCount ?? 0;
  }
}

export const Links = new LinkModelClass();
