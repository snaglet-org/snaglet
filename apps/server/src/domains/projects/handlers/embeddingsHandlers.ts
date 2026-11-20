/**
 * Project embeddings maintenance routes under /api/projects/:id: indexing
 * status, start or cancel a backfill, preview and confirm a clear, and apply
 * the removals the mass-removal backstop is holding (one reconcile, only while
 * the fresh count is within 10% of `expected`, else 409 and nothing removed).
 * The two deleting routes are for people only: panel auth, not tools, not on
 * MCP, never called by hooks. Pausing has no route of its own: PUT
 * .../index-config `{ enabled }` stops the watcher without touching data.
 */

import type { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import type { ProjectIndexingStatus } from '@snaglet/shared/types';
import { Projects } from '@snaglet/db';
import { getFileSearchScope } from '@server/services/fileIndexing';
import { readWatchConfig } from '@server/services/fileIndexing/watchConfig';
import {
  endExclusiveOp,
  getProjectIndexingRuntime,
  tryBeginExclusiveOp,
} from '@server/services/fileIndexing/projectIndexingStatus';
import { reconcileProject } from '@server/services/fileIndexing/reconcile';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { ProjectApplyHeldRemovalsResult } from '@snaglet/shared/types';
import {
  cancelProjectBackfill,
  startProjectBackfill,
} from '@server/services/fileIndexing/backfill';
import {
  clearProjectEmbeddings,
  getProjectEmbeddingsClearPreview,
} from '@server/services/fileIndexing/clearEmbeddings';
import { getProjectFileEmbeddingCoverage } from '@server/services/embedding/fileEmbeddingCoverage';

async function requireProject(id: string) {
  const project = await Projects.findById(id);
  if (!project) {
    throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
  }
  return project;
}

/**
 * The confirmed release of a mass-removal hold. Holds the project's exclusive
 * slot (as a 'clear' — it deletes) so it can't race a backfill or clear. The
 * root-identity, unreadable-subtree and capped-walk guards still apply.
 */
async function applyHeldRemovals(
  projectId: string,
  expected: unknown
): Promise<ProjectApplyHeldRemovalsResult> {
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected <= 0) {
    throw new AppError(
      '`expected` must be the positive held count you confirmed',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  const project = await requireProject(projectId);
  if (!project.folderPath) {
    throw new AppError(
      'project has no folder',
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  if (!getProjectIndexingRuntime(project.id).heldRemovals) {
    throw new AppError(
      'Nothing is being held for this project — refresh and look again',
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  }
  if (!tryBeginExclusiveOp(project.id, 'clear')) {
    throw new AppError(
      'A backfill or clear is already running for this project',
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  }
  try {
    const result = await reconcileProject(project, undefined, undefined, {
      allowMassRemoval: { expected },
    });
    endExclusiveOp(project.id);
    if (result.releaseRefused) {
      const r = result.releaseRefused;
      throw new AppError(
        r.reason === 'incomplete-walk'
          ? 'Snaglet could not read the whole folder this time, so nothing was removed'
          : `The folder changed: ${r.found} files are missing now, not ${r.expected} — nothing was removed; review the new count`,
        ErrorCode.CONFLICT,
        HTTP_STATUS.CONFLICT,
        true,
        { ...r }
      );
    }
    return { removed: result.removed, kept: result.kept, upserted: result.upserted };
  } catch (err) {
    if (getProjectIndexingRuntime(project.id).activeExclusiveOp) {
      endExclusiveOp(project.id, getErrorMessage(err));
    }
    throw err;
  }
}

export function registerProjectEmbeddingRoutes(router: Router): void {
  router.post(
    '/:id/indexing/apply-held-removals',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as { expected?: unknown };
      sendOk(res, await applyHeldRemovals(req.params.id, body.expected));
    })
  );

  router.get(
    '/:id/indexing-status',
    asyncHandler(async (req, res) => {
      const project = await requireProject(req.params.id);
      const runtime = getProjectIndexingRuntime(project.id);

      if (!project.folderPath) {
        const status: ProjectIndexingStatus = {
          ...runtime,
          hasFolder: false,
          folderPath: null,
          // No folder → no gate file can exist; nothing runs and nothing is
          // destroyed. 'missing' here carries no unconfigure semantics because
          // the folder itself is absent.
          configStatus: 'missing',
          workerEnabled: false,
          coverage: { embeddedFiles: 0, totalFiles: 0 },
          ownerProjectId: null,
        };
        sendOk(res, status);
        return;
      }

      const cfg = await readWatchConfig(project.folderPath);
      const coverage = await getProjectFileEmbeddingCoverage(project.id);
      const status: ProjectIndexingStatus = {
        ...runtime,
        hasFolder: true,
        folderPath: project.folderPath,
        configStatus: cfg.status,
        workerEnabled: project.fileIndexingEnabled && cfg.status === 'present' && cfg.enabled,
        coverage,
        ownerProjectId: getFileSearchScope(project.id)?.projectId ?? null,
      };
      sendOk(res, status);
    })
  );

  router.post(
    '/:id/embeddings/backfill',
    asyncHandler(async (req, res) => {
      // Validation + exclusive-slot acquisition happen before this resolves,
      // so 404/400/409 surface on the request; the pass itself runs detached
      // and reports through file.indexing_status_changed events.
      await startProjectBackfill(req.params.id);
      sendOk(res, { started: true });
    })
  );

  router.post(
    '/:id/embeddings/backfill/cancel',
    asyncHandler(async (req, res) => {
      cancelProjectBackfill(req.params.id);
      sendOk(res, { cancelling: true });
    })
  );

  router.get(
    '/:id/embeddings/clear-preview',
    asyncHandler(async (req, res) => {
      const project = await requireProject(req.params.id);
      sendOk(res, await getProjectEmbeddingsClearPreview(project.id));
    })
  );

  router.post(
    '/:id/embeddings/clear',
    asyncHandler(async (req, res) => {
      sendOk(res, await clearProjectEmbeddings(req.params.id));
    })
  );
}
