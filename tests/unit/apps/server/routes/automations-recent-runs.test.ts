/**
 * GET /api/automations/runs/recent — the Automations view's run log across
 * every automation in one read, open like the other reads. The SQL itself is
 * covered against a real database in
 * tests/integration/apps/server/routes/automations.routes.test.ts.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const service = {
  recentRuns: jest.fn(),
  get: jest.fn(),
};
jest.mock('@server/services/automations/AutomationService', () => ({
  automationService: service,
}));

import automationsRouter from '@server/routes/automations';
import { errorHandler } from '@server/middleware';

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/automations', automationsRouter);
  app.use(errorHandler);
  return app;
}

const run = {
  id: 'run-1',
  automationId: 'automation-1111111111111-aaaaaaaaa',
  automationName: 'Morning check',
  scheduledFor: '2026-11-05T09:00:00.000Z',
  startedAt: '2026-11-05T09:00:00.000Z',
  finishedAt: '2026-11-05T09:00:12.000Z',
  status: 'succeeded',
  error: null,
  manual: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  service.recentRuns.mockResolvedValue({ runs: [run] } as never);
});

describe('GET /api/automations/runs/recent', () => {
  it('reads the newest 20 by default, without the panel token', async () => {
    const res = await request(buildApp()).get('/api/automations/runs/recent');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ runs: [run] });
    expect(service.recentRuns).toHaveBeenCalledWith(20);
    expect(service.get).not.toHaveBeenCalled();
  });

  it('takes a limit from 1 to 100 and refuses anything else', async () => {
    await request(buildApp()).get('/api/automations/runs/recent?limit=5');
    expect(service.recentRuns).toHaveBeenLastCalledWith(5);

    for (const limit of ['0', '101', 'ten', '2.5']) {
      const res = await request(buildApp()).get(`/api/automations/runs/recent?limit=${limit}`);
      expect(res.status).toBe(400);
    }
    expect(service.recentRuns).toHaveBeenCalledTimes(1);
  });
});
