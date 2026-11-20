import { getDb } from '@snaglet/db';
import { Models } from '@snaglet/db/tables/models';
import { getFileSearchScope } from '@server/services/fileIndexing';
import { embeddingSettings } from './EmbeddingSettings';

export interface ProjectFileEmbeddingCoverage {
  embeddedFiles: number;
  totalFiles: number;
}

/**
 * Count file-row coverage for a project under the active embedding model.
 *
 * The numerator counts FILES, not unique content hashes: if two paths contain
 * the same already-embedded bytes, both files are covered. Satellite projects
 * read from their owner's index and are narrowed to the satellite subtree,
 * matching the semantic file-search scope. `relativePathPrefix`, when present,
 * is relative to the REQUESTED project's folder (not the indexing owner's
 * folder); it is appended once after the ownership redirect. Thus an owner
 * subpath is `src`, while a satellite rooted at owner/apps/server with requested
 * subpath `src` becomes `apps/server/src`.
 */
export async function getProjectFileEmbeddingCoverage(
  projectId: string,
  relativePathPrefix?: string | null
): Promise<ProjectFileEmbeddingCoverage> {
  const active = await embeddingSettings.getActiveModel();
  const model = await Models.findByProviderAndModelId(active.providerId, active.modelId);
  const scope = getFileSearchScope(projectId) ?? { projectId, pathPrefix: '' };
  const values: unknown[] = [scope.projectId, model?.id ?? null];
  let prefixClause = '';
  const normalizedRequestedPrefix = (relativePathPrefix ?? '')
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const effectivePrefix = [scope.pathPrefix, normalizedRequestedPrefix].filter(Boolean).join('/');
  if (effectivePrefix) {
    values.push(effectivePrefix);
    const prefixParam = values.length;
    prefixClause = `AND LEFT(f.relative_path, LENGTH($${prefixParam}::text) + 1)
                      = $${prefixParam}::text || '/'`;
  }

  const { rows } = await getDb().query<{ embedded_files: string; total_files: string }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE $2::text IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM public.file_embeddings fe
             WHERE fe.content_hash = f.content_hash
               AND fe.model_id = $2
           )
       )::text AS embedded_files,
       COUNT(*)::text AS total_files
     FROM public.files f
     JOIN public.nodes n ON n.id = f.id AND n.archived = false
     WHERE f.project_id = $1
       ${prefixClause}`,
    values
  );

  return {
    embeddedFiles: Number(rows[0]?.embedded_files ?? 0),
    totalFiles: Number(rows[0]?.total_files ?? 0),
  };
}
