/**
 * EmbeddingQueryService — business logic behind `routes/embeddings.ts`.
 *
 * The route file is a thin HTTP adapter (input validation + response
 * shaping); everything that touches the database or orchestrates multi-step
 * work lives here: the per-node-type storage stats.
 *
 * Distinct from `EmbeddingService` (the message-embedding facade) and the
 * `embedding/` subsystem (provider + orchestrator + settings) — this module
 * is the read/query layer used by the settings UI.
 */

import { getDb } from '@snaglet/db/db';

/**
 * Per-node-type storage footprint + embedding coverage, powering the Data &
 * Search → Storage chart. Each entry reports, for one node type:
 *   - contentBytes   the node row + its domain row (real on-disk size)
 *   - linkBytes      every link touching a node of this type — counted for
 *                    both endpoints, so a doc↔thread link adds to both. The
 *                    grand total can therefore exceed raw link bytes.
 *   - embeddingBytes the embedding rows for nodes of this type
 *   - totalCount     how many nodes of this type exist
 *   - embeddedCount  how many of them have at least one embedding row
 *
 * Sizes come from pg_column_size on the row, so embeddings (1536-dim vectors,
 * ~6KB each) realistically dominate for embedded types.
 */
export interface NodeStorageStat {
  nodeType: string;
  totalCount: number;
  embeddedCount: number;
  contentBytes: number;
  linkBytes: number;
  embeddingBytes: number;
}

interface NodeStorageStatRow {
  node_type: string;
  total_count: string;
  embedded_count: string;
  content_bytes: string;
  link_bytes: string;
  embedding_bytes: string;
}

// Domain tables whose rows share their id with public.nodes(id). Used to sum
// each node type's content footprint. `nodes` itself is added separately so
// the node row is included.
const CONTENT_TABLES = [
  'docs',
  'containers',
  'threads',
  'messages',
  'agents',
  'memories',
  'thread_summaries',
  'images',
  'tools',
] as const;

/**
 * Storage stats for every node type, ordered by total footprint descending.
 * See {@link NodeStorageStat}.
 */
export async function getStorageStats(): Promise<NodeStorageStat[]> {
  const pool = getDb();

  const contentUnion = [
    `SELECT n.type::text AS node_type, pg_column_size(n.*) AS bytes
       FROM public.nodes n`,
    ...CONTENT_TABLES.map(
      (tbl) =>
        `SELECT n.type::text AS node_type, pg_column_size(t.*) AS bytes
           FROM public.${tbl} t
           JOIN public.nodes n ON n.id = t.id`
    ),
  ].join('\n      UNION ALL\n      ');

  const { rows } = await pool.query<NodeStorageStatRow>(
    `WITH counts AS (
       SELECT type::text AS node_type, COUNT(*)::bigint AS total_count
       FROM public.nodes
       GROUP BY type
     ),
     embedded AS (
       SELECT
         n.type::text                       AS node_type,
         COUNT(DISTINCT e.node_id)::bigint  AS embedded_count,
         SUM(pg_column_size(e.*))::bigint   AS embedding_bytes
       FROM public.embeddings e
       JOIN public.nodes n ON n.id = e.node_id
       GROUP BY n.type
     ),
     -- File embeddings are content-addressed (file_embeddings): count
     -- file nodes whose content has a chunk set, and the store's real bytes
     -- (each unique content counted once, however many file rows reference it).
     file_embedded AS (
       SELECT
         'file'::text AS node_type,
         (SELECT COUNT(*)::bigint FROM public.files f
           WHERE EXISTS (
             SELECT 1 FROM public.file_embeddings fe
             WHERE fe.content_hash = f.content_hash
           ))                                              AS embedded_count,
         (SELECT COALESCE(SUM(pg_column_size(fe.*)), 0)::bigint
            FROM public.file_embeddings fe)                AS embedding_bytes
     ),
     content AS (
       SELECT node_type, SUM(bytes)::bigint AS content_bytes
       FROM (
         ${contentUnion}
       ) parts
       GROUP BY node_type
     ),
     link_endpoints AS (
       SELECT l.source_id AS node_id, pg_column_size(l.*) AS bytes FROM public.links l
       UNION ALL
       SELECT l.target_id AS node_id, pg_column_size(l.*) AS bytes FROM public.links l
     ),
     links_agg AS (
       SELECT n.type::text AS node_type, SUM(le.bytes)::bigint AS link_bytes
       FROM link_endpoints le
       JOIN public.nodes n ON n.id = le.node_id
       GROUP BY n.type
     )
     SELECT
       c.node_type,
       c.total_count::text                          AS total_count,
       (COALESCE(em.embedded_count, 0)
        + COALESCE(fem.embedded_count, 0))::text    AS embedded_count,
       COALESCE(co.content_bytes, 0)::text          AS content_bytes,
       COALESCE(la.link_bytes, 0)::text             AS link_bytes,
       (COALESCE(em.embedding_bytes, 0)
        + COALESCE(fem.embedding_bytes, 0))::text   AS embedding_bytes
     FROM counts c
     LEFT JOIN embedded      em  ON em.node_type = c.node_type
     LEFT JOIN file_embedded fem ON fem.node_type = c.node_type
     LEFT JOIN content       co  ON co.node_type = c.node_type
     LEFT JOIN links_agg     la  ON la.node_type = c.node_type
     ORDER BY
       (COALESCE(co.content_bytes, 0)
        + COALESCE(la.link_bytes, 0)
        + COALESCE(em.embedding_bytes, 0)
        + COALESCE(fem.embedding_bytes, 0)) DESC`
  );

  return rows.map((r) => ({
    nodeType: r.node_type,
    totalCount: Number(r.total_count),
    embeddedCount: Number(r.embedded_count),
    contentBytes: Number(r.content_bytes),
    linkBytes: Number(r.link_bytes),
    embeddingBytes: Number(r.embedding_bytes),
  }));
}
