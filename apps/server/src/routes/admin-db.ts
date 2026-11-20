import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { AppError, asTrimmedString } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import {
  deleteSnapshot,
  getDbJobStatus,
  getPreUpdateCheckpointSummary,
  isDbJobRunning,
  listSnapshots,
  readSnapshotArtifact,
  startRestore,
  startReset,
  startSnapshot,
  type ResetScope,
} from '@server/services/DatabaseBackupService';

const router = Router();

/** Reject a new job when one is already running. */
function ensureIdle(): void {
  if (isDbJobRunning()) {
    throw new AppError(
      'A database job is already running',
      ErrorCode.CONFLICT,
      HTTP_STATUS.CONFLICT
    );
  }
}

// Current job status (polled by the UI).
router.get(
  '/status',
  asyncHandler(async (_req, res) => {
    sendOk(res, getDbJobStatus());
  })
);

router.get(
  '/snapshots',
  asyncHandler(async (_req, res) => {
    sendOk(res, await listSnapshots());
  })
);

// The packaged app's pre-update checkpoints (count and size), which the
// snapshot list does not include.
router.get(
  '/pre-update-checkpoints',
  asyncHandler(async (_req, res) => {
    sendOk(res, await getPreUpdateCheckpointSummary());
  })
);

router.post(
  '/snapshots',
  asyncHandler(async (req, res) => {
    ensureIdle();
    const label = asTrimmedString(req.body?.label) || undefined;
    const format = req.body?.format === 'plain-gzip' ? 'plain-gzip' : 'custom';
    sendOk(res, startSnapshot(label, format));
  })
);

router.get(
  '/snapshots/:id/download',
  asyncHandler(async (req, res) => {
    const id = asTrimmedString(req.params.id);
    if (!id) {
      throw new AppError(
        'Snapshot id is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    const artifact = await readSnapshotArtifact(id);
    res.type(artifact.contentType);
    res.attachment(artifact.fileName);
    res.send(artifact.buffer);
  })
);

// Restore a snapshot (auto-creates a pre-restore backup first).
router.post(
  '/snapshots/:id/restore',
  asyncHandler(async (req, res) => {
    ensureIdle();
    const id = asTrimmedString(req.params.id);
    if (!id) {
      throw new AppError(
        'Snapshot id is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    sendOk(res, startRestore(id));
  })
);

router.delete(
  '/snapshots/:id',
  asyncHandler(async (req, res) => {
    const id = asTrimmedString(req.params.id);
    if (!id) {
      throw new AppError(
        'Snapshot id is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    await deleteSnapshot(id);
    sendOk(res, { ok: true });
  })
);

// Clean-slate reset. Defaults: back up first, content-only scope.
router.post(
  '/reset',
  asyncHandler(async (req, res) => {
    ensureIdle();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const createBackup = body.createBackup !== false;
    const scope: ResetScope = body.scope === 'all' ? 'all' : 'content';
    sendOk(res, startReset({ createBackup, scope }));
  })
);

export default router;
