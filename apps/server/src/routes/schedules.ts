import { Router } from 'express';
import { asyncHandler } from '@server/middleware';
import { panelAuthMiddleware } from '@server/middleware/panelAuth';
import { sendOk } from '@server/utils/http';
import { scheduleService } from '@server/services/ScheduleService';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    sendOk(res, await scheduleService.list());
  })
);

router.patch(
  '/:id/enabled',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk(res, await scheduleService.setEnabled(req.params.id, req.body?.enabled === true));
  })
);

router.post(
  '/:id/run',
  panelAuthMiddleware,
  asyncHandler(async (req, res) => {
    sendOk(res, await scheduleService.runNow(req.params.id));
  })
);

router.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    sendOk(res, await scheduleService.listRuns(req.params.id, Number(req.query.limit) || 25));
  })
);

export default router;
