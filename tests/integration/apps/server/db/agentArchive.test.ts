/**
 * Agent soft-archive against the real database. Archiving retires an agent
 * without deleting it; agents are actors, not nodes, so they carry their own
 * archived / archived_at columns. Covers:
 *   - Model: archive/restore flip the pair; listings exclude archived agents by
 *     default, per-id lookups still return them, listArchived returns only them.
 *   - Dispatch: partitionArchivedParticipants (used by the socket and tool roster
 *     builders) drops an archived participant but keeps its id resolvable.
 *   - Route: POST /api/archive/:agentId archives; GET /api/archive lists it as a
 *     type:'agent' root; restore round-trips; delete purges. History is untouched.
 */

import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, Agents } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import archiveRouter from '@server/routes/archive';
import { partitionArchivedParticipants } from '@server/services/SocketService/dispatch/partitionArchivedParticipants';

const PREFIX = 'agent-archive-it';
const AGENT_A = `${PREFIX}-a`;
const AGENT_LIVE = `${PREFIX}-live`;
const AGENT_ARCH = `${PREFIX}-arch`;
const AGENT_ROUTE = `${PREFIX}-route`;
const ALL_IDS = [AGENT_A, AGENT_LIVE, AGENT_ARCH, AGENT_ROUTE];

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/archive', archiveRouter);
  app.use(errorHandler);
  return app;
}

async function cleanup() {
  await getDb().query(`DELETE FROM public.agents WHERE id = ANY($1)`, [ALL_IDS]);
}

describe('AgentModel archive/restore + filtered lists (real DB)', () => {
  // Inside the describe so it runs before the shared closeDatabase() teardown; getDbClient() throws after close.
  afterAll(cleanup);

  beforeEach(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_A, name: `${PREFIX} A` });
  });

  it('archive sets archived=true + archived_at; restore clears them', async () => {
    const archived = await Agents.archive(AGENT_A);
    expect(archived?.archived).toBe(true);
    expect(archived?.archivedAt).toBeTruthy();

    const restored = await Agents.restore(AGENT_A);
    expect(restored?.archived).toBe(false);
    expect(restored?.archivedAt).toBeNull();
  });

  it('archive is idempotent and preserves the original archived_at', async () => {
    const first = await Agents.archive(AGENT_A);
    const firstStamp = first?.archivedAt;
    const second = await Agents.archive(AGENT_A);
    expect(second?.archived).toBe(true);
    expect(second?.archivedAt).toBe(firstStamp); // COALESCE keeps the first stamp
  });

  it('archive/restore return null for a missing agent', async () => {
    expect(await Agents.archive('agent-does-not-exist-xyz')).toBeNull();
    expect(await Agents.restore('agent-does-not-exist-xyz')).toBeNull();
  });

  it('default list() excludes archived; includeArchived surfaces it', async () => {
    await Agents.archive(AGENT_A);

    const live = await Agents.list({ limit: 1000 });
    expect(live.map((a) => a.id)).not.toContain(AGENT_A);

    const all = await Agents.list({ limit: 1000, includeArchived: true });
    expect(all.map((a) => a.id)).toContain(AGENT_A);
  });

  it('per-id lookups still return the archived row (attribution + dispatch check)', async () => {
    await Agents.archive(AGENT_A);

    const byId = await Agents.findById(AGENT_A);
    expect(byId?.archived).toBe(true);

    const byIds = await Agents.findByIds([AGENT_A]);
    expect(byIds[0]?.archived).toBe(true);
  });

  it('listArchived returns only archived agents', async () => {
    await Agents.archive(AGENT_A);
    const rows = await Agents.listArchived();
    const mine = rows.find((r) => r.id === AGENT_A);
    expect(mine?.archived).toBe(true);
    // a live agent must not appear
    await Agents.create({ id: AGENT_LIVE, name: `${PREFIX} live` });
    const rows2 = await Agents.listArchived();
    expect(rows2.map((r) => r.id)).not.toContain(AGENT_LIVE);
  });
});

describe('dispatch exclusion — partitionArchivedParticipants (real DB)', () => {
  // Nested for the same reason as the describe above.
  afterAll(cleanup);

  beforeEach(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_LIVE, name: `${PREFIX} live` });
    await Agents.create({ id: AGENT_ARCH, name: `${PREFIX} arch` });
    await Agents.archive(AGENT_ARCH);
  });

  it('drops an archived participant from the live dispatch set', async () => {
    const { liveIds, archivedIds } = await partitionArchivedParticipants([AGENT_LIVE, AGENT_ARCH]);
    expect(liveIds).toEqual([AGENT_LIVE]);
    expect(archivedIds).toEqual([AGENT_ARCH]);
  });
});

describe('archive route — agent archive/restore/delete round-trip (real DB)', () => {
  const app = makeApp();

  // Nested for the same reason as the describes above.
  afterAll(cleanup);

  beforeEach(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_ROUTE, name: `${PREFIX} route` });
  });

  it('POST /api/archive/:agentId archives the agent', async () => {
    const res = await request(app).post(`/api/archive/${AGENT_ROUTE}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.node).toMatchObject({ id: AGENT_ROUTE, type: 'agent', archived: true });

    // Persisted: the agent is now archived and gone from the live roster.
    expect((await Agents.findById(AGENT_ROUTE))?.archived).toBe(true);
    expect((await Agents.list({ limit: 1000 })).map((a) => a.id)).not.toContain(AGENT_ROUTE);
  });

  it('GET /api/archive surfaces the archived agent as a type:agent root', async () => {
    await request(app).post(`/api/archive/${AGENT_ROUTE}`);
    const res = await request(app).get('/api/archive');
    expect(res.status).toBe(200);
    const roots = res.body.data.roots as Array<{ id: string; type: string }>;
    const mine = roots.find((n) => n.id === AGENT_ROUTE);
    expect(mine?.type).toBe('agent');
  });

  it('POST /api/archive/:agentId/restore round-trips it back to live', async () => {
    await request(app).post(`/api/archive/${AGENT_ROUTE}`);
    const res = await request(app).post(`/api/archive/${AGENT_ROUTE}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.data.node).toMatchObject({ id: AGENT_ROUTE, archived: false });

    expect((await Agents.findById(AGENT_ROUTE))?.archived).toBe(false);
    const listed = await request(app).get('/api/archive');
    expect((listed.body.data.roots as Array<{ id: string }>).map((n) => n.id)).not.toContain(
      AGENT_ROUTE
    );
  });

  it('re-archiving an already-archived agent reports alreadyArchived', async () => {
    await request(app).post(`/api/archive/${AGENT_ROUTE}`);
    const res = await request(app).post(`/api/archive/${AGENT_ROUTE}`);
    expect(res.status).toBe(200);
    expect(res.body.data.alreadyArchived).toBe(true);
    expect(res.body.data.affected).toBe(0);
  });

  it('DELETE /api/archive/:agentId deletes the agent for real (ghost purge)', async () => {
    await request(app).post(`/api/archive/${AGENT_ROUTE}`);
    const res = await request(app).delete(`/api/archive/${AGENT_ROUTE}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(1);
    // Delete is the ghost purge, not a tombstone: the agent + member rows
    // are deleted for real and every kept reference is repointed to ghost.
    // (Full destroy/repoint/FK-scan coverage lives in agentSweep.test.ts.)
    expect(await Agents.findById(AGENT_ROUTE)).toBeNull();
    expect((await Agents.listArchived()).map((a) => a.id)).not.toContain(AGENT_ROUTE);
  });
});
