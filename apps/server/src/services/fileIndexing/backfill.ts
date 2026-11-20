/**
 * backfill — the explicit, project-scoped "bring my embeddings up to date"
 * action, deliberately independent of the background worker preference.
 *
 * The global EmbeddingWorker sweep (sweepMissingFileEmbeddings) excludes
 * projects whose indexing is disabled — correct for a background process, but
 * it would make "Backfill missing or stale embeddings" impossible while the
 * worker is paused. This path therefore reconciles and embeds one project on
 * explicit request, regardless of the pause state, without flipping any
 * preference: after a backfill on a paused project, the project is still
 * paused, just fully embedded.
 *
 * Two steps, mirrored into projectIndexingStatus for live UI progress:
 *   1. scanning  — a normal disk↔DB reconcile (rows reflect disk truth; a
 *      stale file's row gets its current content hash, which is what makes it
 *      show up as "missing" in the embedding step).
 *   2. embedding — embed every unique content hash of this project's rows
 *      that has no chunk set under the active model. Content-addressed dedup
 *      means bytes already embedded anywhere cost zero compute.
 *
 * Nothing here deletes embeddings; failures are counted per candidate and the
 * pass keeps going, surfacing a partial-failure total instead of a false
 * "complete".
 */

import { Projects } from '@snaglet/db/tables/projects';
import type { ProjectRow } from '@snaglet/db/tables/projects';
import { getDb } from '@snaglet/db';
import { Models } from '@snaglet/db/tables/models';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import type { ProjectBackfillResult } from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import { buildEmbeddingTarget } from '@server/services/embedding/EmbeddingNodeClassifier';
import { embedFileContent } from '@server/services/embedding/fileContentEmbedding';
import {
  resolveEmbeddingProvider,
  type EmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { forgetProjectHashedStats } from './hashedStatCache';
import { reconcileProject } from './reconcile';
import {
  endExclusiveOp,
  markBackfillEmbedding,
  tryBeginExclusiveOp,
  updateBackfillProgress,
} from './projectIndexingStatus';

/**
 * One representative file id per content_hash of this project's rows that has
 * no chunk set under `modelId`. Unlike the worker sweep's global candidate
 * query, this does not filter on the project's indexing-enabled mirror — the
 * whole point of the manual pass is to work while the worker is paused.
 */
async function listProjectMissingEmbeddingCandidates(
  projectId: string,
  modelId: string
): Promise<string[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `
      SELECT id FROM (
        SELECT DISTINCT ON (f.content_hash) f.id, n.updated_at
        FROM public.files f
        JOIN public.nodes n ON n.id = f.id
        WHERE f.project_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM public.file_embeddings fe
            WHERE fe.content_hash = f.content_hash AND fe.model_id = $2
          )
        ORDER BY f.content_hash, n.updated_at ASC
      ) candidates
      ORDER BY updated_at ASC
    `,
    [projectId, modelId]
  );
  return rows.map((r) => r.id);
}

export interface RunProjectBackfillOptions {
  /** Explicit provider for tests/maintenance; defaults to the active model. */
  providerOverride?: EmbeddingProvider;
}

/** Load + validate the project and acquire its exclusive maintenance slot.
 * Throws 404 (no project), 400 (no folder), or 409 (backfill/clear running). */
