/**
 * Proposed memories: the thread's approval list and the approve route,
 * against the real database. A proposal is member-owned and inert until a
 * human approves it; approving makes it active and verified, and the
 * thread's memory list (`GET /api/memories?agentId&threadId`) then shows it
 * beside the agent's own, until it is deleted.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, Agents, Members, Memories, Threads } from '@snaglet/db';
import { Users } from '@snaglet/db/tables/users';
import { errorHandler } from '@server/middleware';
import memoriesRouter from '@server/domains/memories/memories.routes';

const PREFIX = 'mem-approve-test';
const THREAD_ID = `thread-${PREFIX}`;
const OTHER_THREAD_ID = `thread-${PREFIX}-other`;
const AGENT_ID = `agent-${PREFIX}`;
const OTHER_AGENT_ID = `agent-${PREFIX}-other`;

const app = express();
app.use(express.json());
app.use('/api/memories', memoriesRouter);
app.use(errorHandler);

let userId: string;
let memberId: string;

describe('proposed memories routes (real DB)', () => {
  beforeAll(async () => {
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    await Threads.create({ id: OTHER_THREAD_ID, title: `${PREFIX} other thread` });
    const user = await Users.upsertUser({
      email: `${PREFIX}@test.local`,
      name: `${PREFIX} user`,
      authProvider: 'test',
      authProviderId: `${PREFIX}-auth`,
    });
    userId = user.id;
    const member = await Members.findByUser(userId);
    if (!member) throw new Error('Expected member row for test user');
    memberId = member.id;
    await Memories.create({
      id: `memory-${PREFIX}-p1`,
      memberId,
      key: 'prefers-short-replies',
      content: 'Test User prefers short replies.',
      sourceThreadId: THREAD_ID,
      verified: false,
      status: 'proposed',
    });
    await Memories.create({
      id: `memory-${PREFIX}-p2`,
      memberId,
      key: 'elsewhere',
      content: 'Proposed in another thread.',
      sourceThreadId: OTHER_THREAD_ID,
      verified: false,
      status: 'proposed',
    });
    await Memories.create({
      id: `memory-${PREFIX}-a1`,
      memberId,
      key: 'already-active',
      content: 'Active already.',
      sourceThreadId: THREAD_ID,
      verified: true,
      status: 'active',
    });
    await Agents.create({ id: AGENT_ID, name: `${PREFIX} agent` });
    await Agents.create({ id: OTHER_AGENT_ID, name: `${PREFIX} other agent` });
    await Memories.create({
      id: `memory-${PREFIX}-own`,
      agentId: AGENT_ID,
      key: 'agent-own',
      content: 'The agent saved this here.',
      sourceThreadId: THREAD_ID,
    });
    await Memories.create({
      id: `memory-${PREFIX}-theirs`,
      agentId: OTHER_AGENT_ID,
      key: 'other-agent',
      content: 'Another agent saved this here.',
      sourceThreadId: THREAD_ID,
    });
  });

  afterAll(async () => {
    const pool = getDb();
    await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1)`, [[THREAD_ID, OTHER_THREAD_ID]]);
    await pool.query(`DELETE FROM public.agents WHERE id = ANY($1)`, [[AGENT_ID, OTHER_AGENT_ID]]);
    await pool.query(`DELETE FROM public.users WHERE id = $1`, [userId]);
  });

  it('requires threadId', async () => {
    await request(app).get('/api/memories/proposed').expect(400);
  });

  it('lists only this thread’s proposals', async () => {
    const res = await request(app).get(`/api/memories/proposed?threadId=${THREAD_ID}`).expect(200);
    expect(res.body.data.map((m: { key: string }) => m.key)).toEqual(['prefers-short-replies']);
  });

  it('approves a proposal: active, verified, off the proposed list', async () => {
    const res = await request(app).post(`/api/memories/memory-${PREFIX}-p1/approve`).expect(200);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.verified).toBe(true);
    const list = await request(app).get(`/api/memories/proposed?threadId=${THREAD_ID}`).expect(200);
    expect(list.body.data).toEqual([]);
  });

  it("lists a kept fact in the thread's memory list, beside the agent's own", async () => {
    // p1 was kept above; a1 was active from the start. p2 is still a proposal.
    const res = await request(app)
      .get(`/api/memories?agentId=${AGENT_ID}&threadId=${THREAD_ID}`)
      .expect(200);
    const rows = res.body.data as Array<{ id: string; agentId: string | null; memberId: string }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect([...byId.keys()].sort()).toEqual(
      [`memory-${PREFIX}-a1`, `memory-${PREFIX}-own`, `memory-${PREFIX}-p1`].sort()
    );
    // The kept fact is the member's (the UI marks it "About you").
    expect(byId.get(`memory-${PREFIX}-p1`)).toMatchObject({ agentId: null, memberId });
    expect(byId.get(`memory-${PREFIX}-own`)).toMatchObject({ agentId: AGENT_ID, memberId: null });
    // Never another agent's memory, never a proposal still waiting.
    expect(byId.has(`memory-${PREFIX}-theirs`)).toBe(false);
    expect(byId.has(`memory-${PREFIX}-p2`)).toBe(false);
  });

  it('deleting a kept fact removes it from the list', async () => {
    await request(app).delete(`/api/memories/memory-${PREFIX}-p1`).expect(200);
    const res = await request(app)
      .get(`/api/memories?agentId=${AGENT_ID}&threadId=${THREAD_ID}`)
      .expect(200);
    expect(res.body.data.map((m: { id: string }) => m.id)).not.toContain(`memory-${PREFIX}-p1`);
    expect(await Memories.findById(`memory-${PREFIX}-p1`)).toBeNull();
  });

  it('refuses to approve a memory that is not a proposal, and an unknown one', async () => {
    await request(app).post(`/api/memories/memory-${PREFIX}-a1/approve`).expect(409);
    await request(app).post(`/api/memories/memory-${PREFIX}-nope/approve`).expect(404);
  });

  it('dismissing deletes the proposal', async () => {
    await request(app).delete(`/api/memories/memory-${PREFIX}-p2`).expect(200);
    expect(await Memories.findById(`memory-${PREFIX}-p2`)).toBeNull();
  });
});
