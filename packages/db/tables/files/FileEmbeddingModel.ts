/**
 * FileEmbeddingModel — content-addressed file embeddings on
 * public.file_embeddings.
 *
 * One chunk set per unique file content per model: rows are keyed
 * (content_hash, model_id, chunk_index), where content_hash is the raw-body
 * sha256 stored on public.files.content_hash. File rows reference a chunk set
 * by hash and never own it, so any number of projects/worktrees linking the
 * same bytes share one embedding, and re-indexing unchanged content costs no
 * embedding compute. The HNSW index serves only the
 * `ORDER BY vector <=> $q LIMIT k` shape.
 *
 * Lifecycle: deleting file rows drops references only. `deleteOrphans` is the
 * GC pass that removes unreferenced chunk sets; it runs after index purges
 * and reindex sweeps.
 */

import { randomUUID } from 'crypto';
import { Model } from '@snaglet/db/Model';
import { transaction } from '@snaglet/db/db';
import { safeJsonParse, vectorLiteral } from '@snaglet/shared/utils';

export interface FileEmbeddingRow {
  id: string;
  contentHash: string;
  modelId: string;
  vector: number[];
  chunkIndex: number;
  chunkStart: number | null;
  chunkEnd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileEmbeddingChunkInput {
  vector: number[];
  chunkIndex: number;
  chunkStart: number;
  chunkEnd: number;
}

interface FileEmbeddingRawRow {
  id: string;
  content_hash: string;
  model_id: string;
  vector: string;
  chunk_index: number;
  chunk_start: number | null;
  chunk_end: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = `e.id, e.content_hash, e.model_id, e.vector::text AS vector,
                     e.chunk_index, e.chunk_start, e.chunk_end,
                     e.created_at, e.updated_at`;

class FileEmbeddingModelClass extends Model<FileEmbeddingRow> {
  constructor() {
    super({ table: 'file_embeddings', primaryKey: 'id' });
  }

  private mapRow(raw: FileEmbeddingRawRow): FileEmbeddingRow {
    // A corrupt vector cell must not throw and kill the whole query. Callers
    // only do presence checks on mapped rows (similarity math runs in SQL
    // over the pgvector column), so an empty vector is a safe degrade.
    // Parse success alone is not enough: a NULL cell parses to `null` and a
    // truncated one can parse to a scalar, both of which would then reach
    // `.length` — the shape check is what keeps one bad row from throwing.
    const parsed = safeJsonParse<number[] | null>(raw.vector, null);
    const vector = Array.isArray(parsed) ? parsed : [];
    if (vector.length === 0) {
      console.warn(`FileEmbeddingModel: unparseable vector on file_embeddings row ${raw.id}`);
    }
    return {
      id: raw.id,
      contentHash: raw.content_hash,
      modelId: raw.model_id,
      vector,
      chunkIndex: raw.chunk_index ?? 0,
      chunkStart: raw.chunk_start,
      chunkEnd: raw.chunk_end,
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
    };
  }

  /** Zero-compute check: is (contentHash, modelId) already embedded? */
  async existsByHashModel(contentHash: string, modelId: string): Promise<boolean> {
    const row = await this.rawQueryOne<{ present: boolean }>(
      `SELECT TRUE AS present FROM public.file_embeddings e
       WHERE e.content_hash = $1 AND e.model_id = $2 LIMIT 1`,
      [contentHash, modelId]
    );
    return row?.present === true;
  }

  /** All chunk rows for (contentHash[, modelId]), in chunk order. */
  async listByHash(contentHash: string, modelId?: string): Promise<FileEmbeddingRow[]> {
    const where = ['e.content_hash = $1'];
    const values: unknown[] = [contentHash];
    if (modelId) {
      where.push(`e.model_id = $${values.length + 1}`);
      values.push(modelId);
    }
    const rows = await this.rawQuery<FileEmbeddingRawRow>(
      `SELECT ${SELECT_COLS}
       FROM public.file_embeddings e
       WHERE ${where.join(' AND ')}
       ORDER BY e.chunk_index ASC`,
      values
    );
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Atomically replace the chunk set for (contentHash, modelId). The whole set
   * commits or none of it does, so search never sees a half-written content.
   */
  async replaceChunks(
    contentHash: string,
    modelId: string,
    chunks: FileEmbeddingChunkInput[]
  ): Promise<FileEmbeddingRow[]> {
    if (chunks.length === 0) {
      throw new Error('FileEmbeddingModel.replaceChunks: chunks must be non-empty');
    }
    const ids = chunks.map(() => randomUUID());
    await transaction(async (client) => {
      // Serialize concurrent writers of the same (content_hash, model_id): the
      // second waits for the first to commit, so its DELETE sees the committed
      // chunks and its INSERTs can't hit the unique key. A hash
      // collision only serializes two unrelated writes, which is harmless.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))`, [
        contentHash,
        modelId,
      ]);
      await client.query(
        `DELETE FROM public.file_embeddings WHERE content_hash = $1 AND model_id = $2`,
        [contentHash, modelId]
      );
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await client.query(
          `INSERT INTO public.file_embeddings
             (id, content_hash, model_id, vector, chunk_index, chunk_start, chunk_end)
           VALUES ($1, $2, $3, $4::vector, $5, $6, $7)`,
          [
            ids[i],
            contentHash,
            modelId,
            vectorLiteral(c.vector),
            c.chunkIndex,
            c.chunkStart,
            c.chunkEnd,
          ]
        );
      }
    });
    return this.listByHash(contentHash, modelId);
  }

  /**
   * GC pass: delete every chunk set whose content_hash no file row
   * references. Returns the number of chunk rows removed.
   */
  async deleteOrphans(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM public.file_embeddings e
       WHERE NOT EXISTS (
         SELECT 1 FROM public.files f WHERE f.content_hash = e.content_hash
       )`
    );
    return result.rowCount ?? 0;
  }

  async deleteByModelId(modelId: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM public.file_embeddings WHERE model_id = $1`, [
      modelId,
    ]);
    return result.rowCount ?? 0;
  }

  async deleteAll(): Promise<number> {
    const result = await this.pool.query(`DELETE FROM public.file_embeddings`);
    return result.rowCount ?? 0;
  }

  /** Chunk-row count, optionally scoped to one model. */
  async countRows(modelId?: string): Promise<number> {
    const row = await this.rawQueryOne<{ count: string }>(
      modelId
        ? `SELECT COUNT(*)::text AS count FROM public.file_embeddings WHERE model_id = $1`
        : `SELECT COUNT(*)::text AS count FROM public.file_embeddings`,
      modelId ? [modelId] : []
    );
    return Number(row?.count ?? 0);
  }
}

export const FileEmbeddings = new FileEmbeddingModelClass();
