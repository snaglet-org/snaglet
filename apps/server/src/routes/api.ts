import { Router } from 'express';
import { HealthResponse } from '@snaglet/shared/types';
import { formatTimestamp } from '@snaglet/shared/utils';
import type { RouteHandler } from '@server/types';

const router = Router();

const healthHandler: RouteHandler<HealthResponse> = (_req, res) => {
  const response: HealthResponse = {
    status: 'healthy',
    timestamp: formatTimestamp(new Date()),
    message: 'Server is running and responsive',
  };
  res.json(response);
};

router.get('/health', healthHandler);

export default router;
