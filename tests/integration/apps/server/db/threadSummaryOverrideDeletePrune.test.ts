/**
 * Deleting a thread drops its per-thread summary-model override in the same
 * transaction; clearing a thread (which keeps it) does not, and a delete that
 * rolls back keeps it too. Real routes, real database, real settings service.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));

import { getDb, Nodes, Threads } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import { registerThreadCrudRoutes } from '@server/domains/threads/handlers/threadCrud';
import { withThreadExecutionPurge } from '@server/services/ThreadExecutionPurgeService';
import { settingsService } from '@server/services/settings';
import { agentSettings } from '@server/services/settings/categories/agent';

const PREFIX = 'summary-override-prune-it';
const DELETED = `thread-${PREFIX}-deleted`;
const CLEARED = `thread-${PREFIX}-cleared`;
const ROLLED_BACK = `thread-${PREFIX}-rolled-back`;
const UNTOUCHED = `thread-${PREFIX}-untouched`;
const THREAD_IDS = [DELETED, CLEARED, ROLLED_BACK, UNTOUCHED];
const ENTRY = { 'test-agent-a': { providerId: 'ollama', modelId: 'qwen2.5:3b' } };

function makeApp() {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerThreadCrudRoutes(router);
  app.use('/threads', router);
  app.use(errorHandler);
  return app;
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.messages WHERE thread_id = ANY($1)`, [THREAD_IDS]);
  await pool.query(`DELETE FROM public.threads WHERE id = ANY($1)`, [THREAD_IDS]);
  await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1)`, [THREAD_IDS]);
}

async function overrideKeys(): Promise<string[]> {
  const map = await settingsService.read(agentSettings.threadSummaryModelOverrides);
  return Object.keys(map).sort();
}

beforeAll(async () => {
  await cleanup();
});

describe('thread delete prunes its summary-model override', () => {
  afterAll(async () => {
    await settingsService.write(agentSettings.threadSummaryModelOverrides, {});
    await cleanup();
  });

  beforeEach(async () => {
    await cleanup();
    for (const id of THREAD_IDS) await Threads.create({ id, title: `${PREFIX} ${id}` });
    await settingsService.write(
      agentSettings.threadSummaryModelOverrides,
      Object.fromEntries(THREAD_IDS.map((id) => [id, ENTRY]))
    );
    // Warm the cache so a stale cached map would show up below.
    await overrideKeys();
  });

  it('removes only the deleted thread entry', async () => {
    const res = await request(makeApp()).delete(`/threads/${DELETED}`);

    expect(res.status).toBe(200);
    expect(await Threads.findById(DELETED)).toBeNull();
    expect(await overrideKeys()).toEqual([CLEARED, ROLLED_BACK, UNTOUCHED].sort());
  });

  it('keeps the entry of a thread that is only cleared', async () => {
    const res = await request(makeApp()).post(`/threads/${CLEARED}/clear`);

    expect(res.status).toBe(200);
    expect(await overrideKeys()).toEqual([...THREAD_IDS].sort());
  });

  it('keeps the entry when the delete rolls back', async () => {
    await expect(
      withThreadExecutionPurge([ROLLED_BACK], async ({ tx }) => {
        await Nodes.deleteOfType(ROLLED_BACK, 'thread', tx);
        throw new Error('delete failed after the node was removed');
      })
    ).rejects.toThrow('delete failed');

    expect(await Threads.findById(ROLLED_BACK)).not.toBeNull();
    expect(await overrideKeys()).toEqual([...THREAD_IDS].sort());
  });
});
