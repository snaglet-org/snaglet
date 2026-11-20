/**
 * GET /api/hooks/registry — every registration row, each with what the saved
 * code declares (events and schedules) for the Automations list's "When … →
 * run <script>" sentences. Read-only: it reads the in-memory registrations
 * and never builds or registers.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const registry = {
  listRegistrations: jest.fn(),
  getDeclaredMeta: jest.fn(),
  registerHookFolder: jest.fn(),
};
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => registry,
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
jest.mock('@server/services/customHooks/HookWorkspaceService', () => ({
  hookWorkspaceService: {
    exists: (name: string) => name === 'declared',
    getInfo: (name: string) => ({ hookName: name }),
  },
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

const row = (name: string, enabled: boolean) => ({
  id: `registration-${name}`,
  name,
  enabled,
  buildStatus: 'ready',
  lastError: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  registry.getDeclaredMeta.mockReturnValue(null);
});

describe('GET /api/hooks/registry', () => {
  it('adds what each registered hook declares, without its filter', async () => {
    registry.listRegistrations.mockResolvedValue([
      row('test-script-a', true),
      row('test-script-b', false),
    ] as never);
    registry.getDeclaredMeta.mockImplementation((name) =>
      name === 'test-script-a'
        ? {
            events: ['table_entry:create', 'table_entry:update'],
            filter: { status: 'done' },
            schedules: [],
          }
        : { events: [], filter: null, schedules: [{ every: 5, unit: 'minute' }] }
    );

    const res = await request(buildApp()).get('/api/hooks/registry');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        ...row('test-script-a', true),
        declared: { events: ['table_entry:create', 'table_entry:update'], schedules: [] },
      },
      {
        ...row('test-script-b', false),
        declared: { events: [], schedules: [{ every: 5, unit: 'minute' }] },
      },
    ]);
    expect(registry.registerHookFolder).not.toHaveBeenCalled();
  });

  it('says null for a hook that is not registered in memory (not built, or its build failed)', async () => {
    registry.listRegistrations.mockResolvedValue([row('test-script-a', true)] as never);

    const res = await request(buildApp()).get('/api/hooks/registry');

    expect(res.body.data).toEqual([{ ...row('test-script-a', true), declared: null }]);
  });

  it('leaves a script named "declared" to its own route', async () => {
    const res = await request(buildApp()).get('/api/hooks/declared');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hookName: 'declared' });
  });
});
