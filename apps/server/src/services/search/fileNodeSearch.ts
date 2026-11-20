/**
 * fileNodeSearch — semantic (vector) search over indexed project files for the
 * palette and the semantic_file_search tool.
 *
 * File embeddings are content-addressed (public.file_embeddings, keyed
 * content_hash + model): the nearest-neighbor query runs
 * over unique CONTENTS, then joins public.files by content_hash to surface
 * every path/project referencing that content. Results are therefore one hit
 * per unique content — a file linked by N projects (worktrees, overlapping
 * folders) fills one slot listing all N paths, instead of N duplicate hits.
 *
 * Kept separate from the per-kind node-search machinery (nodeSearch/
 * ftsSearchNodes) on purpose — that path hardcodes FTS-capable node kinds.
 */

import path from 'node:path';
import { getDb } from '@snaglet/db';
import { VECTOR_SEARCH_CANDIDATE_POOL } from '@snaglet/shared/constants';
import { vectorLiteral } from '@snaglet/shared/utils';
import { createQueryEmbedding } from './nodeSearch';

/** One path referencing a matched content (a files-table row). */
interface FileNodePathRef {
  nodeId: string;
  projectId: string;
  relativePath: string;
  /** Absolute on-disk path (project folder + relative path). */
  absolutePath: string;
}

export interface FileNodePaletteHit {
  nodeId: string;
  relativePath: string;
  /** Absolute on-disk path (project folder + relative path) — what a file chip
   * references so it previews / resolves correctly, not the project-relative path. */
  absolutePath: string;
  projectId: string;
  sizeBytes: number;
  updatedAt: string;
  /** Cosine similarity (1 − distance); higher is closer. */
  score: number;
  /** Content-addressing key the hit was matched on. */
  contentHash: string;
  /** Every in-scope path referencing this content (the primary fields above
   * mirror paths[0]). Length > 1 means the same bytes are linked by multiple
   * projects/paths — shared, not re-indexed. */
  paths: FileNodePathRef[];
}

