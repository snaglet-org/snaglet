/**
 * Projects API routes
 *
 * GET    /api/projects       — list all projects, newest-updated first
 * POST   /api/projects       — create a project
 * GET    /api/projects/:id   — get one
 * PATCH  /api/projects/:id   — update one
 *
 * A project IS a container with category='project', from creation or never:
 * thread and table scopes point at it, so there is no demote. Removing a
 * project means archiving or deleting its container (`/api/archive`,
 * `DELETE /api/containers/:id`).
 *
 * Embeddings maintenance (indexing-status, backfill, clear preview/confirm)
 * lives in ./handlers/embeddingsHandlers.ts.
 *
 * Body and response shapes use camelCase (`githubUrl`, `folderPath`).
 */

import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendCreated, sendOk } from '@server/utils/http';
import { asNonEmptyString, AppError, getErrorMessage } from '@snaglet/shared/utils';
import { HTTP_STATUS, ErrorCode } from '@snaglet/shared/types';
import { Containers, Projects } from '@snaglet/db';
import { logger } from '@server/config/logger';
import {
  emitTreeNodeCreated,
  emitTreeNodeUpdated,
  snapshotFromContainer,
} from '@server/realtime/surfaces/tree';
import { linkProjectFolder, unlinkProjectFolder } from '@server/services/projectFolder';
import {
  ensureWatchConfig,
  getDefaultExclusions,
  onProjectFolderChanged,
  onProjectFolderRelocated,
  readIndexConfig,
  scheduleProjectReindex,
  stopProjectFolderWatchers,
  writeIndexConfig,
  type IndexConfigEdits,
} from '@server/services/fileIndexing';
import { findFolderOverlaps, folderOverlapWarning } from '@server/services/fileIndexing/ownership';
import { getProjectFileEmbeddingCoverage } from '@server/services/embedding/fileEmbeddingCoverage';
import { getFileIndexingImpact } from '@server/services/fileIndexing/scan';
import { registerProjectEmbeddingRoutes } from './handlers/embeddingsHandlers';

import {
  assertProjectFolderIdle,
  inspectProjectFolder,
  validateProjectFolderChange,
} from '@server/services/projectFolderImpact';
import { recoverProjectFolder } from '@server/services/projectFolderRecovery';
import { purgeProjectIndex } from '@server/services/fileIndexing/watcher';

const router = Router();

// Embeddings maintenance: indexing status, backfill, clear preview/confirm.
registerProjectEmbeddingRoutes(router);

function normalizeOptional(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Validate an optional string-array body field. `undefined` passes through
 * (field not being edited); a present value must be an array of strings. */
function coerceStringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AppError(
      `${field} must be an array of strings`,
      ErrorCode.VALIDATION_ERROR,
      HTTP_STATUS.BAD_REQUEST
    );
  }
  return value as string[];
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const rows = await Projects.list({ orderBy: 'updated_at', order: 'DESC' });
    sendOk(res, rows);
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, containerId, githubUrl, folderPath } = req.body as Record<string, unknown>;
    const trimmedName = asNonEmptyString(name);
    if (!trimmedName) {
      throw new AppError('name is required', ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
    }
    const candidateFolder = normalizeOptional(folderPath);
    const checkedFolder = candidateFolder
      ? await validateProjectFolderChange(
          candidateFolder,
          typeof containerId === 'string' ? containerId : undefined,
          null,
          req.body.confirmFolderLink === true
        )
      : null;
    // A project IS a container with category='project'. When the caller doesn't
    // name a container, mint one at the library root already carrying the
    // project facet (one transactional write); otherwise write the facet onto
    // the project container they named (a container of any other category is
    // refused — there is no promotion).
    const bindingId = typeof containerId === 'string' ? containerId.trim() : '';
    const githubNext = normalizeOptional(githubUrl) ?? null;
    const folderNext = checkedFolder?.folderPath ?? null;
    if (!bindingId) {
      const created = await Containers.create({
        name: trimmedName,
        parentId: null,
        category: 'project',
        githubUrl: githubNext,
        folderPath: folderNext,
      });
      emitTreeNodeCreated(snapshotFromContainer(created));
      const project = await Projects.findById(created.id);
      if (!project) throw new Error(`project container ${created.id} missing after create`);
      sendCreated(res, project);
      return;
    }
    if (!(await Containers.findById(bindingId))) {
      throw new AppError('container not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const project = await Projects.create({
      name: trimmedName,
      containerId: bindingId,
      githubUrl: githubNext,
      folderPath: folderNext,
    });
    // The project name IS the container name the sidebar tree renders.
    emitTreeNodeUpdated({
      id: project.id,
      kind: 'container',
      title: project.name,
      updatedAt: project.updatedAt,
    });
    sendCreated(res, project);
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const project = await Projects.findById(req.params.id);
    if (!project) {
      throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, project);
  })
);

