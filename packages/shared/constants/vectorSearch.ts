/**
 * Vector-search tuning shared by every `<=>` query site (apps/server search
 * services and packages/db models).
 *
 * The HNSW index only serves the `ORDER BY vector <=> $q LIMIT k` shape, and
 * an HNSW ordered scan yields at most `hnsw.ef_search` rows. The initial schema
 * sets the database default to 100 — every candidate pool below must stay at
 * or under that ceiling, or results silently truncate.
 */

/**
 * Rows fetched by the inner ANN scan before dedup (best-chunk-per-node) and
 * scope/kind filtering. Bigger pools survive more post-filtering but cost
 * more index traversal; 100 matches the `hnsw.ef_search` database default.
 */
export const VECTOR_SEARCH_CANDIDATE_POOL = 100;
