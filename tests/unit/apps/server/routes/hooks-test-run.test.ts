/**
 * /api/hooks/:hookName/check + /run — the hook builder test console's server
 * contract. Registry + workspace service are mocked; resolveHookInvocations
 * runs for real against a mocked db. check returns { registration, declared }
 * (a failed build shows as registration.lastError with declared: null); run
 * passes an explicit due-now schedule:fire event through unchanged,
 * synthesizes one when no input is given, and rejects a non-object event
 * with a 400 before anything executes.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

const query = jest.fn();
jest.mock('@snaglet/db', () => ({ getDb: () => ({ query }) }));

const workspaceExists = jest.fn();
jest.mock('@server/services/customHooks/HookWorkspaceService', () => ({
  hookWorkspaceService: { exists: workspaceExists },
}));

const listRecentRuns = jest.fn();
const listRunsByHook = jest.fn();
jest.mock('@server/services/customHooks/HookRunLedger', () => ({
  hookRunLedger: {
    listRecent: listRecentRuns,
    listByHook: listRunsByHook,
  },
}));

const registry = {
  registerHookFolder: jest.fn(),
  listRegistrations: jest.fn(),
  getDeclaredMeta: jest.fn(),
  runForTest: jest.fn(),
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

import hooksRouter from '@server/routes/hooks';
import { errorHandler } from '@server/middleware';

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/hooks', hooksRouter);
  app.use(errorHandler);
  return app;
}

const READY_ROW = {
  id: 'hook_abc',
  name: 'daily-digest',
  enabled: true,
  buildStatus: 'ready',
  lastError: null,
};

const OK_RESULT = {
  ok: true,
  exitCode: 0,
  durationMs: 12,
  stdout: 'ran\n',
  stderr: '',
  timedOut: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  workspaceExists.mockReturnValue(true);
  registry.registerHookFolder.mockResolvedValue(undefined as never);
  registry.listRegistrations.mockResolvedValue([READY_ROW] as never);
  registry.getDeclaredMeta.mockReturnValue(null);
  registry.runForTest.mockResolvedValue(OK_RESULT as never);
  listRecentRuns.mockResolvedValue([] as never);
  listRunsByHook.mockResolvedValue([] as never);
});

describe('GET /api/hooks run history', () => {
  it('keeps the static recent route separate from hook workspace ids', async () => {
    listRecentRuns.mockResolvedValue([{ id: 'hook-run-1' }] as never);

    const res = await request(buildApp()).get('/api/hooks/runs/recent?limit=12');

    expect(res.status).toBe(200);
    expect(listRecentRuns).toHaveBeenCalledWith(12);
    expect(res.body.data).toEqual([{ id: 'hook-run-1' }]);
    expect(workspaceExists).not.toHaveBeenCalledWith('runs');
  });

  it('lists one hook ledger newest-first through the service contract', async () => {
    listRunsByHook.mockResolvedValue([{ id: 'hook-run-2' }] as never);

    const res = await request(buildApp()).get('/api/hooks/daily-digest/runs?limit=40');

    expect(res.status).toBe(200);
    expect(listRunsByHook).toHaveBeenCalledWith('daily-digest', 40);
    expect(res.body.data).toEqual([{ id: 'hook-run-2' }]);
  });
});

describe('POST /api/hooks/:hookName/check — registration + declared meta', () => {
  it('returns the registration row alongside what the saved code declares', async () => {
    const declared = {
      events: ['message:create'],
      filter: null,
      schedules: [{ every: 15, unit: 'minute' }],
    };
    registry.getDeclaredMeta.mockReturnValue(declared);

    const res = await request(buildApp()).post('/api/hooks/daily-digest/check');

    expect(res.status).toBe(200);
    expect(registry.registerHookFolder).toHaveBeenCalledWith('daily-digest');
    expect(res.body.data.registration).toEqual(READY_ROW);
    expect(res.body.data.declared).toEqual(declared);
  });

  it('reports a failed build as registration.lastError with declared: null', async () => {
    registry.listRegistrations.mockResolvedValue([
      { ...READY_ROW, buildStatus: 'failed', lastError: 'tool.ts(3): unexpected token' },
    ] as never);
    registry.getDeclaredMeta.mockReturnValue(null);

    const res = await request(buildApp()).post('/api/hooks/daily-digest/check');

    expect(res.status).toBe(200);
    expect(res.body.data.registration.buildStatus).toBe('failed');
    expect(res.body.data.registration.lastError).toMatch(/unexpected token/);
    expect(res.body.data.declared).toBeNull();
  });

  it('404s for a hook workspace that does not exist', async () => {
    workspaceExists.mockReturnValue(false);
    const res = await request(buildApp()).post('/api/hooks/ghost/check');
    expect(res.status).toBe(404);
    expect(registry.registerHookFolder).not.toHaveBeenCalled();
  });
});

describe('POST /api/hooks/:hookName/run — test-console input handling', () => {
  it('delivers a synthesized due-now schedule:fire event unchanged (Trigger now)', async () => {
    const event = {
      scheduleId: 'schedule-123',
      runId: 'test-1111111111111',
      scheduledFor: '2026-07-29T12:00:00.000Z',
    };

    const res = await request(buildApp())
      .post('/api/hooks/daily-digest/run')
      .send({ eventName: 'schedule:fire', event });

    expect(res.status).toBe(200);
    expect(registry.runForTest).toHaveBeenCalledTimes(1);
    expect(registry.runForTest).toHaveBeenCalledWith(
      expect.objectContaining({
        hookName: 'daily-digest',
        eventName: 'schedule:fire',
        event,
      })
    );
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.runs[0]).toEqual({
      nodeId: null,
      eventName: 'schedule:fire',
      event,
      result: OK_RESULT,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('still synthesizes a manual schedule:fire when no input is given at all', async () => {
    const res = await request(buildApp()).post('/api/hooks/daily-digest/run').send({});

    expect(res.status).toBe(200);
    const call = registry.runForTest.mock.calls[0][0] as {
      eventName: string;
      event: Record<string, unknown>;
    };
    expect(call.eventName).toBe('schedule:fire');
    expect(call.event).toEqual(
      expect.objectContaining({
        scheduleId: 'manual:daily-digest',
        scheduledFor: expect.any(String),
      })
    );
  });

  it('resolves a node id into the real lifecycle payload and reports it per run', async () => {
    query.mockResolvedValueOnce({ rows: [{ type: 'message' }] } as never).mockResolvedValueOnce({
      rows: [
        {
          id: 'message-1',
          thread_id: 'thread-1',
          role: 'assistant',
          agent_id: 'agent-1',
          content: 'hello',
        },
      ],
    } as never);

    const res = await request(buildApp())
      .post('/api/hooks/daily-digest/run')
      .send({ nodeIds: ['message-1'] });

    expect(res.status).toBe(200);
    expect(res.body.data.runs[0].nodeId).toBe('message-1');
    expect(res.body.data.runs[0].eventName).toBe('message:create');
    expect(res.body.data.runs[0].event).toEqual({
      id: 'message-1',
      threadId: 'thread-1',
      role: 'agent',
      agentId: 'agent-1',
      text: 'hello',
      chars: 5,
    });
  });

  it('400s a non-object event before anything executes', async () => {
    const res = await request(buildApp())
      .post('/api/hooks/daily-digest/run')
      .send({ eventName: 'schedule:fire', event: [1, 2, 3] });

    expect(res.status).toBe(400);
    expect(registry.runForTest).not.toHaveBeenCalled();
  });
});
