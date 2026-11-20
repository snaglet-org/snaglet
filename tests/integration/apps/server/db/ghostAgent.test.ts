/**
 * Ghost system-agent hardening against the real database. Ghost is the
 * permanent actor that inherits attribution when a real agent is deleted. It is:
 *   - undeletable at three layers: the DELETE routes, the service, and a
 *     BEFORE DELETE trigger;
 *   - unarchivable and unsweepable;
 *   - a reserved name (case-insensitive) for both create and rename;
 *   - hidden from every listing (list, listArchived) yet resolvable by id.
 */

import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, Agents } from '@snaglet/db';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants';
import { agentService } from '@server/services/AgentService';
import { errorHandler } from '@server/middleware';
import agentsRouter from '@server/domains/agents/agents.routes';
import archiveRouter from '@server/routes/archive';

const RENAME_TARGET = 'ghost-hardening-it-rename';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentsRouter);
  app.use('/api/archive', archiveRouter);
  app.use(errorHandler);
  return app;
}

const app = makeApp();

async function cleanup() {
  await getDb().query(`DELETE FROM public.agents WHERE id = $1`, [RENAME_TARGET]);
}

beforeEach(cleanup);

describe('ghost is undeletable at all three layers', () => {
  // Inside the describe so it runs before the shared closeDatabase() teardown; getDbClient() throws after close.
  afterAll(cleanup);

  it('a raw DELETE FROM agents throws (BEFORE DELETE trigger)', async () => {
    await expect(
      getDb().query(`DELETE FROM public.agents WHERE id = $1`, [GHOST_AGENT_ID])
    ).rejects.toThrow(/permanent and cannot be deleted/i);
    // Still present.
    expect((await Agents.findById(GHOST_AGENT_ID))?.id).toBe(GHOST_AGENT_ID);
  });

  it('agentService.purge(ghost) throws and never touches the row', async () => {
    await expect(agentService.purge(GHOST_AGENT_ID)).rejects.toThrow(/cannot be deleted/i);
    expect((await Agents.findById(GHOST_AGENT_ID))?.id).toBe(GHOST_AGENT_ID);
  });

  it('AgentModel.purge(ghost) throws (defense in depth)', async () => {
    await expect(Agents.purge(GHOST_AGENT_ID)).rejects.toThrow(/cannot be deleted/i);
  });

  it('DELETE /api/agents/ghost is 403', async () => {
    const res = await request(app).delete(`/api/agents/${GHOST_AGENT_ID}`);
    expect(res.status).toBe(403);
    expect((await Agents.findById(GHOST_AGENT_ID))?.id).toBe(GHOST_AGENT_ID);
  });

  it('DELETE /api/archive/ghost is 403', async () => {
    const res = await request(app).delete(`/api/archive/${GHOST_AGENT_ID}`);
    expect(res.status).toBe(403);
    expect((await Agents.findById(GHOST_AGENT_ID))?.id).toBe(GHOST_AGENT_ID);
  });
});

describe('ghost cannot be archived', () => {
  // Nested for the same reason as the describe above.
  afterAll(cleanup);

  it('agentService.archive(ghost) throws', async () => {
    await expect(agentService.archive(GHOST_AGENT_ID)).rejects.toThrow(/cannot be archived/i);
    expect((await Agents.findById(GHOST_AGENT_ID))?.archived).toBe(false);
  });

  it('POST /api/archive/ghost is 403 and ghost stays unarchived', async () => {
    const res = await request(app).post(`/api/archive/${GHOST_AGENT_ID}`);
    expect(res.status).toBe(403);
    expect((await Agents.findById(GHOST_AGENT_ID))?.archived).toBe(false);
  });
});

describe('"ghost" is a reserved name (case-insensitive)', () => {
  // Nested for the same reason as the describes above.
  afterAll(cleanup);

  it.each(['ghost', 'GHOST', 'Ghost', '  ghost  '])(
    'POST /api/agents rejects name %p with 400',
    async (name) => {
      const res = await request(app).post('/api/agents').send({ name });
      expect(res.status).toBe(400);
      expect(res.body.error?.message ?? '').toMatch(/reserved/i);
    }
  );

  it('PATCH /api/agents/:id rejects a rename to ghost with 400', async () => {
    await Agents.create({ id: RENAME_TARGET, name: 'Rename Target' });
    const res = await request(app).patch(`/api/agents/${RENAME_TARGET}`).send({ name: 'Ghost' });
    expect(res.status).toBe(400);
    expect(res.body.error?.message ?? '').toMatch(/reserved/i);
    // Name unchanged.
    expect((await Agents.findById(RENAME_TARGET))?.name).toBe('Rename Target');
  });

  it('agentService.update(ghost, …) is rejected (ghost cannot be modified)', async () => {
    await expect(agentService.update(GHOST_AGENT_ID, { role: 'x' })).rejects.toThrow(/cannot be/i);
  });
});

describe('ghost is invisible in listings but resolvable by id', () => {
  // Nested for the same reason as the describes above.
  afterAll(cleanup);

  it('excluded from list / includeArchived list / listArchived', async () => {
    expect((await Agents.list({ limit: 1000 })).map((a) => a.id)).not.toContain(GHOST_AGENT_ID);
    expect(
      (await Agents.list({ limit: 1000, includeArchived: true })).map((a) => a.id)
    ).not.toContain(GHOST_AGENT_ID);
    expect((await Agents.listArchived()).map((a) => a.id)).not.toContain(GHOST_AGENT_ID);
  });

  it('resolvable by findById / findByIds / findByName for attribution', async () => {
    expect((await Agents.findById(GHOST_AGENT_ID))?.name).toBe('ghost');
    expect((await Agents.findByIds([GHOST_AGENT_ID]))[0]?.id).toBe(GHOST_AGENT_ID);
    expect((await Agents.findByName('ghost'))?.id).toBe(GHOST_AGENT_ID);
  });
});
