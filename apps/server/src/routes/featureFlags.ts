import { Router } from 'express';

import { asyncHandler } from '@server/middleware';
import { featureFlagService } from '@server/services/FeatureFlagService';
import { sendOk } from '@server/utils/http';

const router = Router();

/** GET-only frontend exposure snapshot. Mutations are intentionally absent. */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    sendOk(res, await featureFlagService.getFrontendFlags());
  })
);

export default router;
