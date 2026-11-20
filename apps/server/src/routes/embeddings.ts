/** Embedding coverage and unified on-demand backfill; automatic workers are independent. */
import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { AppError } from '@snaglet/shared/utils';
import { getErrorMessage } from '@snaglet/shared/utils';
import {
  cancelMaintenanceJob,
  getMaintenanceStatus,
  listMaintenanceModels,
  startMaintenanceJob,
  startBackfillForActiveModel,
} from '@server/services/EmbeddingMaintenanceService';
import { getStorageStats } from '@server/services/EmbeddingQueryService';
const router = Router();
router.get(
  '/reembed/status',
  asyncHandler(async (_req, res) => {
    sendOk(res, getMaintenanceStatus());
  })
);
router.get(
  '/maintenance/models',
  asyncHandler(async (_req, res) => {
    sendOk(res, await listMaintenanceModels());
  })
);
router.get(
  '/maintenance/status',
  asyncHandler(async (_req, res) => {
    sendOk(res, getMaintenanceStatus());
  })
);
router.post(
  '/maintenance/cancel',
  asyncHandler(async (_req, res) => {
    sendOk(res, cancelMaintenanceJob());
  })
);
router.post(
  '/maintenance/jobs',
  asyncHandler(async (req, res) => {
    if (req.body?.operation !== 'backfill')
      throw new AppError(
        'Only unified backfill is supported',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    try {
      sendOk(
        res,
        await startMaintenanceJob({
          operation: 'backfill',
          modelId: typeof req.body.modelId === 'string' ? req.body.modelId : null,
          nodeType: typeof req.body.nodeType === 'string' ? req.body.nodeType : null,
        })
      );
    } catch (error) {
      const message = getErrorMessage(error);
      throw new AppError(
        message,
        ErrorCode.VALIDATION_ERROR,
        message.includes('already running') ? HTTP_STATUS.CONFLICT : HTTP_STATUS.BAD_REQUEST
      );
    }
  })
);
router.post(
  '/reembed',
  asyncHandler(async (_req, res) => {
    sendOk(res, await startBackfillForActiveModel());
  })
);
router.get(
  '/storage',
  asyncHandler(async (_req, res) => {
    sendOk(res, await getStorageStats());
  })
);
export default router;
