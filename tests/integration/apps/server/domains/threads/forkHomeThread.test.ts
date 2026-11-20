/**
 * POST /api/threads/:id/fork forks a home thread into a workspace thread, against
 * a real database. The copy is faithful and atomic: order, authors, original
 * timestamps and message metadata are kept; runs and agent_activity_log are
 * copied with run_id remapped; placement works with or without a project; empty
 * and non-DM threads are refused (400); a mid-copy failure rolls everything
 * back; the source thread is left as it was. Only the socket fan-out and hook
 * bus are stubbed, as in threadCreateAtomic.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import {
  Agents,
  Nodes,
  SkillAssignments,
  ThreadParticipants,
  Threads,
  Users,
  getDb,
} from '@snaglet/db';
import { NODE_KIND } from '@snaglet/shared/constants';
import { errorHandler } from '@server/middleware';
import { registerForkRoutes } from '@server/domains/threads/handlers/forkHandlers';
import { hooks } from '@server/services/HookService';
import { wsService } from '@server/services/WebSocketService';
import { DmService } from '@server/services/dm/DmService';

const AGENT_ID = 'fork-agent-a';
const AGENT_B_ID = 'fork-agent-b';

let app: express.Application;
let userId: string;

beforeAll(async () => {
  if (!(await Agents.findById(AGENT_ID)))
    await Agents.create({ id: AGENT_ID, name: 'Fork Agent A' });
  if (!(await Agents.findById(AGENT_B_ID)))
    await Agents.create({ id: AGENT_B_ID, name: 'Fork Agent B' });
  userId = (await Users.getOrCreateLocalUser()).id;

  const instance = express();
  instance.use(express.json());
  const router = express.Router();
  registerForkRoutes(router);
  instance.use('/api/threads', router);
  instance.use(errorHandler);
  app = instance;
});

beforeEach(() => {
  // Keep realtime quiet but let the route run end to end.
  jest.spyOn(wsService, 'broadcastToChannel').mockImplementation(() => undefined as never);
  jest.spyOn(hooks, 'emit').mockImplementation(() => undefined as never);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const db = () => getDb();

let threadSeq = 0;

/**
 * Create a home DM thread for a fresh agent each call, so every test gets its
 * own thread (a user↔agent pair is deduped by DmService, so reusing an agent
 * would reuse the thread and collide on re-seed).
 */
async function createHomeThread(): Promise<string> {
  threadSeq += 1;
  const agentId = `fork-home-agent-${threadSeq}`;
  if (!(await Agents.findById(agentId)))
    await Agents.create({ id: agentId, name: `Fork Agent A ${threadSeq}` });
  const thread = await DmService.findOrCreate({ kind: 'user', userId }, { kind: 'agent', agentId });
  return thread.id;
}

/** The agent participant of a home thread created by {@link createHomeThread}. */
async function agentOf(threadId: string): Promise<string> {
  const participants = await ThreadParticipants.listByThread(threadId);
  return participants.find((p) => p.kind === 'agent' && p.agentId)!.agentId!;
}

interface SeedMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  agentId?: string | null;
  userId?: string | null;
  metadata?: Record<string, unknown>;
  runId?: string | null;
  messageType?: string;
}

/** Insert a message row directly (bypassing MessageModel's author guards). */
async function seedMessage(threadId: string, m: SeedMessage): Promise<void> {
  await Nodes.ensure(m.id, NODE_KIND.MESSAGE);
  await db().query(
    `INSERT INTO public.messages
       (id, thread_id, user_id, agent_id, role, content, message_type, resolved, metadata, run_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8::jsonb,$9,$10)`,
    [
      m.id,
      threadId,
      m.userId ?? null,
      m.agentId ?? null,
      m.role,
      m.content,
      m.messageType ?? 'message',
      JSON.stringify(m.metadata ?? {}),
      m.runId ?? null,
      m.createdAt,
    ]
  );
}

async function seedRun(threadId: string, runId: string, agentId: string): Promise<void> {
  await db().query(
    `INSERT INTO public.runs
       (id, thread_id, agent_id, provider_id, model, status, started_at, finished_at, input_tokens, output_tokens)
     VALUES ($1,$2,$3,'anthropic','claude','completed', now(), now(), 100, 50)`,
    [runId, threadId, agentId]
  );
}