function normalizeRelativeFilePath(input: string): string {
  return input
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

export interface SearchFileNodesOptions {
  projectId?: string | null;
  relativePathPrefix?: string | null;
}

interface FileSearchRawRow {
  content_hash: string;
  distance: number;
  node_id: string;
  relative_path: string;
  folder_path: string | null;
  project_id: string;
  size_bytes: string | number;
  updated_at: string;
}

function toAbsolute(folderPath: string | null, relativePath: string): string {
  return folderPath ? path.join(folderPath, relativePath) : relativePath;
}

/**
 * Resolve file node IDs to their canonical on-disk paths for callers that must
 * preserve node-level exclusions while operating on the filesystem. Missing
 * projects are intentionally omitted: without a real project folder there is
 * no authoritative absolute path to exclude.
 */
export async function resolveAbsoluteFilePathsByNodeIds(
  nodeIds: Iterable<string>
): Promise<Set<string>> {
  const ids = [...new Set([...nodeIds].map((id) => id.trim()).filter(Boolean))].sort();
  if (ids.length === 0) return new Set();

  const { rows } = await getDb().query<{
    folder_path: string | null;
    relative_path: string;
  }>(
    `SELECT p.folder_path, f.relative_path
       FROM public.files f
       LEFT JOIN public.containers p ON p.id = f.project_id AND p.category = 'project'
      WHERE f.id = ANY($1::text[])
      ORDER BY f.id ASC`,
    [ids]
  );

  const resolved = new Set<string>();
  for (const row of rows) {
    if (!row.folder_path || path.isAbsolute(row.relative_path)) continue;
    const projectRoot = path.resolve(row.folder_path);
    const candidate = path.resolve(projectRoot, row.relative_path);
    const containedRelative = path.relative(projectRoot, candidate);
    if (
      !containedRelative ||
      containedRelative === '..' ||
      containedRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(containedRelative)
    ) {
      continue;
    }
    resolved.add(candidate);
  }
  return resolved;
}

/**
 * Vector-search indexed files by content. Returns [] when the query is empty
 * or the embedding provider is unavailable (files have no lexical fallback).
 * One hit per unique content (closest first), each listing every in-scope
 * path that references it.
 */
export async function searchFileNodes(
  query: string,
  limit = 8,
  options: SearchFileNodesOptions = {}
): Promise<FileNodePaletteHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const embedding = await createQueryEmbedding(trimmed);
  if (!embedding) return [];

  const params: unknown[] = [vectorLiteral(embedding.vector), embedding.modelId];
  // Applied to the files join OUTSIDE the ANN pool — predicates inside the
  // ordered scan would stop it being a bare index scan (HNSW contract).
  const fileFilters: string[] = [];

  if (options.projectId) {
    params.push(options.projectId);
    fileFilters.push(`AND f.project_id = $${params.length}`);
  }

  const relativePathPrefix = normalizeRelativeFilePath(options.relativePathPrefix ?? '');
  if (relativePathPrefix) {
    params.push(`${relativePathPrefix}/%`);
    fileFilters.push(`AND f.relative_path LIKE $${params.length}`);
  }

  const rows = await getDb().query<FileSearchRawRow>(
    `
    WITH candidates AS (
      -- HNSW-servable shape: bare ordered scan + LIMIT. The
      -- scan is over unique contents, so the pool can't be flooded by many
      -- references to the same bytes.
      SELECT content_hash, vector <=> $1::vector AS distance
      FROM public.file_embeddings
      WHERE model_id = $2
      ORDER BY vector <=> $1::vector
      LIMIT ${VECTOR_SEARCH_CANDIDATE_POOL}
    ),
    best AS (
      -- Closest chunk per content so each unique content occupies one slot.
      SELECT content_hash, MIN(distance) AS distance
      FROM candidates
      GROUP BY content_hash
    )
    SELECT b.content_hash, b.distance,
           f.id AS node_id, f.relative_path, p.folder_path, f.project_id, f.size_bytes,
           n.updated_at
    FROM best b
    JOIN public.files f ON f.content_hash = b.content_hash ${fileFilters.join(' ')}
    JOIN public.nodes n ON n.id = f.id AND n.archived = false
    LEFT JOIN public.containers p ON p.id = f.project_id AND p.category = 'project'
    ORDER BY b.distance ASC, f.project_id ASC, f.relative_path ASC
    `,
    params
  );

  // Group reference rows by content: one hit per unique content, first
  // in-scope path as the primary, all paths listed.
  const hits: FileNodePaletteHit[] = [];
  const byHash = new Map<string, FileNodePaletteHit>();
  for (const row of rows.rows) {
    const ref: FileNodePathRef = {
      nodeId: row.node_id,
      projectId: row.project_id,
      relativePath: row.relative_path,
      absolutePath: toAbsolute(row.folder_path, row.relative_path),
    };
    const existing = byHash.get(row.content_hash);
    if (existing) {
      existing.paths.push(ref);
      continue;
    }
    if (hits.length >= limit) continue; // cap unique contents, not reference rows
    const hit: FileNodePaletteHit = {
      nodeId: ref.nodeId,
      relativePath: ref.relativePath,
      absolutePath: ref.absolutePath,
      projectId: ref.projectId,
      sizeBytes: Number(row.size_bytes),
      updatedAt: row.updated_at,
      score: 1 - Number(row.distance),
      contentHash: row.content_hash,
      paths: [ref],
    };
    byHash.set(row.content_hash, hit);
    hits.push(hit);
  }
  return hits;
}

/**
 * Resolve an exact project-relative file path to a file node. Returns null when
 * the path is missing or ambiguous across projects; callers that only have a
 * path should not silently bind to the wrong project.
 */
export async function resolveFileNodeByPath(inputPath: string): Promise<FileNodePaletteHit | null> {
  const relativePath = normalizeRelativeFilePath(inputPath);
  if (!relativePath) return null;

  const { rows } = await getDb().query<{
    node_id: string;
    relative_path: string;
    content_hash: string;
    folder_path: string | null;
    project_id: string;
    size_bytes: string | number;
    updated_at: string;
  }>(
    `
    SELECT f.id AS node_id, f.relative_path, f.content_hash, p.folder_path, f.project_id, f.size_bytes, n.updated_at
    FROM public.files f
    JOIN public.nodes n ON n.id = f.id AND n.archived = false
    LEFT JOIN public.containers p ON p.id = f.project_id AND p.category = 'project'
    WHERE f.relative_path = $1
    ORDER BY n.updated_at DESC
    LIMIT 2
    `,
    [relativePath]
  );

  if (rows.length !== 1) return null;
  const row = rows[0];
  const ref: FileNodePathRef = {
    nodeId: row.node_id,
    projectId: row.project_id,
    relativePath: row.relative_path,
    absolutePath: toAbsolute(row.folder_path, row.relative_path),
  };
  return {
    nodeId: ref.nodeId,
    relativePath: ref.relativePath,
    absolutePath: ref.absolutePath,
    projectId: ref.projectId,
    sizeBytes: Number(row.size_bytes),
    updatedAt: row.updated_at,
    score: 1,
    contentHash: row.content_hash,
    paths: [ref],
  };
}
