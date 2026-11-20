/**
 * POST /api/hooks/signal — custom signals from hook/tool code
 * (`snaglet.emit`). Uses the real child-dispatch middleware and the real hook bus:
 *
 *   - only a signed child-dispatch credential may emit (a panel caller is a
 *     person, and people don't emit signals);
 *   - the event carries the hook name and depth signed into the token, never
 *     anything the body claims, and is emitted AT that depth;
 *   - names and data sizes are validated before anything is emitted.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';

jest.mock('@snaglet/db', () => ({ getDb: () => ({ query: jest.fn() }) }));
jest.mock('@server/services/customHooks/HookWorkspaceService', () => ({
  hookWorkspaceService: { exists: jest.fn() },
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

import hooksRouter from '@server/routes/hooks';
import { errorHandler } from '@server/middleware';
import { getPanelToken, mintChildDispatchToken } from '@server/middleware/panelAuth';
import { currentChainDepth, currentHookChain } from '@server/realtime/runContext';
import { hooks, type HookEventMap } from '@server/services/HookService';

function buildApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/hooks', hooksRouter);
  app.use(errorHandler);
  return app;
}

const received: Array<{
  payload: HookEventMap['hook:signal'];
  ambient: number;
  chain: readonly string[];
}> = [];
hooks.on('hook:signal', (payload) => {
  received.push({ payload, ambient: currentChainDepth(), chain: currentHookChain() });
});

beforeEach(() => {
  received.length = 0;
});

describe('POST /api/hooks/signal', () => {
  it('emits hook:signal with the signed hook name and depth, at that depth', async () => {
    const res = await request(buildApp())
      .post('/api/hooks/signal')
      .set(
        'X-Snaglet-Child-Dispatch-Token',
        mintChildDispatchToken('agent-a', 'digest-hook', 2, ['test-hook-a', 'digest-hook'])
      )
      .send({ name: 'digest.ready', data: { count: 3 }, chainDepth: 0, hookName: 'spoofed' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ emitted: 'digest.ready', chainDepth: 2 });
    expect(received).toEqual([
      {
        payload: {
          name: 'digest.ready',
          data: { count: 3 },
          hookName: 'digest-hook',
          agentId: 'agent-a',
          chainDepth: 2,
        },
        ambient: 2,
        // Emitted in the emitter's signed chain, so a hook on its own signal
        // is stopped by the chain guard.
        chain: ['test-hook-a', 'digest-hook'],
      },
    ]);
  });

  it('a tool child without a hook name or depth emits at depth 0 with hookName null', async () => {
    const res = await request(buildApp())
      .post('/api/hooks/signal')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-a'))
      .send({ name: 'ping' });

    expect(res.status).toBe(200);
    expect(received[0]?.payload).toEqual({
      name: 'ping',
      data: null,
      hookName: null,
      agentId: 'agent-a',
      chainDepth: 0,
    });
  });

  it('refuses a panel caller: signals come from hook or tool code only', async () => {
    const res = await request(buildApp())
      .post('/api/hooks/signal')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ name: 'ping' });

    expect(res.status).toBe(403);
    expect(received).toEqual([]);
  });

  it('refuses a forged token', async () => {
    const res = await request(buildApp())
      .post('/api/hooks/signal')
      .set('X-Snaglet-Child-Dispatch-Token', 'forged.token')
      .send({ name: 'ping' });

    expect(res.status).toBe(403);
    expect(received).toEqual([]);
  });

  it.each([[''], ['Has-Caps'], ['-leading'], ['a'.repeat(65)], [42]])(
    'refuses the signal name %p',
    async (name) => {
      const res = await request(buildApp())
        .post('/api/hooks/signal')
        .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-a', 'h'))
        .send({ name });

      expect(res.status).toBe(400);
      expect(received).toEqual([]);
    }
  );

  it('refuses data over 16,000 characters of JSON', async () => {
    const res = await request(buildApp())
      .post('/api/hooks/signal')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-a', 'h'))
      .send({ name: 'big', data: 'x'.repeat(16_001) });

    expect(res.status).toBe(400);
    expect(received).toEqual([]);
  });
});