async function validateAndAcquire(projectId: string): Promise<ProjectRow> {
  const project = await Projects.findById(projectId);
  if (!project) {
    throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  if (!project.folderPath) {
    throw new AppError(
      'link a project folder before backfilling embeddings',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  if (!tryBeginExclusiveOp(projectId, 'backfill')) {
    throw new AppError(
      'a backfill or clear is already running for this project',
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  }
  return project;
}

/** Run the pass with the slot already held; always releases it, recording the
 * error on failure so the UI can show a `failed` state. */
async function runHeldBackfill(
  project: ProjectRow,
  options: RunProjectBackfillOptions,
  signal: AbortSignal
): Promise<ProjectBackfillResult> {
  const result: ProjectBackfillResult = {
    total: 0,
    processed: 0,
    embedded: 0,
    reused: 0,
    failed: 0,
    reconciledUpserts: 0,
    reconciledRemovals: 0,
  };
  try {
    await executeBackfill(project, options, signal, result);
    endExclusiveOp(project.id);
    return result;
  } catch (err) {
    if (signal.aborted) {
      endExclusiveOp(project.id, undefined, true);
      return { ...result, canceled: true };
    }
    endExclusiveOp(project.id, getErrorMessage(err));
    throw err;
  }
}

/**
 * Run one full backfill pass for a project and await its result. Throws 409
 * when a backfill or clear already holds the project, 400 when it has no
 * folder, and 503 when no embedding provider/model is available.
 */
export async function runProjectBackfill(
  projectId: string,
  options: RunProjectBackfillOptions = {}
): Promise<ProjectBackfillResult> {
  const project = await validateAndAcquire(projectId);
  const controller = new AbortController();
  const pass = runHeldBackfill(project, options, controller.signal);
  activeBackfills.set(projectId, { pass, controller });
  try {
    return await pass;
  } finally {
    if (activeBackfills.get(projectId)?.pass === pass) activeBackfills.delete(projectId);
  }
}

async function executeBackfill(
  project: ProjectRow,
  options: RunProjectBackfillOptions,
  signal: AbortSignal,
  progress: ProjectBackfillResult
): Promise<void> {
  // Scanning — reconcile disk↔DB so rows (and their content hashes) are
  // current. This is what turns "stale" files into "missing" embeddings. A
  // person asked for it, so every file is read again rather than settled from
  // its cached stat: this pass is the way out of a stale index.
  signal.throwIfAborted();
  forgetProjectHashedStats(project.id);
  const reconciled = await reconcileProject(project, undefined, signal);
  progress.reconciledUpserts = reconciled.upserted;
  progress.reconciledRemovals = reconciled.removed;
  signal.throwIfAborted();

  const provider =
    options.providerOverride === undefined
      ? await resolveEmbeddingProvider()
      : options.providerOverride;
  if (!provider) {
    throw new AppError(
      'The built-in embedding model is not available.',
      ErrorCode.SERVICE_UNAVAILABLE,
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
  }
  const modelRow = await Models.findByProviderAndModelId(
    provider.info.provider,
    provider.info.model
  );
  if (!modelRow) {
    throw new AppError(
      `The built-in embedding model ${provider.info.provider}:${provider.info.model} is missing from the models catalog. Restart Snaglet to restore it.`,
      ErrorCode.SERVICE_UNAVAILABLE,
      HTTP_STATUS.SERVICE_UNAVAILABLE
    );
  }

  // Embedding — embed unique missing contents, with live progress.
  const candidates = await listProjectMissingEmbeddingCandidates(project.id, modelRow.id);
  signal.throwIfAborted();
  progress.total = candidates.length;
  markBackfillEmbedding(project.id, { ...progress });

  for (const fileId of candidates) {
    signal.throwIfAborted();
    try {
      const target = await buildEmbeddingTarget('file', fileId);
      if (target) {
        const embedResult = await embedFileContent({
          contentHash: target.contentHash,
          content: target.content,
          providerOverride: provider,
        });
        if (!embedResult.ok) progress.failed += 1;
        else if (embedResult.skipped === 'unchanged') progress.reused += 1;
        else progress.embedded += 1;
      }
      // A null target (file vanished / oversized / binary since the scan) is
      // not a failure — it simply isn't embeddable; count it processed only.
    } catch (err) {
      progress.failed += 1;
      logger.error(
        `[fileIndexing] backfill embed failed for ${project.id}:${fileId}: ${getErrorMessage(err)}`
      );
    }
    progress.processed += 1;
    updateBackfillProgress(project.id, { ...progress }, progress.processed === progress.total);
  }

  signal.throwIfAborted();
  logger.info(
    `[fileIndexing] backfill ${project.id}: ${progress.embedded} embedded, ` +
      `${progress.reused} reused, ${progress.failed} failed of ${progress.total} ` +
      `(reconcile +${reconciled.upserted} -${reconciled.removed})`
  );
}

/** In-flight passes so the API can fire-and-forget without double-starting. */
const activeBackfills = new Map<
  string,
  { pass: Promise<ProjectBackfillResult>; controller: AbortController }
>();

/** Cooperatively stop after the current candidate, preserving finished work. */
export function cancelProjectBackfill(projectId: string): void {
  const active = activeBackfills.get(projectId);
  if (!active)
    throw new AppError(
      'No backfill is running for this project',
      ErrorCode.NOT_FOUND,
      HTTP_STATUS.NOT_FOUND
    );
  active.controller.abort();
}

/**
 * Start a backfill in the background (the API-facing entry). Validation and
 * the exclusive-slot acquisition complete before this resolves, so callers
 * still get 400/404/409 synchronously with their request; only the long pass
 * itself is detached. Progress and completion flow through
 * `file.indexing_status_changed` events (and GET indexing-status polling).
 */
export async function startProjectBackfill(projectId: string): Promise<void> {
  const project = await validateAndAcquire(projectId);
  const controller = new AbortController();
  const pass = runHeldBackfill(project, {}, controller.signal);
  activeBackfills.set(projectId, { pass, controller });
  void pass
    .catch((err) => {
      // Already recorded in the runtime status by runHeldBackfill; log only.
      logger.error(`[fileIndexing] backfill failed for ${projectId}: ${getErrorMessage(err)}`);
    })
    .finally(() => {
      if (activeBackfills.get(projectId)?.pass === pass) activeBackfills.delete(projectId);
    });
}