router.get(
  '/:id/file-embedding-coverage',
  asyncHandler(async (req, res) => {
    const project = await Projects.findById(req.params.id);
    if (!project) {
      throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    sendOk(res, await getProjectFileEmbeddingCoverage(project.id));
  })
);

router.get(
  '/:id/file-indexing-impact',
  asyncHandler(async (req, res) => {
    const project = await Projects.findById(req.params.id);
    if (!project) {
      throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    if (!project.folderPath) {
      sendOk(res, { eligibleFiles: 0, scannedEntries: 0, capped: false });
      return;
    }
    sendOk(res, await getFileIndexingImpact(project.id, project.folderPath));
  })
);

router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { name, githubUrl, folderPath, description, fileIndexingEnabled } = req.body as Record<
      string,
      unknown
    >;

    // A project IS its container — there is no separate binding to attach or
    // detach. Re-homing a project = moving the container (workspace move);
    // un-projecting = DELETE below. So this route only edits name + facets.
    const update: {
      name?: string;
      githubUrl?: string | null;
      folderPath?: string | null;
      description?: string | null;
      fileIndexingEnabled?: boolean;
    } = {};
    if (name !== undefined) {
      const trimmed = asNonEmptyString(name);
      if (!trimmed) {
        throw new AppError(
          'name cannot be empty',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      update.name = trimmed;
    }
    const githubNext = normalizeOptional(githubUrl);
    if (githubNext !== undefined) update.githubUrl = githubNext;
    const project = await Projects.withFolderWriteLock(async (tx) => {
      const previous = await Projects.findById(req.params.id, tx);
      const folderNext = normalizeOptional(folderPath);
      if (folderNext !== undefined) {
        assertProjectFolderIdle(req.params.id);
        if (!previous)
          throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
        update.folderPath = folderNext
          ? (
              await validateProjectFolderChange(
                folderNext,
                previous.id,
                previous.folderPath,
                req.body.confirmFolderLink === true
              )
            ).folderPath
          : null;
      }
      const descNext = normalizeOptional(description);
      if (descNext !== undefined) update.description = descNext;
      if (fileIndexingEnabled !== undefined) {
        if (typeof fileIndexingEnabled !== 'boolean') {
          throw new AppError(
            'fileIndexingEnabled must be a boolean',
            ErrorCode.VALIDATION_ERROR,
            HTTP_STATUS.BAD_REQUEST
          );
        }
        update.fileIndexingEnabled = fileIndexingEnabled;
      }

      const project = await Projects.update(req.params.id, update, tx);
      if (!project) {
        throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      if (folderNext !== undefined) {
        try {
          if (project.folderPath) await linkProjectFolder(project.id, project.folderPath);
          else await unlinkProjectFolder(project.id);
        } catch (err) {
          if (previous?.folderPath) await linkProjectFolder(project.id, previous.folderPath);
          else await unlinkProjectFolder(project.id);
          throw err;
        }
      }
      return project;
    });
    // The project name IS the container name the sidebar tree renders; the
    // other facets are not tree-visible.
    if (update.name !== undefined) {
      emitTreeNodeUpdated({
        id: project.id,
        kind: 'container',
        title: project.name,
        updatedAt: project.updatedAt,
      });
    }
    if (project.fileIndexingEnabled !== undefined && fileIndexingEnabled !== undefined) {
      // Single source of truth for "index this folder's content" is the on-disk
      // snaglet.config.json `embeddings.enabled`; the DB flag is a fast mirror. Keep
      // them in lockstep so the toggle and the file can never disagree. The UI
      // toggle goes through PUT /index-config; this back-compat PATCH path mirrors
      // to the file best-effort (a malformed file can't be synced — the reindex
      // still runs and the index-config UI surfaces the parse error).
      if (project.folderPath) {
        try {
          await writeIndexConfig(project.folderPath, { enabled: project.fileIndexingEnabled });
        } catch (err) {
          logger.warn(
            `[projects] could not mirror fileIndexingEnabled to snaglet.config.json for ${req.params.id}: ${getErrorMessage(err)}`
          );
        }
      }
      await onProjectFolderChanged(req.params.id);
    }
    sendOk(res, project);
  })
);

/**
 * PUT /api/projects/:id/folder-path — set (or clear) a project's working
 * folder and mirror it on disk.
 *
 * Unlike the autosaved metadata on PATCH, the folder path is an explicit
 * "Save" action: it validates that the path exists and is a directory
 * (throwing 400 if not — nothing is persisted), then creates the
 * `~/.snaglet/projects/<id>` → folder symlink. Sending null/empty clears the path
 * and removes the symlink.
 */
router.post(
  '/:id/folder-path/preview',
  asyncHandler(async (req, res) => {
    const existing = await Projects.findById(req.params.id);
    if (!existing)
      throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    const candidate = asNonEmptyString(req.body.folderPath);
    if (!candidate)
      throw new AppError(
        'folderPath is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    sendOk(res, await inspectProjectFolder(candidate, existing.id, existing.folderPath));
  })
);

router.put(
  '/:id/folder-path',
  asyncHandler(async (req, res) => {
    const { folderPath } = req.body as Record<string, unknown>;
    const next = normalizeOptional(folderPath) ?? null;

    // 404 up front so a missing project never masquerades as a path error.
    const existing = await Projects.findById(req.params.id);
    if (!existing) {
      throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }

    if (next === null) {
      assertProjectFolderIdle(existing.id);
      const project = await Projects.withFolderWriteLock(async (tx) => {
        const row = await Projects.update(req.params.id, { folderPath: null }, tx);
        await unlinkProjectFolder(req.params.id);
        return row;
      });
      // Folder cleared → purge the project's file nodes (no working tree).
      await onProjectFolderChanged(req.params.id);
      sendOk(res, project ?? existing);
      return;
    }

    // A Locate of a proven missing root is a relocation, not an index replacement.
    const recovery = await recoverProjectFolder(existing.id, {
      candidate: next,
      beforeApply: stopProjectFolderWatchers,
    });
    if (recovery.status === 'recovered') {
      await onProjectFolderRelocated(existing.id);
      sendOk(res, recovery.project);
      return;
    }
    if (
      recovery.status === 'busy' ||
      recovery.status === 'changed' ||
      recovery.status === 'failed'
    ) {
      throw new AppError(
        'Folder recovery was deferred; retry when the project is idle.',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.CONFLICT
      );
    }

    const { project, overlapWarning } = await Projects.withFolderWriteLock(async (tx) => {
      const current = await Projects.findById(req.params.id, tx);
      if (!current || current.archived) {
        throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
      }
      // Validate before persisting — a bad path must leave the project untouched.
      const impact = await validateProjectFolderChange(
        next,
        current.id,
        current.folderPath,
        req.body.confirmFolderLink === true
      );
      const resolved = impact.folderPath;
      if (impact.replacingFolder && req.body.clearPreviousIndex === true) {
        // Explicit opt-in from the preview. Remove cached index data only, never source files.
        await purgeProjectIndex(current.id, tx);
      }
      // Link-time overlap check (warning only, never blocks): another project
      // already linking this folder, a parent of it, or a subfolder of it means
      // the overlapping files are SHARED — embeddings are content-addressed and
      // folder ownership indexes each tree once, so nothing is re-indexed.
      const allProjects = await Projects.listAll(tx);
      const overlaps = findFolderOverlaps(
        resolved,
        allProjects
          .filter((p) => p.id !== req.params.id && !p.archived)
          .map((p) => ({ id: p.id, name: p.name, folderPath: p.folderPath }))
      );
      const overlapWarning = folderOverlapWarning(overlaps);
      // Auto-create the indexing gate so the user doesn't have to add snaglet.config.json
      // by hand. No-op if the folder already has one (an explicit opt-out is kept).
      await ensureWatchConfig(resolved, current.id);
      const project = await Projects.update(req.params.id, { folderPath: resolved }, tx);
      try {
        await linkProjectFolder(req.params.id, resolved);
      } catch (err) {
        if (current.folderPath) await linkProjectFolder(current.id, current.folderPath);
        else await unlinkProjectFolder(current.id);
        throw err;
      }
      return { project, overlapWarning };
    });
    // Reconcile against the new folder: matching paths keep their embeddings,
    // paths gone from the new tree are deleted, and live watching re-points.
    await onProjectFolderChanged(req.params.id);
    sendOk(res, { ...(project ?? existing), overlapWarning });
  })
);

/**
 * GET /api/projects/:id/index-config — the project's file-indexing settings,
 * read from `<folder>/snaglet.config.json`, for the project settings UI.
 *
 * Returns the user-editable rules (`enabled`, `ignorePaths`, `ignoreFileTypes`),
 * provenance flags (`configExists`, `parseError`), and the always-on hardcoded
 * `defaults` (shown read-only so users see why node_modules etc. never appear).
 * `enabled` is the effective gate (the DB toggle AND the file's `embeddings.enabled`)
 * so the checkbox never claims "on" while indexing is actually gated off. The file
 * is the value the UI writes and users hand-edit; the DB flag is mirrored to it.
 */
router.get(
  '/:id/index-config',
  asyncHandler(async (req, res) => {
    const project = await Projects.findById(req.params.id);
    if (!project) {
      throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const defaults = getDefaultExclusions();
    if (!project.folderPath) {
      sendOk(res, {
        hasFolder: false,
        folderPath: null,
        configExists: false,
        parseError: false,
        enabled: project.fileIndexingEnabled,
        includePaths: [],
        ignorePaths: [],
        ignoreFileTypes: [],
        defaults,
      });
      return;
    }
    const view = await readIndexConfig(project.folderPath);
    // The file's `embeddings.enabled` is the value the UI writes and users hand-
    // edit (the source of truth). The toggle DISPLAYS the effective gate — the DB
    // flag AND the file — so it can never claim "on" while indexing is actually
    // gated off (a pre-feature per-project opt-out, or a hand-edited enabled:false).
    // A missing file means the folder isn't indexed, so it reads as off.
    const fileEnabled = view.configExists ? view.enabled : false;
    sendOk(res, {
      hasFolder: true,
      folderPath: project.folderPath,
      ...view,
      enabled: project.fileIndexingEnabled && fileEnabled,
      defaults,
    });
  })
);

/**
 * PUT /api/projects/:id/index-config — edit the managed indexing settings in
 * `<folder>/snaglet.config.json`, writing atomically and preserving every key the app
 * doesn't manage. Body: `{ enabled?, includePaths?, ignorePaths?, ignoreFileTypes? }` (each
 * optional; omitted fields are left untouched on disk). Creates the file if
 * absent. `enabled` is mirrored to the DB `fileIndexingEnabled` toggle so the two
 * can't disagree. Gate changes reconcile immediately; ignore-rule changes are
 * coalesced into a background reconcile so several edits can be saved quickly.
 */
router.put(
  '/:id/index-config',
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const edits: IndexConfigEdits = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        throw new AppError(
          'enabled must be a boolean',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      edits.enabled = body.enabled;
    }
    edits.includePaths = coerceStringList(body.includePaths, 'includePaths');
    edits.ignorePaths = coerceStringList(body.ignorePaths, 'ignorePaths');
    edits.ignoreFileTypes = coerceStringList(body.ignoreFileTypes, 'ignoreFileTypes');

    const project = await Projects.findById(req.params.id);
    if (!project) {
      throw new AppError('project not found', ErrorCode.NOT_FOUND, HTTP_STATUS.NOT_FOUND);
    }
    const defaults = getDefaultExclusions();

    // No folder → no file to write. Only the `enabled` toggle is meaningful
    // (stored on the DB flag); ignore rules need a folder to live in.
    if (!project.folderPath) {
      if (
        edits.includePaths !== undefined ||
        edits.ignorePaths !== undefined ||
        edits.ignoreFileTypes !== undefined
      ) {
        throw new AppError(
          'link a project folder before setting ignore rules',
          ErrorCode.VALIDATION_ERROR,
          HTTP_STATUS.BAD_REQUEST
        );
      }
      if (edits.enabled !== undefined) {
        await Projects.update(req.params.id, { fileIndexingEnabled: edits.enabled });
        await onProjectFolderChanged(req.params.id);
      }
      sendOk(res, {
        hasFolder: false,
        folderPath: null,
        configExists: false,
        parseError: false,
        enabled: edits.enabled ?? project.fileIndexingEnabled,
        includePaths: [],
        ignorePaths: [],
        ignoreFileTypes: [],
        defaults,
      });
      return;
    }

    const written = await writeIndexConfig(project.folderPath, edits);
    // Mirror the gate to the DB flag so the fast reconcile gate never contradicts
    // the file (the file is the source of truth; this keeps the mirror honest and
    // collapses any pre-feature divergence the first time the toggle is used).
    const dbEnabled = edits.enabled ?? project.fileIndexingEnabled;
    if (edits.enabled !== undefined) {
      await Projects.update(req.params.id, { fileIndexingEnabled: edits.enabled });
    }
    // Gate changes retain immediate reconcile/purge semantics. Ignore-rule edits
    // return as soon as the atomic config write commits; the API write and the
    // chokidar event coalesce into one background reconciliation.
    if (edits.enabled !== undefined) {
      await onProjectFolderChanged(req.params.id);
    } else {
      scheduleProjectReindex('ignore rules changed', req.params.id);
    }
    sendOk(res, {
      hasFolder: true,
      folderPath: project.folderPath,
      configExists: true,
      parseError: false,
      enabled: dbEnabled && written.enabled,
      includePaths: written.includePaths,
      ignorePaths: written.ignorePaths,
      ignoreFileTypes: written.ignoreFileTypes,
      created: written.created,
      defaults,
    });
  })
);

export default router;
