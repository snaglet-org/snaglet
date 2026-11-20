/**
 * PUT /api/hooks/:hookName/run-as — the hook editor's Runs as picker. Panel
 * token only (mocked open here; the mount is what keeps hook code out), a
 * body naming an agent id or null, the registry's refusal passed through as a
 * 400, and an unregistered hook as a 404.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';

const registry = {
  setRunAs: jest.fn(),
};
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => registry,
}));
jest.mock('@server/realtime/surfaces/hookRuns', () => ({ emitHookEnabledChanged: jest.fn() }));
jest.mock('@server/middleware/hookCliAuth', () => ({
  hookCommandAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const panelAuth = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('@server/middleware/panelAuth', () => ({
  toolDispatchAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  panelAuthMiddleware: (req: unknown, res: unknown, next: () => void) => panelAuth(req, res, next),
  getPanelToken: () => 'test-panel-token',
  mintChildDispatchToken: () => 'test-child-dispatch-token',
}));
jest.mock('@server/services/customHooks/resolveDynamicContent', () => ({
  resolveDynamicContent: jest.fn(),
}));

import hooksRouter from '@server/routes/hooks';
import { errorHandler } from '@server/middleware';

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/hooks', hooksRouter);
  app.use(errorHandler);
  return app;
}

const row = (runAsAgentId: string | null) => ({ id: 'hook_1', name: 'test-hook', runAsAgentId });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PUT /api/hooks/:hookName/run-as', () => {
  it('sets the agent behind the panel token', async () => {
    registry.setRunAs.mockResolvedValue(row('test-agent-a') as never);

    const res = await request(buildApp())
      .put('/api/hooks/test-hook/run-as')
      .send({ agentId: 'test-agent-a' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(row('test-agent-a'));
    expect(registry.setRunAs).toHaveBeenCalledWith('test-hook', 'test-agent-a');
    expect(panelAuth).toHaveBeenCalledTimes(1);
  });

  it('clears it with null', async () => {
    registry.setRunAs.mockResolvedValue(row(null) as never);

    const res = await request(buildApp())
      .put('/api/hooks/test-hook/run-as')
      .send({ agentId: null });

    expect(res.status).toBe(200);
    expect(registry.setRunAs).toHaveBeenCalledWith('test-hook', null);
  });

  it('400s a body without an agent id or null', async () => {
    const res = await request(buildApp()).put('/api/hooks/test-hook/run-as').send({});

    expect(res.status).toBe(400);
    expect(registry.setRunAs).not.toHaveBeenCalled();
  });

  it("passes the registry's refusal of an archived agent through as a 400", async () => {
    registry.setRunAs.mockRejectedValue(
      new AppError(
        'Can\'t run this hook as "test-agent-b": agent "Test Agent B" is archived.',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      ) as never
    );

    const res = await request(buildApp())
      .put('/api/hooks/test-hook/run-as')
      .send({ agentId: 'test-agent-b' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('is archived');
  });

  it('404s an unregistered hook', async () => {
    registry.setRunAs.mockResolvedValue(null as never);

    const res = await request(buildApp())
      .put('/api/hooks/test-hook/run-as')
      .send({ agentId: 'test-agent-a' });

    expect(res.status).toBe(404);
  });
});
