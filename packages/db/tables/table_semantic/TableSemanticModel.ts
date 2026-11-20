import { getDb, transaction, type DbQueryable } from '@snaglet/db/db';
import { quoteIdentifier } from '@snaglet/db/sql-utils';
import { CUSTOM_TABLES_SCHEMA } from '@snaglet/db/tables/table_catalog';
import { vectorLiteral } from '@snaglet/shared/utils';

/** A row's vector to store: its card hash and the vector made from that card. */
export interface EntryVector {
  entryId: string;
  cardHash: string;
  vector: number[];
}

/** One nearest row: cosine distance, 0 = identical direction. */
export interface SemanticHit {
  tableId: string;
  entryId: string;
  distance: number;
}

export interface SemanticSettings {
  tableId: string;
  enabledAt: string;
  /** The row count above the cap that a person confirmed; null within the cap. */
  confirmedRows: number | null;
}

/**
 * Vector search over a custom table's rows: the per-table switch (absent row =
 * no setting yet; the server turns it on by default up to its row cap) and
 * the one-vector-per-row side table. Entries live in dynamic `user_tables.*`
 * tables, so there is no foreign key to them (deletes and the sweep remove
 * stale vectors), and there is no ANN index because searches filter by
 * `table_id`, which HNSW does not serve.
 */
