/**
 * EmbeddingModel — vector embeddings on public.embeddings.
 *
 * Embeddings describe a node (node_id FKs into public.nodes) but are not
 * nodes themselves; timestamps live on this table. Long content is stored as
 * one row per chunk per (node, model), all sharing the full source content's
 * hash, and vector search aggregates best-chunk-per-node.
 *
 * Skip-re-embed: callers use findByNodeModelHash(nodeId, modelId, hash) to
 * detect a no-op before generating a new vector, backed by the unique index
 * on (node_id, model_id, content_hash, chunk_index).
 *
 * The HNSW index (vector_cosine_ops over vector(768)) serves only the
 * `ORDER BY vector <=> $q LIMIT k` shape, so every search site fetches a
 * small ordered candidate pool first and filters over it.
 */

import { randomUUID } from 'crypto';
import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { safeJsonParse, vectorLiteral } from '@snaglet/shared/utils';

export interface EmbeddingRow {
  id: string;
  nodeId: string;
  modelId: string;
  vector: number[];
  contentHash: string | null;
  chunkIndex: number;
  chunkStart: number | null;
  chunkEnd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEmbeddingInput {
  id?: string;
  nodeId: string;
  modelId: string;
  vector: number[];
  contentHash?: string | null;
}

export interface EmbeddingChunkInput {
  vector: number[];
  chunkIndex: number;
  chunkStart: number;
  chunkEnd: number;
}

export interface SearchSimilarHit {
  nodeId: string;
  distance: number;
}

interface EmbeddingRawRow {
  id: string;
  node_id: string;
  model_id: string;
  vector: string;
  content_hash: string | null;
  chunk_index: number;
  chunk_start: number | null;
  chunk_end: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = `e.id, e.node_id, e.model_id, e.vector::text AS vector,
                     e.content_hash, e.chunk_index, e.chunk_start, e.chunk_end,
                     e.created_at, e.updated_at`;

class EmbeddingModelClass extends Model<EmbeddingRow, CreateEmbeddingInput> {
  constructor() {
    super({ table: 'embeddings', primaryKey: 'id' });
  }