async function seedActivity(runId: string, tool: string, agentId: string): Promise<void> {
  await db().query(
    `INSERT INTO public.agent_activity_log
       (id, agent_id, action_type, trigger_type, reason, tool, tool_input, run_id)
     VALUES (gen_random_uuid()::text, $1, 'tool_call', 'message_received', 'calling a tool', $2, $3::jsonb, $4)`,
    [agentId, tool, JSON.stringify({ q: 'hi' }), runId]
  );
}

/** A home thread with two messages, a run, and a tool-call activity row. */
async function seedConversation(threadId: string): Promise<{ runId: string; agentId: string }> {
  const agentId = await agentOf(threadId);
  const runId = `fork-run-${threadId}`;
  await seedRun(threadId, runId, agentId);
  await seedActivity(runId, 'search', agentId);
  await seedMessage(threadId, {
    id: `fork-msg-1-${threadId}`,
    role: 'user',
    content: 'first — what is up?',
    userId,
    createdAt: '2026-11-06T10:00:00.000Z',
  });
  await seedMessage(threadId, {
    id: `fork-msg-2-${threadId}`,
    role: 'assistant',
    content: 'second — here is an answer with <image id="img-1"/>',
    agentId,
    runId,
    // The folded tool-activity + usage a real assistant row carries.
    metadata: {
      tool_activity: [{ tool: 'search', status: 'ok' }],
      usage: { inputTokens: 100, outputTokens: 50 },
    },
    createdAt: '2026-11-06T10:00:05.000Z',
  });
  return { runId, agentId };
}

interface MsgRow {
  id: string;
  role: string;
  content: string;
  agent_id: string | null;
  user_id: string | null;
  created_at: Date;
  metadata: Record<string, unknown>;
  run_id: string | null;
}

async function messagesOf(threadId: string): Promise<MsgRow[]> {
  const { rows } = await db().query<MsgRow>(
    `SELECT id, role, content, agent_id, user_id, created_at, metadata, run_id
       FROM public.messages WHERE thread_id = $1 ORDER BY created_at ASC, id ASC`,
    [threadId]
  );
  return rows;
}