export const TableSemantic = {
  async getSettings(
    tableId: string,
    runner: DbQueryable = getDb()
  ): Promise<SemanticSettings | null> {
    const { rows } = await runner.query<{
      enabled_at: string;
      confirmed_rows: number | null;
    }>(
      `SELECT to_char(enabled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS enabled_at,
              confirmed_rows
         FROM public.table_semantic_search WHERE table_id = $1`,
      [tableId]
    );
    const row = rows[0];
    return row ? { tableId, enabledAt: row.enabled_at, confirmedRows: row.confirmed_rows } : null;
  },

  /** Table ids with semantic search on, whatever their lifecycle state. */
  async listEnabled(runner: DbQueryable = getDb()): Promise<string[]> {
    const { rows } = await runner.query<{ table_id: string }>(
      'SELECT table_id FROM public.table_semantic_search ORDER BY enabled_at, table_id'
    );
    return rows.map((row) => row.table_id);
  },

  /**
   * Tables to search by meaning when none is named: semantic search on, the
   * table still active (an archived table's vectors are only swept later, and
   * would use up the nearest-neighbor budget), and, when `projectId` is given,
   * in that project.
   */
  async listSearchable(
    options: { projectId?: string } = {},
    runner: DbQueryable = getDb()
  ): Promise<string[]> {
    const params: unknown[] = [];
    let where = '';
    if (options.projectId !== undefined) {
      params.push(options.projectId);
      where = ` AND catalog.project_id = $${params.length}`;
    }
    const { rows } = await runner.query<{ table_id: string }>(
      `SELECT semantic.table_id
         FROM public.table_semantic_search AS semantic
         JOIN public.table_catalog AS catalog ON catalog.id = semantic.table_id
        WHERE catalog.origin = 'custom' AND catalog.state = 'active'${where}
        ORDER BY semantic.enabled_at, semantic.table_id`,
      params
    );
    return rows.map((row) => row.table_id);
  },

  /** The ones among `tableIds` that have it on. */
  async enabledAmong(
    tableIds: readonly string[],
    runner: DbQueryable = getDb()
  ): Promise<string[]> {
    if (!tableIds.length) return [];
    const { rows } = await runner.query<{ table_id: string }>(
      'SELECT table_id FROM public.table_semantic_search WHERE table_id = ANY($1::text[]) ORDER BY table_id',
      [[...tableIds]]
    );
    return rows.map((row) => row.table_id);
  },

  /** Turn it on (idempotent: keeps the first enabling time, updates a confirmation). */
  async enable(
    tableId: string,
    confirmedRows: number | null,
    runner: DbQueryable = getDb()
  ): Promise<void> {
    await runner.query(
      `INSERT INTO public.table_semantic_search (table_id, confirmed_rows) VALUES ($1, $2)
       ON CONFLICT (table_id) DO UPDATE SET confirmed_rows = EXCLUDED.confirmed_rows`,
      [tableId, confirmedRows]
    );
  },

  /**
   * Turn it on unless the table already has a setting: the default for a new
   * table and the boot backfill, which must never overwrite a confirmation.
   */
  async enableIfUnset(tableId: string, runner: DbQueryable = getDb()): Promise<void> {
    await runner.query(
      `INSERT INTO public.table_semantic_search (table_id) VALUES ($1)
       ON CONFLICT (table_id) DO NOTHING`,
      [tableId]
    );
  },

  /**
   * Custom tables (active or archived) with no setting: the ones the default
   * may still turn on. `tableName` is the physical name, for counting rows.
   */
  async listUnset(
    runner: DbQueryable = getDb()
  ): Promise<Array<{ tableId: string; tableName: string }>> {
    const { rows } = await runner.query<{ id: string; table_name: string }>(
      `SELECT catalog.id, catalog.table_name
         FROM public.table_catalog AS catalog
        WHERE catalog.origin = 'custom' AND catalog.state IN ('active', 'archived')
          AND NOT EXISTS (
            SELECT 1 FROM public.table_semantic_search AS semantic
             WHERE semantic.table_id = catalog.id)
        ORDER BY catalog.id`
    );
    return rows.map((row) => ({ tableId: row.id, tableName: row.table_name }));
  },

  /** Turn it off and delete the table's vectors, together. Returns how many vectors went. */
  async disable(tableId: string): Promise<number> {
    return transaction(async (tx) => {
      const removed = await tx.query(
        'DELETE FROM public.table_entry_embeddings WHERE table_id = $1',
        [tableId]
      );
      await tx.query('DELETE FROM public.table_semantic_search WHERE table_id = $1', [tableId]);
      return removed.rowCount ?? 0;
    });
  },

  async indexedCount(tableId: string, runner: DbQueryable = getDb()): Promise<number> {
    const { rows } = await runner.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.table_entry_embeddings WHERE table_id = $1',
      [tableId]
    );
    return Number(rows[0]?.n ?? 0);
  },

  /** The stored card hash of each of these rows that has a vector. */
  async hashes(
    tableId: string,
    entryIds: readonly string[],
    runner: DbQueryable = getDb()
  ): Promise<Map<string, string>> {
    if (!entryIds.length) return new Map();
    const { rows } = await runner.query<{ entry_id: string; card_hash: string }>(
      `SELECT entry_id::text AS entry_id, card_hash FROM public.table_entry_embeddings
        WHERE table_id = $1 AND entry_id = ANY($2::uuid[])`,
      [tableId, [...entryIds]]
    );
    return new Map(rows.map((row) => [row.entry_id, row.card_hash]));
  },

  /** Store (or replace) these rows' vectors. */
  async upsert(
    tableId: string,
    modelId: string,
    vectors: readonly EntryVector[],
    runner: DbQueryable = getDb()
  ): Promise<void> {
    for (const item of vectors)
      await runner.query(
        `INSERT INTO public.table_entry_embeddings (table_id, entry_id, model_id, card_hash, vector)
         VALUES ($1, $2, $3, $4, $5::vector)
         ON CONFLICT (table_id, entry_id) DO UPDATE
           SET model_id = EXCLUDED.model_id, card_hash = EXCLUDED.card_hash,
               vector = EXCLUDED.vector, updated_at = now()`,
        [tableId, item.entryId, modelId, item.cardHash, vectorLiteral(item.vector)]
      );
  },

  /** Delete these rows' vectors (a deleted row, or a row whose card is now empty). */
  async deleteEntries(
    tableId: string,
    entryIds: readonly string[],
    runner: DbQueryable = getDb()
  ): Promise<number> {
    if (!entryIds.length) return 0;
    const result = await runner.query(
      'DELETE FROM public.table_entry_embeddings WHERE table_id = $1 AND entry_id = ANY($2::uuid[])',
      [tableId, [...entryIds]]
    );
    return result.rowCount ?? 0;
  },

  /**
   * Delete the table's vectors whose row no longer exists in its physical
   * table (an undo, a SQL delete). Returns how many went.
   */
  async deleteOrphans(
    tableId: string,
    physicalTable: string,
    runner: DbQueryable = getDb()
  ): Promise<number> {
    const result = await runner.query(
      `DELETE FROM public.table_entry_embeddings AS vec
        WHERE vec.table_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM ONLY ${quoteIdentifier(CUSTOM_TABLES_SCHEMA)}.${quoteIdentifier(physicalTable)} AS entry
             WHERE entry.id = vec.entry_id)`,
      [tableId]
    );
    return result.rowCount ?? 0;
  },

  /** The rows of these tables nearest the query vector, nearest first. */
  async nearest(
    tableIds: readonly string[],
    modelId: string,
    queryVector: readonly number[],
    limit: number,
    runner: DbQueryable = getDb()
  ): Promise<SemanticHit[]> {
    if (!tableIds.length) return [];
    const { rows } = await runner.query<{ table_id: string; entry_id: string; distance: number }>(
      `SELECT table_id, entry_id::text AS entry_id, (vector <=> $1::vector)::float8 AS distance
         FROM public.table_entry_embeddings
        WHERE table_id = ANY($2::text[]) AND model_id = $3
        ORDER BY vector <=> $1::vector, entry_id
        LIMIT $4`,
      [vectorLiteral([...queryVector]), [...tableIds], modelId, limit]
    );
    return rows.map((row) => ({
      tableId: row.table_id,
      entryId: row.entry_id,
      distance: Number(row.distance),
    }));
  },
};