  private mapRow(raw: EmbeddingRawRow): EmbeddingRow {
    // A corrupt vector cell must not throw and kill the whole query. Callers
    // only do presence/hash checks on mapped rows (similarity math runs in
    // SQL over the pgvector column), so an empty vector is a safe degrade.
    // Parse success alone is not enough: a NULL cell parses to `null` and a
    // truncated one can parse to a scalar, both of which would then reach
    // `.length` — the shape check is what keeps one bad row from throwing.
    const parsed = safeJsonParse<number[] | null>(raw.vector, null);
    const vector = Array.isArray(parsed) ? parsed : [];
    if (vector.length === 0) {
      console.warn(`EmbeddingModel: unparseable vector on embeddings row ${raw.id}`);
    }
    return {
      id: raw.id,
      nodeId: raw.node_id,
      modelId: raw.model_id,
      vector,
      contentHash: raw.content_hash,
      chunkIndex: raw.chunk_index ?? 0,
      chunkStart: raw.chunk_start,
      chunkEnd: raw.chunk_end,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  /**
   * Create an embedding for (nodeId, modelId). Replaces any prior embedding
   * for that (nodeId, modelId) pair so the table stays "one current body
   * embedding per (node, model)".
   */
  async create(input: CreateEmbeddingInput): Promise<EmbeddingRow> {
    const newId = input.id ?? randomUUID();
    await transaction(async (client) => {
      await client.query(`DELETE FROM public.embeddings WHERE node_id = $1 AND model_id = $2`, [
        input.nodeId,
        input.modelId,
      ]);

      await client.query(
        `INSERT INTO public.embeddings (id, node_id, model_id, vector, content_hash)
         VALUES ($1, $2, $3, $4::vector, $5)`,
        [newId, input.nodeId, input.modelId, vectorLiteral(input.vector), input.contentHash ?? null]
      );
    });

    const created = await this.findById(newId);
    if (!created) {
      throw new Error(`EmbeddingModel.create: row ${newId} not found after insert`);
    }
    return created;
  }

  /** Fetch a single embedding by id. */
  override async findById(id: string): Promise<EmbeddingRow | null> {
    const row = await this.rawQueryOne<EmbeddingRawRow>(
      `SELECT ${SELECT_COLS}
       FROM public.embeddings e
       WHERE e.id = $1 LIMIT 1`,
      [id]
    );
    return row ? this.mapRow(row) : null;
  }

  /** Delete an embedding by id. */
  override async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM public.embeddings WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Paginated list across all embeddings. */
  override async list(opts?: { limit?: number; offset?: number }): Promise<EmbeddingRow[]> {
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const rows = await this.rawQuery<EmbeddingRawRow>(
      `SELECT ${SELECT_COLS}
       FROM public.embeddings e
       ORDER BY e.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows.map((r) => this.mapRow(r));
  }

  /** List embeddings for a node, optionally filtered by model_id. */
  async listByNode(nodeId: string, modelId?: string): Promise<EmbeddingRow[]> {
    const where = ['e.node_id = $1'];
    const values: unknown[] = [nodeId];
    if (modelId) {
      where.push(`e.model_id = $${values.length + 1}`);
      values.push(modelId);
    }
    const rows = await this.rawQuery<EmbeddingRawRow>(
      `SELECT ${SELECT_COLS}
       FROM public.embeddings e
       WHERE ${where.join(' AND ')}
       ORDER BY e.updated_at DESC`,
      values
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Atomically replace the body chunk set for (nodeId, modelId): deletes any
   * prior body rows for the pair and inserts one row per chunk, all sharing
   * the full source content's hash. Used by the orchestrator when content
   * exceeds the model's context window — the whole set commits or none of
   * it does, so search never sees a half-written document.
   */
  async replaceChunks(
    nodeId: string,
    modelId: string,
    contentHash: string,
    chunks: EmbeddingChunkInput[],
    options?: { expectedNodeUpdatedAt?: string }
  ): Promise<EmbeddingRow[] | null> {
    if (chunks.length === 0) {
      throw new Error('EmbeddingModel.replaceChunks: chunks must be non-empty');
    }
    const ids = chunks.map(() => randomUUID());
    const applied = await transaction(async (client) => {
      // Always lock the source node before replacing its body chunk set.
      // Startup maintenance and the periodic worker can independently select
      // the same missing node. Without this lock both transactions can finish
      // their DELETE before either INSERT, and one then loses the unique-key
      // race on (node, model, hash, chunk). The node lock serializes every
      // body replacement even when the caller has no source timestamp.
      //
      // When a timestamp is supplied, the same locked read also prevents slow
      // provider inference from resurrecting vectors for content that changed
      // while inference was in flight.
      const current = await client.query<{ source_unchanged: boolean }>(
        `SELECT ($2::timestamptz IS NULL OR updated_at = $2::timestamptz) AS source_unchanged
           FROM public.nodes
          WHERE id = $1
          FOR UPDATE`,
        [nodeId, options?.expectedNodeUpdatedAt ?? null]
      );
      if (!current.rowCount || !current.rows[0]?.source_unchanged) return false;

      await client.query(`DELETE FROM public.embeddings WHERE node_id = $1 AND model_id = $2`, [
        nodeId,
        modelId,
      ]);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await client.query(
          `INSERT INTO public.embeddings
             (id, node_id, model_id, vector, content_hash, chunk_index, chunk_start, chunk_end)
           VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8)`,
          [
            ids[i],
            nodeId,
            modelId,
            vectorLiteral(c.vector),
            contentHash,
            c.chunkIndex,
            c.chunkStart,
            c.chunkEnd,
          ]
        );
      }
      return true;
    });
    if (!applied) return null;
    return this.listByNode(nodeId, modelId);
  }

  /**
   * Skip-re-embed lookup. Returns the existing row if
   * (nodeId, modelId, contentHash) already exists.
   */
  async findByNodeModelHash(
    nodeId: string,
    modelId: string,
    contentHash: string
  ): Promise<EmbeddingRow | null> {
    const row = await this.rawQueryOne<EmbeddingRawRow>(
      `SELECT ${SELECT_COLS}
       FROM public.embeddings e
       WHERE e.node_id = $1 AND e.model_id = $2 AND e.content_hash = $3
       LIMIT 1`,
      [nodeId, modelId, contentHash]
    );
    return row ? this.mapRow(row) : null;
  }

  /** Delete all embeddings for a node id (all models). */
  async deleteByNodeId(nodeId: string): Promise<void> {
    await this.pool.query(`DELETE FROM public.embeddings WHERE node_id = $1`, [nodeId]);
  }

  async deleteByModelId(modelId: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM public.embeddings WHERE model_id = $1`, [
      modelId,
    ]);
    return result.rowCount ?? 0;
  }

  /** Delete all embeddings whose node is of the given type (e.g. 'file'). */
  async deleteByNodeType(nodeType: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM public.embeddings e
       USING public.nodes n
       WHERE n.id = e.node_id AND n.type::text = $1`,
      [nodeType]
    );
    return result.rowCount ?? 0;
  }

  async deleteAll(): Promise<number> {
    const result = await this.pool.query(`DELETE FROM public.embeddings`);
    return result.rowCount ?? 0;
  }

  /**
   * Bump `updated_at` for a node's embedding rows under a given model. Used by
   * the staleness sweep: when content is unchanged the embed is skipped, but we
   * still touch the row so `updated_at >= node.updated_at` and the node stops
   * being re-flagged as stale on every tick.
   */
  async touchByNodeModel(nodeId: string, modelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE public.embeddings SET updated_at = now() WHERE node_id = $1 AND model_id = $2`,
      [nodeId, modelId]
    );
  }

  /**
   * Cosine nearest-neighbor search filtered by model. Returns
   * { nodeId, distance } ordered by distance ASC (closer first).
   * Chunked nodes are aggregated best-chunk-wins (MIN distance), so a
   * node appears at most once regardless of how many chunks it has.
   *
   * Shape note: the inner ordered scan + LIMIT is what the HNSW index can
   * serve (an aggregate over the whole table forces a seq scan). Dedup runs
   * over that small pool. The pool is capped by `hnsw.ef_search` (database
   * default 100) — an HNSW scan yields at most that many
   * rows, so limits beyond the pool cannot be honored exactly.
   */
  async searchSimilar(
    queryVector: number[],
    modelId: string,
    limit = 10
  ): Promise<SearchSimilarHit[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), 100);
    // Aggregation rule: MIN(distance) GROUP BY node_id is best-of-per-node:
    // a node with several fresh chunks contributes at most one row to the
    // result (whichever is closer), never a combined/summed advantage over a
    // node with fewer chunks.
    const rows = await this.rawQuery<{ node_id: string; distance: number }>(
      `WITH candidates AS (
         SELECT node_id, vector <=> $1::vector AS distance
         FROM public.embeddings
         WHERE model_id = $2
         ORDER BY vector <=> $1::vector
         LIMIT 100
       )
       SELECT node_id, MIN(distance) AS distance
       FROM candidates
       GROUP BY node_id
       ORDER BY distance
       LIMIT $3`,
      [vectorLiteral(queryVector), modelId, cappedLimit]
    );
    return rows.map((r) => ({ nodeId: r.node_id, distance: Number(r.distance) }));
  }
}

export const Embeddings = new EmbeddingModelClass();
