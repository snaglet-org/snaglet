/**
 * POST /api/hooks/:hookName/enable|disable — the switch the Hooks sidebar,
 * the builder pane and `snaglet hook <name> enable|disable` all use. A real flip
 * broadcasts `hook.enabled_changed` so every window's list follows; a repeat
 * of the current state and an unregistered hook broadcast nothing.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const registry = {
  listRegistrations: jest.fn(),
  setEnabled: jest.fn(),
};
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => registry,
}));

const emitHookEnabledChanged = jest.fn();
jest.mock('@server/realtime/surfaces/hookRuns', () => ({
  emitHookEnabledChanged: (...args: unknown[]) => emitHookEnabledChanged(...args),
}));

jest.mock('@server/middleware/hookCliAuth', () => ({
  hookCommandAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('@server/middleware/panelAuth', () => ({
  toolDispatchAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  panelAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
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

const row = (enabled: boolean) => ({ id: 'hook-row-1', name: 'test-hook', enabled });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/hooks/:hookName/enable|disable', () => {
  it('broadcasts the new state when the flag flips', async () => {
    registry.listRegistrations.mockResolvedValue([row(true)] as never);
    registry.setEnabled.mockResolvedValue(row(false) as never);

    const res = await request(buildApp()).post('/api/hooks/test-hook/disable');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(row(false));
    expect(registry.setEnabled).toHaveBeenCalledWith('test-hook', false);
    expect(emitHookEnabledChanged).toHaveBeenCalledWith('test-hook', false);
  });

  it('stays quiet when the hook already had that state', async () => {
    registry.listRegistrations.mockResolvedValue([row(true)] as never);
    registry.setEnabled.mockResolvedValue(row(true) as never);

    const res = await request(buildApp()).post('/api/hooks/test-hook/enable');

    expect(res.status).toBe(200);
    expect(emitHookEnabledChanged).not.toHaveBeenCalled();
  });

  it('404s an unregistered hook without broadcasting', async () => {
    registry.listRegistrations.mockResolvedValue([] as never);
    registry.setEnabled.mockResolvedValue(null as never);

    const res = await request(buildApp()).post('/api/hooks/test-hook/enable');

    expect(res.status).toBe(404);
    expect(emitHookEnabledChanged).not.toHaveBeenCalled();
  });
});
