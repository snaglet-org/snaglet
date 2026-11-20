/**
 * PUT /api/hooks/:hookName/unattended-policy — what a run the hook wakes does
 * with a tool call that would ask a person. Only the panel token may
 * change it: a hook's own child-dispatch credential is refused, so a hook can
 * never loosen its own runs. The value must be one of the two policies.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const registry = {
  setUnattendedPolicy: jest.fn(),
};
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => registry,
}));
jest.mock('@server/middleware/hookCliAuth', () => ({
  hookCommandAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('@server/services/customHooks/resolveDynamicContent', () => ({
  resolveDynamicContent: jest.fn(),
}));

import hooksRouter from '@server/routes/hooks';
import { errorHandler } from '@server/middleware';
import { getPanelToken, mintChildDispatchToken } from '@server/middleware/panelAuth';

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/hooks', hooksRouter);
  app.use(errorHandler);
  return app;
}

const row = (policy: string) => ({ id: 'hookreg-1', name: 'test-hook', unattendedPolicy: policy });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PUT /api/hooks/:hookName/unattended-policy', () => {
  it('sets the policy with the panel token', async () => {
    registry.setUnattendedPolicy.mockResolvedValue(row('auto-approve-allowed') as never);

    const res = await request(buildApp())
      .put('/api/hooks/test-hook/unattended-policy')
      .set('x-snaglet-panel-token', getPanelToken())
      .send({ policy: 'auto-approve-allowed' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(row('auto-approve-allowed'));
    expect(registry.setUnattendedPolicy).toHaveBeenCalledWith('test-hook', 'auto-approve-allowed');
  });

  it("refuses a hook's own child-dispatch credential and a missing token", async () => {
    const child = mintChildDispatchToken('test-agent-a', 'test-hook', 1, ['test-hook']);
    const fromHook = await request(buildApp())
      .put('/api/hooks/test-hook/unattended-policy')
      .set('x-snaglet-child-dispatch-token', child)
      .send({ policy: 'auto-approve-allowed' });
    const anonymous = await request(buildApp())
      .put('/api/hooks/test-hook/unattended-policy')
      .send({ policy: 'auto-approve-allowed' });

    expect(fromHook.status).toBe(403);
    expect(anonymous.status).toBe(403);
    expect(registry.setUnattendedPolicy).not.toHaveBeenCalled();
  });

  it('rejects a value that is not a policy', async () => {
    const res = await request(buildApp())
      .put('/api/hooks/test-hook/unattended-policy')
      .set('x-snaglet-panel-token', getPanelToken())
      .send({ policy: 'approve-all' });

    expect(res.status).toBe(400);
    expect(registry.setUnattendedPolicy).not.toHaveBeenCalled();
  });

  it('404s an unregistered hook', async () => {
    registry.setUnattendedPolicy.mockResolvedValue(null as never);

    const res = await request(buildApp())
      .put('/api/hooks/test-hook/unattended-policy')
      .set('x-snaglet-panel-token', getPanelToken())
      .send({ policy: 'skip' });

    expect(res.status).toBe(404);
  });
});
