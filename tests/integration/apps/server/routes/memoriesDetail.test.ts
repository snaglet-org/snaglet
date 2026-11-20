/**
 * GET /api/memories/:id carries the names the memory preview shows beside a
 * memory: the owning agent's name and the source thread's title, against the
 * real database. A name that cannot be given (member-owned memory, no source
 * thread, archived thread) comes back null so the preview keeps its generic
 * chip label.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { Agents, getDb, Members, Memories, Threads } from '@snaglet/db';
import { Users } from '@snaglet/db/tables/users';
import { errorHandler } from '@server/middleware';
import memoriesRouter from '@server/domains/memories/memories.routes';

const PREFIX = 'mem-detail-test';
const AGENT_ID = 'test-agent-a';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const ARCHIVED_THREAD_ID = 'thread-2222222222222-bbbbbbbbb';
const MEMORY = {
  named: 'memory-1111111111111-aaaaaaaaa',
  noThread: 'memory-2222222222222-bbbbbbbbb',
  archivedThread: 'memory-3333333333333-ccccccccc',
  member: 'memory-4444444444444-ddddddddd',
};

const app = express();
app.use(express.json());
app.use('/api/memories', memoriesRouter);
app.use(errorHandler);

let userId: string;

async function detail(id: string) {
  const res = await request(app).get(`/api/memories/${id}`).expect(200);
  return res.body.data as {
    id: string;
    key: string;
    agentId: string | null;
    agentName: string | null;
    sourceThreadId: string | null;
    sourceThreadTitle: string | null;
  };
}

describe('GET /api/memories/:id names (real DB)', () => {
  beforeAll(async () => {
    await Agents.create({ id: AGENT_ID, name: 'Test Agent A' });
    await Threads.create({ id: THREAD_ID, title: 'Test thread' });
    await Threads.create({ id: ARCHIVED_THREAD_ID, title: 'Archived test thread' });
    await getDb().query(
      'UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1',
      [ARCHIVED_THREAD_ID]
    );

    const user = await Users.upsertUser({
      email: 'user@example.com',
      name: 'Test User',
      authProvider: 'test',
      authProviderId: `${PREFIX}-auth`,
    });
    userId = user.id;
    const member = await Members.findByUser(userId);
    if (!member) throw new Error('Expected member row for test user');

    await Memories.create({
      id: MEMORY.named,
      agentId: AGENT_ID,
      key: 'named-memory',
      content: 'Saved in a thread.',
      sourceThreadId: THREAD_ID,
    });
    await Memories.create({
      id: MEMORY.noThread,
      agentId: AGENT_ID,
      key: 'no-thread-memory',
      content: 'Saved by hand.',
    });
    await Memories.create({
      id: MEMORY.archivedThread,
      agentId: AGENT_ID,
      key: 'archived-thread-memory',
      content: 'Saved in a thread that is now archived.',
      sourceThreadId: ARCHIVED_THREAD_ID,
    });
    await Memories.create({
      id: MEMORY.member,
      memberId: member.id,
      key: 'member-memory',
      content: 'A fact about the member.',
      sourceThreadId: THREAD_ID,
      verified: true,
      status: 'active',
    });
  });

  afterAll(async () => {
    const pool = getDb();
    await pool.query('DELETE FROM public.nodes WHERE id = ANY($1)', [
      [...Object.values(MEMORY), THREAD_ID, ARCHIVED_THREAD_ID],
    ]);
    await pool.query('DELETE FROM public.agents WHERE id = $1', [AGENT_ID]);
    await pool.query('DELETE FROM public.users WHERE id = $1', [userId]);
  });

  it("names the memory's agent and source thread", async () => {
    const memory = await detail(MEMORY.named);
    expect(memory).toMatchObject({
      id: MEMORY.named,
      key: 'named-memory',
      agentId: AGENT_ID,
      agentName: 'Test Agent A',
      sourceThreadId: THREAD_ID,
      sourceThreadTitle: 'Test thread',
    });
  });

  it('gives no thread title for a memory saved outside a thread', async () => {
    const memory = await detail(MEMORY.noThread);
    expect(memory.agentName).toBe('Test Agent A');
    expect(memory.sourceThreadId).toBeNull();
    expect(memory.sourceThreadTitle).toBeNull();
  });

  it('leaves out an archived thread’s title', async () => {
    const memory = await detail(MEMORY.archivedThread);
    expect(memory.sourceThreadId).toBe(ARCHIVED_THREAD_ID);
    expect(memory.sourceThreadTitle).toBeNull();
  });

  it('gives no agent name for a member-owned memory', async () => {
    const memory = await detail(MEMORY.member);
    expect(memory.agentId).toBeNull();
    expect(memory.agentName).toBeNull();
    expect(memory.sourceThreadTitle).toBe('Test thread');
  });

  it('still answers 404 for an unknown memory', async () => {
    await request(app).get('/api/memories/memory-9999999999999-zzzzzzzzz').expect(404);
  });
});
