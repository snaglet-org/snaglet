/**
 * Archiving an automation over HTTP: a deleted (canceled) automation is an
 * archived one. Dragging an Automations view row onto the sidebar trash
 * deletes it (DELETE /api/automations/:id); GET /api/archive then lists it as
 * a root (`type: 'automation'`, archived at its delete); the Archive drawer
 * restores it as it was (POST /api/automations/:id/restore) or deletes it for
 * good (DELETE /api/automations/:id/purge), both people's routes behind the
 * panel token; the generic archive routes never act on one; sweep-all (panel
 * token too) purges every deleted one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';

const broadcast = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...args: unknown[]) => broadcast(...args),
    sendToClient: jest.fn(),
  },
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: async () => ({ ok: true, reason: 'completed', wakeCount: 1, capHit: false }),
}));

import { errorHandler } from '@server/middleware';
import { getPanelToken } from '@server/middleware/panelAuth';
import archiveRoutes from '@server/routes/archive';
import automationsRoutes from '@server/routes/automations';

const AGENT = 'test-agent-a';
const THREAD = 'thread-1111111111111-archaaaaa';

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/automations', automationsRoutes);
  server.use('/api/archive', archiveRoutes);
  server.use(errorHandler);
  return server;
}

const panel = () => ({ 'X-Snaglet-Panel-Token': getPanelToken() });

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await getDb().query<T>(text, params)).rows;
}

interface ArchiveRow {
  id: string;
  type: string;
  title: string | null;
  archived: boolean;
  archived_at: string | null;
  container_id: string | null;
}

async function archivedRoots(): Promise<ArchiveRow[]> {
  const listed = await request(app()).get('/api/archive');
  expect(listed.status).toBe(200);
  return listed.body.data.roots as ArchiveRow[];
}

async function create(name: string, when: Record<string, string> = { every: '1h' }) {
  const created = await request(app())
    .post('/api/automations')
    .set(panel())
    .send({ name, prompt: 'Look at the build.', when, threadId: THREAD, agentId: AGENT });
  expect(created.status).toBe(201);
  return created.body.data.automation as { id: string; scheduleId: string; status: string };
}

describe('archiving automations over HTTP', () => {
  beforeAll(async () => {
    await sql(
      `INSERT INTO public.agents (id, name) VALUES ($1, 'Test Agent A') ON CONFLICT DO NOTHING`,
      [AGENT]
    );
    await sql(
      `INSERT INTO public.members (id, kind, agent_id) VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING`,
      [`${AGENT}-member`, AGENT]
    );
    await sql(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread') ON CONFLICT DO NOTHING`, [
      THREAD,
    ]);
    await sql(
      `INSERT INTO public.threads (id, title) VALUES ($1, 'Archive thread') ON CONFLICT DO NOTHING`,
      [THREAD]
    );
    const [member] = await sql<{ id: string }>(
      `SELECT id FROM public.members WHERE agent_id = $1`,
      [AGENT]
    );
    await sql(
      `INSERT INTO public.thread_participants (thread_id, member_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [THREAD, member!.id]
    );
  });
  beforeEach(async () => {
    await sql(`DELETE FROM public.automations`);
    await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
    broadcast.mockClear();
  });
  afterAll(async () => {
    await sql(`DELETE FROM public.automations`);
    await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
  });

  it('a deleted automation is listed as archived, restores as it was, and only through its own routes', async () => {
    const a = await create('Morning check');
    expect((await archivedRoots()).filter((row) => row.type === 'automation')).toEqual([]);

    // The drop onto the trash: the automation's own delete.
    const deleted = await request(app()).delete(`/api/automations/${a.id}`).set(panel());
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.automation).toMatchObject({ status: 'cancelled', nextRunAt: null });
    expect(broadcast).toHaveBeenCalledWith('workspace', {
      type: 'automations:changed',
      payload: { automationId: a.id },
    });
    const active = await request(app()).get('/api/automations?status=active');
    expect(active.body.data.automations).toEqual([]);

    const [updated] = await sql<{ at: string }>(
      `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
         FROM public.automations WHERE id = $1`,
      [a.id]
    );
    expect((await archivedRoots()).filter((row) => row.type === 'automation')).toEqual([
      expect.objectContaining({
        id: a.id,
        type: 'automation',
        title: 'Morning check',
        archived: true,
        archived_at: updated!.at,
        container_id: null,
      }),
    ]);

    // The generic archive routes never act on an automation (no panel token there).
    expect((await request(app()).post(`/api/archive/${a.id}/restore`)).status).toBe(404);
    expect((await request(app()).delete(`/api/archive/${a.id}`)).status).toBe(404);
    expect((await request(app()).post(`/api/archive/${a.id}`)).status).toBe(404);

    // Restore and purge are people's routes.
    const unauthenticated = await request(app()).post(`/api/automations/${a.id}/restore`);
    expect(unauthenticated.status).toBeGreaterThanOrEqual(401);
    expect(unauthenticated.status).toBeLessThan(404);
    const unauthenticatedPurge = await request(app()).delete(`/api/automations/${a.id}/purge`);
    expect(unauthenticatedPurge.status).toBeGreaterThanOrEqual(401);
    expect(unauthenticatedPurge.status).toBeLessThan(404);

    const restored = await request(app()).post(`/api/automations/${a.id}/restore`).set(panel());
    expect(restored.status).toBe(200);
    expect(restored.body.data.automation).toMatchObject({
      status: 'active',
      scheduleId: a.scheduleId,
    });
    expect(Date.parse(restored.body.data.automation.nextRunAt)).toBeGreaterThan(Date.now());
    expect((await archivedRoots()).filter((row) => row.type === 'automation')).toEqual([]);
    const [schedule] = await sql<{ enabled: boolean }>(
      `SELECT enabled FROM public.schedules WHERE id = $1`,
      [a.scheduleId]
    );
    expect(schedule).toEqual({ enabled: true });
  });

  it('a paused one comes back paused, and a second restore changes nothing', async () => {
    const a = await create('Weekly digest');
    expect((await request(app()).post(`/api/automations/${a.id}/pause`).set(panel())).status).toBe(
      200
    );
    await request(app()).delete(`/api/automations/${a.id}`).set(panel());

    const restored = await request(app()).post(`/api/automations/${a.id}/restore`).set(panel());
    expect(restored.body.data.automation).toMatchObject({
      status: 'paused',
      pausedReason: 'user',
      nextRunAt: null,
    });
    const again = await request(app()).post(`/api/automations/${a.id}/restore`).set(panel());
    expect(again.status).toBe(200);
    expect(again.body.data.automation).toMatchObject({ status: 'paused', pausedReason: 'user' });
  });

  it('purge deletes a deleted one for good and refuses a live one', async () => {
    const a = await create('Build check');
    const live = await request(app()).delete(`/api/automations/${a.id}/purge`).set(panel());
    expect(live.status).toBe(409);
    expect(live.body.error.message).toContain("isn't archived");

    await request(app()).delete(`/api/automations/${a.id}`).set(panel());
    const purged = await request(app()).delete(`/api/automations/${a.id}/purge`).set(panel());
    expect(purged.status).toBe(200);
    expect(purged.body.data.automation).toMatchObject({ id: a.id, status: 'cancelled' });

    expect((await request(app()).get(`/api/automations/${a.id}`)).status).toBe(404);
    expect(
      await sql(`SELECT 1 FROM public.schedules WHERE action_json->>'automationId' = $1`, [a.id])
    ).toEqual([]);
    expect((await archivedRoots()).filter((row) => row.type === 'automation')).toEqual([]);
    expect(
      (await request(app()).delete(`/api/automations/${a.id}/purge`).set(panel())).status
    ).toBe(404);
  });

  it('sweep-all purges every deleted automation and keeps the live ones', async () => {
    const keep = await create('Keep me');
    const gone = await create('Sweep me');
    await request(app()).delete(`/api/automations/${gone.id}`).set(panel());

    // It deletes automations and their run logs for good: people only.
    const refused = await request(app()).post('/api/archive/sweep-all');
    expect(refused.status).toBeGreaterThanOrEqual(401);
    expect(refused.status).toBeLessThan(404);
    expect(
      (await request(app()).get('/api/automations?status=all')).body.data.automations
    ).toHaveLength(2);

    const swept = await request(app()).post('/api/archive/sweep-all').set(panel());
    expect(swept.status).toBe(200);
    expect(swept.body.data.result).toMatchObject({ deletedAutomations: 1 });

    const all = await request(app()).get('/api/automations?status=all');
    expect(all.body.data.automations.map((x: { id: string }) => x.id)).toEqual([keep.id]);
    expect((await archivedRoots()).filter((row) => row.type === 'automation')).toEqual([]);
  });
});
