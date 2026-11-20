/**
 * clearEmbeddings — the only ordinary UI path that deletes a project's stored
 * embeddings, split into an honest preview and a confirmed clear.
 *
 * Honesty contract for the preview: file embeddings are content-addressed
 * (keyed by content hash) and may be referenced by several projects' file
 * rows. Deleting this project's rows only orphans the chunk sets no other
 * project references — those are what the GC reaps and the only bytes that
 * are genuinely reclaimed. `linkedBytes` (everything referenced) and
 * `reclaimableBytes` (what actually goes away) are computed separately so the
 * confirmation modal can never present shared storage as freed space.
 *
 * Bytes are heap-tuple sizes (`pg_column_size`) of the chunk rows — the
 * stored vector data inside Snaglet's local database. Deliberately not a promise
 * about on-disk file shrinkage (Postgres reuses freed pages; files shrink
 * only under vacuum), which is why UI copy says "from Snaglet's local database".
 *
 * The confirmed clear:
 *   - deletes this project's file rows (node spine cascade), dropping its
 *     embedding references;
 *   - garbage-collects chunk sets nothing references anymore;
 *   - touches nothing else: no source files, no snaglet.config.json, no DB worker
 *     mirror, no watcher state. If background indexing is enabled it will
 *     legitimately re-index the folder — the modal says so out loud.
 */

import { getDb } from '@snaglet/db';
import { Projects } from '@snaglet/db/tables/projects';
import { Files } from '@snaglet/db/tables/files';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import type {
  ProjectEmbeddingsClearPreview,
  ProjectEmbeddingsClearResult,
} from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import { gcOrphanFileEmbeddings } from '@server/services/embedding/fileContentEmbedding';
import { emitFileEmbeddingCoverageChanged } from '@server/realtime/surfaces/fileEmbeddings';
import { endExclusiveOp, tryBeginExclusiveOp } from './projectIndexingStatus';

/** Compute the confirmation numbers for clearing one project's embeddings. */
export async function getProjectEmbeddingsClearPreview(
  projectId: string
): Promise<ProjectEmbeddingsClearPreview> {
  const { rows } = await getDb().query<{
    file_count: string;
    unique_contents: string;
    exclusive_contents: string;
    vector_chunks: string;
    linked_bytes: string;
    reclaimable_bytes: string;
  }>(
    `
      WITH proj_hashes AS (
        SELECT DISTINCT f.content_hash
        FROM public.files f
        WHERE f.project_id = $1
      ),
      refs AS (
        SELECT
          p.content_hash,
          EXISTS (
            SELECT 1 FROM public.files o
            WHERE o.content_hash = p.content_hash AND o.project_id <> $1
          ) AS shared
        FROM proj_hashes p
      ),
      chunks AS (
        SELECT r.content_hash, r.shared, pg_column_size(e.*) AS bytes
        FROM refs r
        JOIN public.file_embeddings e ON e.content_hash = r.content_hash
      )
      SELECT
        (SELECT COUNT(*) FROM public.files WHERE project_id = $1)::text AS file_count,
        (SELECT COUNT(*) FROM refs)::text                               AS unique_contents,
        (SELECT COUNT(*) FROM refs WHERE NOT shared)::text              AS exclusive_contents,
        (SELECT COUNT(*) FROM chunks)::text                             AS vector_chunks,
        COALESCE((SELECT SUM(bytes) FROM chunks), 0)::text              AS linked_bytes,
        COALESCE((SELECT SUM(bytes) FROM chunks WHERE NOT shared), 0)::text
                                                                        AS reclaimable_bytes
    `,
    [projectId]
  );
  const row = rows[0];
  const uniqueContents = Number(row?.unique_contents ?? 0);
  const exclusiveContents = Number(row?.exclusive_contents ?? 0);
  return {
    fileCount: Number(row?.file_count ?? 0),
    uniqueContents,
    exclusiveContents,
    sharedContents: uniqueContents - exclusiveContents,
    vectorChunks: Number(row?.vector_chunks ?? 0),
    linkedBytes: Number(row?.linked_bytes ?? 0),
    reclaimableBytes: Number(row?.reclaimable_bytes ?? 0),
  };
}

/**
 * Confirmed clear: delete this project's indexed file rows and GC the chunk
 * sets that orphans. Throws 404 when the project doesn't exist and 409 while
 * a backfill (or another clear) holds the project. Leaves the worker
 * preference, snaglet.config.json, the watcher, and all source files untouched.
 */
export async function clearProjectEmbeddings(
  projectId: string
): Promise<ProjectEmbeddingsClearResult> {
  const project = await Projects.findById(projectId);
  if (!project) {
    throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  if (!tryBeginExclusiveOp(projectId, 'clear')) {
    throw new AppError(
      'a backfill or clear is already running for this project',
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  }
  try {
    const removedFiles = await Files.deleteByProject(projectId);
    const removedChunks = await gcOrphanFileEmbeddings();
    if (removedFiles > 0) emitFileEmbeddingCoverageChanged();
    logger.info(
      `[fileIndexing] cleared embeddings for ${projectId}: ` +
        `${removedFiles} file row(s) removed, ${removedChunks} orphaned chunk row(s) GC'd`
    );
    endExclusiveOp(projectId);
    return { removedFiles, removedChunks };
  } catch (err) {
    endExclusiveOp(projectId, getErrorMessage(err));
    throw err;
  }
}