describe('POST /api/threads/:id/fork', () => {
  it('preserves order, authors, timestamps and metadata; copies runs + tool-call records', async () => {
    const source = await createHomeThread();
    const { runId: sourceRunId, agentId } = await seedConversation(source);

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Forked' });
    expect(res.status).toBe(201);
    const created = res.body.data;
    const newId = created.id as string;
    expect(newId).not.toBe(source);
    expect(created.kind).toBe('chat');
    expect(created.projectId ?? null).toBeNull();

    const copied = await messagesOf(newId);
    const original = await messagesOf(source);
    expect(copied).toHaveLength(2);

    // Order + authors + content + original timestamps preserved.
    expect(copied.map((m) => m.content)).toEqual(original.map((m) => m.content));
    expect(copied.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(copied[0]!.user_id).toBe(userId);
    expect(copied[0]!.agent_id).toBeNull();
    expect(copied[1]!.agent_id).toBe(agentId);
    expect(copied[1]!.user_id).toBeNull();
    const asMs = (v: unknown) => new Date(v as string | Date).getTime();
    expect(copied.map((m) => asMs(m.created_at))).toEqual(original.map((m) => asMs(m.created_at)));
    // New ids — the copy is not the same rows.
    expect(copied.map((m) => m.id)).not.toEqual(original.map((m) => m.id));

    // The copies' node rows keep the source nodes' timestamps, so search and
    // "recent" views see old history, not new activity.
    const nodeTimes = async (ids: string[]) =>
      (
        await db().query<{ id: string; created_at: Date; updated_at: Date }>(
          `SELECT id, created_at, updated_at FROM public.nodes WHERE id = ANY($1::text[])`,
          [ids]
        )
      ).rows;
    const srcNodes = await nodeTimes(original.map((m) => m.id));
    const newNodes = await nodeTimes(copied.map((m) => m.id));
    expect(newNodes).toHaveLength(2);
    const byOrder = (rows: typeof srcNodes, ids: string[]) =>
      ids
        .map((id) => rows.find((r) => r.id === id)!)
        .map((r) => [asMs(r.created_at), asMs(r.updated_at)]);
    expect(
      byOrder(
        newNodes,
        copied.map((m) => m.id)
      )
    ).toEqual(
      byOrder(
        srcNodes,
        original.map((m) => m.id)
      )
    );

    // Metadata (the folded tool-activity / usage) travels verbatim.
    expect(copied[1]!.metadata).toEqual(original[1]!.metadata);

    // Runs copied with a new id; the copied message points at the copied run.
    const { rows: newRuns } = await db().query<{ id: string }>(
      `SELECT id FROM public.runs WHERE thread_id = $1`,
      [newId]
    );
    expect(newRuns).toHaveLength(1);
    const newRunId = newRuns[0]!.id;
    expect(newRunId).not.toBe(sourceRunId);
    expect(copied[1]!.run_id).toBe(newRunId);

    // Tool-call records copied and remapped onto the copied run.
    const { rows: newActivity } = await db().query<{ tool: string; run_id: string }>(
      `SELECT tool, run_id FROM public.agent_activity_log WHERE run_id = $1`,
      [newRunId]
    );
    expect(newActivity).toHaveLength(1);
    expect(newActivity[0]!.tool).toBe('search');

    // Source thread is untouched: same rows, same ids, nothing added.
    expect(original.map((m) => m.id)).toEqual([`fork-msg-1-${source}`, `fork-msg-2-${source}`]);
    const { rows: srcRuns } = await db().query<{ id: string }>(
      `SELECT id FROM public.runs WHERE thread_id = $1`,
      [source]
    );
    expect(srcRuns.map((r) => r.id)).toEqual([sourceRunId]);
  });

  it('places the fork in a project when one is given', async () => {
    const source = await createHomeThread();
    await seedConversation(source);
    const project = await Nodes.ensure(`fork-project-${source}`, NODE_KIND.CONTAINER);
    await db().query(
      `INSERT INTO public.containers (id, name, category) VALUES ($1, 'Fork Project', 'project')`,
      [project]
    );

    const res = await request(app)
      .post(`/api/threads/${source}/fork`)
      .send({ title: 'Forked into project', projectId: project });
    expect(res.status).toBe(201);
    expect(res.body.data.projectId).toBe(project);
  });

  it('refuses an empty thread with 400 and writes nothing', async () => {
    const source = await createHomeThread();
    const before = await db().query(`SELECT count(*)::int AS n FROM public.threads`);
    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Nope' });
    expect(res.status).toBe(400);
    const after = await db().query(`SELECT count(*)::int AS n FROM public.threads`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('refuses a regular (non-DM) thread with 400', async () => {
    const chat = await Threads.create({ id: `fork-chat-${Date.now()}`, title: 'Regular thread' });
    const res = await request(app).post(`/api/threads/${chat.id}/fork`).send({ title: 'Nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/regular thread|home thread or DM/i);
  });

  it('refuses an agent-to-agent DM (no human member) with 400', async () => {
    const dm = await DmService.findOrCreate(
      { kind: 'agent', agentId: AGENT_ID },
      { kind: 'agent', agentId: AGENT_B_ID }
    );
    await seedMessage(dm.id, {
      id: `fork-aa-msg-${dm.id}`,
      role: 'assistant',
      content: 'hi peer',
      agentId: AGENT_ID,
      createdAt: '2026-11-06T10:00:00.000Z',
    });
    const res = await request(app).post(`/api/threads/${dm.id}/fork`).send({ title: 'Nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/human member|home thread/i);
  });

  it('rolls back the whole copy when a write fails mid-way (no new thread)', async () => {
    const source = await createHomeThread();
    await seedConversation(source);
    const threadsBefore = await db().query(`SELECT count(*)::int AS n FROM public.threads`);

    // Fail on the participant write, which runs last — after the thread row,
    // runs, activity and every message are already in the tx. They must all
    // roll back together.
    jest.spyOn(ThreadParticipants, 'addParticipant').mockImplementationOnce(async () => {
      throw new Error('injected mid-copy failure');
    });

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Boom' });
    expect(res.status).toBeGreaterThanOrEqual(500);

    // No new thread survived the rolled-back transaction.
    const threadsAfter = await db().query(`SELECT count(*)::int AS n FROM public.threads`);
    expect(threadsAfter.rows[0]!.n).toBe(threadsBefore.rows[0]!.n);
    // The source thread still has exactly its two seeded messages, untouched.
    const source2 = await messagesOf(source);
    expect(source2.map((m) => m.id)).toEqual([`fork-msg-1-${source}`, `fork-msg-2-${source}`]);
  });

  it('refuses with 409 while the source thread has an active run', async () => {
    const source = await createHomeThread();
    await seedConversation(source);

    // Hold the source the way Clear's purge reservation does: reserveThreadPurge
    // returns false for anyone else, so the fork handler answers 409.
    const { activeRunTracker } = await import('@server/services/ActiveRunTracker');
    expect(activeRunTracker.reserveThreadPurge(source)).toBe(true);
    try {
      const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Nope' });
      expect(res.status).toBe(409);
      expect(typeof res.body.error.message).toBe('string');
    } finally {
      activeRunTracker.releaseThreadPurge(source);
    }

    // Nothing was created.
    const forks = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.threads WHERE title = 'Nope'`
    );
    expect(forks.rows[0]!.n).toBe(0);
  });

  it('keeps the whole history readable after the source thread is cleared', async () => {
    const source = await createHomeThread();
    const { runId } = await seedConversation(source);

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Kept' });
    expect(res.status).toBe(201);
    const forkId = res.body.data.id as string;

    // Simulate a Clear: delete the source's activity, runs and messages.
    await db().query(`DELETE FROM public.agent_activity_log WHERE run_id = $1`, [runId]);
    await db().query(`DELETE FROM public.messages WHERE thread_id = $1`, [source]);
    await db().query(`DELETE FROM public.runs WHERE thread_id = $1`, [source]);

    // The fork still has both messages, in order, and the copied activity row.
    const forked = await messagesOf(forkId);
    expect(forked.map((m) => m.content)).toEqual([
      'first — what is up?',
      'second — here is an answer with <image id="img-1"/>',
    ]);
    const act = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.agent_activity_log a
         JOIN public.runs r ON r.id = a.run_id WHERE r.thread_id = $1`,
      [forkId]
    );
    expect(act.rows[0]!.n).toBe(1);
  });

  it('keeps message order stable when created_at ties (orders by created_at, id)', async () => {
    const source = await createHomeThread();
    const agentId = await agentOf(source);
    const sameTs = '2026-11-06T12:00:00.000Z';
    // Three messages with an identical created_at; their id order is the tie-break.
    for (const n of [1, 2, 3]) {
      await seedMessage(source, {
        id: `fork-tie-${n}-${source}`,
        role: 'assistant',
        content: `tie-${n}`,
        agentId,
        createdAt: sameTs,
      });
    }
    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Ties' });
    expect(res.status).toBe(201);
    const forked = await messagesOf(res.body.data.id as string);
    // Same relative order as the source (created_at tie broken by id ascending).
    expect(forked.map((m) => m.content)).toEqual(['tie-1', 'tie-2', 'tie-3']);
  });

  it('copies the agent\u2019s per-thread overrides (model, tool access, instructions)', async () => {
    const source = await createHomeThread();
    await seedConversation(source);
    const agentId = await agentOf(source);
    // Set overrides on the source agent participant.
    await ThreadParticipants.addParticipant({
      threadId: source,
      agentId,
      modelId: 'claude-sonnet-4-5',
      systemPromptAddendum: 'Be terse.',
      toolAccessMode: 'allow_list',
      toolAccessAllowList: ['search', 'doc'],
    });

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Overrides' });
    expect(res.status).toBe(201);
    const forkId = res.body.data.id as string;

    const { rows } = await db().query<{
      model_id: string | null;
      system_prompt_addendum: string | null;
      tool_access_mode: string | null;
      tool_access_allow_list: unknown;
    }>(
      `SELECT tp.model_id, tp.system_prompt_addendum, tp.tool_access_mode, tp.tool_access_allow_list
         FROM public.thread_participants tp
         JOIN public.members m ON m.id = tp.member_id
        WHERE tp.thread_id = $1 AND m.agent_id = $2`,
      [forkId, agentId]
    );
    expect(rows[0]!.model_id).toBe('claude-sonnet-4-5');
    expect(rows[0]!.system_prompt_addendum).toBe('Be terse.');
    expect(rows[0]!.tool_access_mode).toBe('allow_list');
    expect(rows[0]!.tool_access_allow_list).toEqual(['search', 'doc']);
  });

  it('mints forked message ids in the normal node-ref shape (no extra `-` segment)', async () => {
    // A chip or reply citing a forked message must resolve, so the ids must
    // match the same `message-<10+digits>-<alphanumeric>` body the node-ref
    // renderer, the reply checker and the voice filter all accept. An extra
    // `-NNN` counter segment would make them dead text.
    const NODE_REF_MESSAGE = /^message-\d{10,}-[A-Za-z0-9]+$/;
    const source = await createHomeThread();
    await seedConversation(source);
    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Shape' });
    expect(res.status).toBe(201);
    const copied = await messagesOf(res.body.data.id as string);
    expect(copied).toHaveLength(2);
    for (const m of copied) expect(m.id).toMatch(NODE_REF_MESSAGE);
    // The ids still sort in source order (the read path orders by id on ties).
    expect([...copied].map((m) => m.id)).toEqual([...copied].map((m) => m.id).sort());
  });

  it('returns 404 for an unknown source thread', async () => {
    const res = await request(app)
      .post('/api/threads/thread-does-not-exist/fork')
      .send({ title: 'Ghost' });
    expect(res.status).toBe(404);
    expect(res.body.error.message).toMatch(/not found/i);
  });

  it('refuses with 409 while a real active run holds the thread (not a mocked tracker)', async () => {
    const source = await createHomeThread();
    await seedConversation(source);
    const { activeRunTracker } = await import('@server/services/ActiveRunTracker');
    // A genuine active run on the thread: reserveThreadPurge refuses, so the
    // fork route answers 409 without touching the tracker's internals.
    const sessionId = `real-run-${source}`;
    expect(activeRunTracker.startSession(sessionId, source)).toBe(true);
    try {
      const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Busy' });
      expect(res.status).toBe(409);
    } finally {
      activeRunTracker.finishSession(sessionId);
    }
    const forks = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.threads WHERE title = 'Busy'`
    );
    expect(forks.rows[0]!.n).toBe(0);
  });

  it('emits realtime surface events for the new thread on a successful fork', async () => {
    const source = await createHomeThread();
    await seedConversation(source);
    const broadcast = jest.spyOn(wsService, 'broadcastToChannel');
    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Events' });
    expect(res.status).toBe(201);
    const forkId = res.body.data.id as string;
    // The tree + threads surface emitters broadcast on the 'workspace' channel
    // synchronously before the response (the thread-create hook is
    // fire-and-forget, so it is not asserted here). A `thread.created` message
    // for the new thread must have gone out.
    const threadCreated = broadcast.mock.calls.find(
      ([channel, message]) =>
        channel === 'workspace' &&
        (message as { type?: string }).type === 'thread.created' &&
        JSON.stringify((message as { payload?: unknown }).payload ?? '').includes(forkId)
    );
    expect(threadCreated).toBeDefined();
  });

  it('copies the working folder and the disable-model-fallback override', async () => {
    const source = await createHomeThread();
    await seedConversation(source);
    const agentId = await agentOf(source);
    // Seed a working folder on the thread and the fallback flag on the
    // participant — neither flows through addParticipant, so set them directly.
    await db().query(`UPDATE public.threads SET working_directory = $2 WHERE id = $1`, [
      source,
      '/tmp/fork-src',
    ]);
    await db().query(
      `UPDATE public.thread_participants tp
          SET disable_model_fallback = true
         FROM public.members m
        WHERE m.id = tp.member_id AND tp.thread_id = $1 AND m.agent_id = $2`,
      [source, agentId]
    );

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Carry' });
    expect(res.status).toBe(201);
    const forkId = res.body.data.id as string;

    const thread = await db().query<{ working_directory: string | null }>(
      `SELECT working_directory FROM public.threads WHERE id = $1`,
      [forkId]
    );
    expect(thread.rows[0]!.working_directory).toBe('/tmp/fork-src');

    const tp = await db().query<{ disable_model_fallback: boolean }>(
      `SELECT tp.disable_model_fallback
         FROM public.thread_participants tp
         JOIN public.members m ON m.id = tp.member_id
        WHERE tp.thread_id = $1 AND m.agent_id = $2`,
      [forkId, agentId]
    );
    expect(tp.rows[0]!.disable_model_fallback).toBe(true);
  });

  it('refuses a folder (non-project) container target with a clear 4xx (not a 500)', async () => {
    // A thread is scoped by project_id, never a folder container.
    // Threads.create validates the target; a non-project container id is
    // rejected as a project, so the fork is refused with a clear 4xx (not 500)
    // and nothing is created. A flat fork (no projectId) always works.
    const source = await createHomeThread();
    await seedConversation(source);
    // A plain folder container: category is NULL (a folder has no category).
    const folder = await Nodes.ensure(`fork-folder-${source}`, NODE_KIND.CONTAINER);
    await db().query(
      `INSERT INTO public.containers (id, name, category) VALUES ($1, 'Fork Folder', NULL)`,
      [folder]
    );

    const res = await request(app)
      .post(`/api/threads/${source}/fork`)
      .send({ title: 'Into folder', projectId: folder });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    const created = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.threads WHERE title = 'Into folder'`
    );
    expect(created.rows[0]!.n).toBe(0);
  });

  it('copies the thread-scoped skills and skill_mode to the fork', async () => {
    const source = await createHomeThread();
    await seedConversation(source);
    const agentId = await agentOf(source);
    // skill_id FKs skill_registry, so seed two real registry rows to pick.
    const skillA = `skreg-fork-a-${Date.now()}`;
    const skillB = `skreg-fork-b-${Date.now()}`;
    for (const [id, slug] of [
      [skillA, 'fork-skill-a'],
      [skillB, 'fork-skill-b'],
    ]) {
      await db().query(
        `INSERT INTO public.skill_registry (id, scope, slug, source_path)
         VALUES ($1, 'personal', $2, $3)`,
        [id, slug, `/tmp/${slug}`]
      );
    }
    // Thread-scoped skill picks + a non-inherit mode on the source participant.
    await SkillAssignments.replace(agentId, source, [skillA, skillB]);
    await SkillAssignments.setMode(source, agentId, 'override');

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'Skills' });
    expect(res.status).toBe(201);
    const forkId = res.body.data.id as string;

    const copied = await SkillAssignments.listForAgent(agentId, forkId);
    expect(copied.map((r) => r.skillId).sort()).toEqual([skillA, skillB].sort());
    // The participant's skill_mode travels too.
    expect(await SkillAssignments.getMode(forkId, agentId)).toBe('override');
  });

  it("returns the fork's final row — 201 body carries the set working_directory, not null", async () => {
    // The 201 body is the final row, read after working_directory is set.
    const source = await createHomeThread();
    await seedConversation(source);
    await db().query(`UPDATE public.threads SET working_directory = $2 WHERE id = $1`, [
      source,
      '/tmp/fork-body-dir',
    ]);

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'BodyDir' });
    expect(res.status).toBe(201);
    expect(res.body.data.workingDirectory).toBe('/tmp/fork-body-dir');
  });

  it('places a flat fork at the top of the list after the late slot shift', async () => {
    // The fork opens list slot 0 last, shifting every other flat thread down.
    // The returned row must already carry that final position (sortOrder 0),
    // and a pre-existing flat thread must have been bumped to ≥ 1.
    const existing = await Threads.create({
      id: `fork-existing-flat-${Date.now()}`,
      title: 'Existing flat thread',
    });
    const source = await createHomeThread();
    await seedConversation(source);

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: 'TopSlot' });
    expect(res.status).toBe(201);
    // The 201 body reflects the final slot (0), not the pre-shift value.
    expect(res.body.data.sortOrder).toBe(0);

    const bumped = await db().query<{ sort_order: number }>(
      `SELECT sort_order FROM public.nodes WHERE id = $1`,
      [existing.id]
    );
    expect(bumped.rows[0]!.sort_order).toBeGreaterThanOrEqual(1);
  });

  it('cuts the title by code points so a multi-byte emoji is never split', async () => {
    const source = await createHomeThread();
    await seedConversation(source);
    const { THREAD_TITLE_MAX_LENGTH } = await import('@snaglet/shared/types');
    // A title that is all astral emoji, longer than the cap. A UTF-16 slice
    // would land mid-surrogate and leave a lone half; a code-point cut keeps
    // exactly THREAD_TITLE_MAX_LENGTH whole emoji.
    const emoji = '\u{1F333}'; // deciduous tree (one code point, two UTF-16 units)
    const longTitle = emoji.repeat(THREAD_TITLE_MAX_LENGTH + 5);

    const res = await request(app).post(`/api/threads/${source}/fork`).send({ title: longTitle });
    expect(res.status).toBe(201);
    const title = res.body.data.title as string;
    const codePoints = Array.from(title);
    expect(codePoints).toHaveLength(THREAD_TITLE_MAX_LENGTH);
    // Every code point is a whole emoji — no lone surrogate survived the cut.
    expect(codePoints.every((c) => c === emoji)).toBe(true);
  });

  it('defers a message that lands during a fork reservation (re-dispatched after release)', async () => {
    // During a fork the source is kept, so a wake that lands is
    // persisted and deferred — the dispatch reports queued_for_post_run and the
    // fork owner re-dispatches it once on release.
    const source = await createHomeThread();
    await seedConversation(source);
    const { activeRunTracker } = await import('@server/services/ActiveRunTracker');
    const { dispatchToThread } =
      await import('@server/services/SocketService/dispatch/dispatchToThread');
    const seedId = `fork-defer-seed-${source}`;
    await seedMessage(source, {
      id: seedId,
      role: 'user',
      content: 'a wake during the fork',
      userId,
      createdAt: '2026-11-06T11:00:00.000Z',
    });

    expect(activeRunTracker.reserveThreadPurge(source, 'fork')).toBe(true);
    try {
      const result = await dispatchToThread({
        threadId: source,
        senderId: userId,
        messageId: seedId,
        message: 'a wake during the fork',
        source: 'tool',
      });
      expect(result.reason).toBe('queued_for_post_run');
      // The fork owner would drain exactly this id on release.
      expect(activeRunTracker.takeDeferredPurgeMessages(source)).toEqual([seedId]);
    } finally {
      activeRunTracker.releaseThreadPurge(source);
    }
  });

  it('drops a message that lands during a clear reservation (not deferred)', async () => {
    // A Clear wipes the thread, so a wake landing mid-clear is not
    // deferred (no one would re-dispatch it) — reported honestly as no_dispatch.
    const source = await createHomeThread();
    await seedConversation(source);
    const { activeRunTracker } = await import('@server/services/ActiveRunTracker');
    const { dispatchToThread } =
      await import('@server/services/SocketService/dispatch/dispatchToThread');
    const seedId = `clear-drop-seed-${source}`;
    await seedMessage(source, {
      id: seedId,
      role: 'user',
      content: 'a wake during the clear',
      userId,
      createdAt: '2026-11-06T11:05:00.000Z',
    });

    // Default reason is 'clear'.
    expect(activeRunTracker.reserveThreadPurge(source)).toBe(true);
    try {
      const result = await dispatchToThread({
        threadId: source,
        senderId: userId,
        messageId: seedId,
        message: 'a wake during the clear',
        source: 'tool',
      });
      expect(result.reason).toBe('no_dispatch');
      expect(activeRunTracker.takeDeferredPurgeMessages(source)).toEqual([]);
    } finally {
      activeRunTracker.releaseThreadPurge(source);
    }
  });

  it('refuses forking into an archived project with a clear 400 (not a 500)', async () => {
    // A thread scope must be a live project. assertProjectContainer
    // (the one check every scope writer runs) rejects an archived project with
    // a 400 — "restore it or choose a live project" — so the fork does too, and
    // nothing is created. The user picks a live project or forks flat.
    const source = await createHomeThread();
    await seedConversation(source);
    const project = await Nodes.ensure(`fork-arch-proj-${source}`, NODE_KIND.CONTAINER);
    await db().query(
      `INSERT INTO public.containers (id, name, category) VALUES ($1, 'Archived Project', 'project')`,
      [project]
    );
    await db().query(`UPDATE public.nodes SET archived = true, archived_at = now() WHERE id = $1`, [
      project,
    ]);

    const res = await request(app)
      .post(`/api/threads/${source}/fork`)
      .send({ title: 'Into archived', projectId: project });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/archived/i);

    const created = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.threads WHERE title = 'Into archived'`
    );
    expect(created.rows[0]!.n).toBe(0);
  });
});
