/**
 * POST /api/hooks/:hookName/run — `snaglet.hooks.run` from a hook child carries the
 * depth and the hook chain signed into its token, never what
 * the body claims; a person's run starts no chain. Uses the real
 * child-dispatch middleware; the on-demand runner is mocked (its own behavior
 * is covered in runHookOnDemand.test.ts and hookChainLimits.test.ts).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

jest.mock('@snaglet/db', () => ({ getDb: () => ({ query: jest.fn() }) }));
jest.mock('@server/services/customHooks/HookWorkspaceService', () => ({
  hookWorkspaceService: { exists: () => true },
}));
jest.mock('@server/services/customHooks/HookRunLedger', () => ({
  hookRunLedger: { listRecent: jest.fn(), listByHook: jest.fn() },
}));
jest.mock('@server/services/customHooks/HookRegistryService', () => ({
  getHookRegistry: () => ({}),
}));
jest.mock('@server/services/customHooks/resolveDynamicContent', () => ({
  resolveDynamicContent: jest.fn(),
}));
const runHookOnDemand = jest.fn();
jest.mock('@server/services/customHooks/runHookOnDemand', () => ({ runHookOnDemand }));

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

const REFUSED = {
  nodeId: null,
  eventName: 'schedule:fire',
  event: {},
  result: {
    ok: false,
    exitCode: null,
    durationMs: 0,
    stdout: '',
    stderr:
      'Stopped by the nested self-run limit: "test-hook-a" can\'t run itself ' +
      '(snaglet.hooks.run or hook op:run) while it is running. Chain: test-hook-a → test-hook-a.',
    timedOut: false,
  },
};

beforeEach(() => {
  runHookOnDemand.mockReset();
  runHookOnDemand.mockResolvedValue({ hookName: 'test-hook-a', runs: [REFUSED] } as never);
});

describe('POST /api/hooks/:hookName/run chain', () => {
  it('a hook child runs another hook at its signed depth and in its signed chain', async () => {
    const res = await request(buildApp())
      .post('/api/hooks/test-hook-a/run')
      .set(
        'X-Snaglet-Child-Dispatch-Token',
        mintChildDispatchToken('agent-a', 'test-hook-b', 2, ['test-hook-a', 'test-hook-b'])
      )
      .send({ eventName: 'schedule:fire', hookChain: [], chainDepth: 0 });

    expect(res.status).toBe(200);
    expect(runHookOnDemand).toHaveBeenCalledWith('test-hook-a', expect.any(Object), {
      allowDisabled: true,
      contextAgentId: 'agent-a',
      chainDepth: 2,
      hookChain: ['test-hook-a', 'test-hook-b'],
    });
    // A refused run comes back as a run: ok false, the reason in stderr.
    expect(res.body.data.runs).toEqual([REFUSED]);
  });

  it('a person’s run (panel) starts at depth 0 with no chain', async () => {
    const res = await request(buildApp())
      .post('/api/hooks/test-hook-a/run')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({});

    expect(res.status).toBe(200);
    expect(runHookOnDemand).toHaveBeenCalledWith('test-hook-a', expect.any(Object), {
      allowDisabled: true,
      contextAgentId: undefined,
      chainDepth: 0,
      hookChain: [],
    });
  });
});
