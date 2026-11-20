/**
 * What a thread delete removes besides the thread, against the real database.
 * (A home thread is never deleted on its own; homeThreadDelete.test.ts covers
 * the agent delete that takes it.)
 *
 * Subagent helpers are made by `subagentService.start` and retired by
 * `retire` (dispatch is stubbed, so no model runs). Deleting the parent takes
 * the helper threads and the runs of live and retired helpers with it, but
 * keeps the helper agents, archived: what a helper wrote keeps its author. A
 * helper that is running refuses the delete, and nothing is removed.
 *
 * A project delete and an archive sweep of several threads remove, for every
 * thread, the same things: no id of it and no word of its text is left.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express, { Router } from 'express';
import request from 'supertest';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { sendToClient: jest.fn(), broadcastToChannel: jest.fn(), registerHandler: jest.fn() },
  addChannelObserver: jest.fn(),
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@server/services/SocketService/dispatch/dispatchToThread'
  ),
  dispatchToThread: jest.fn(async () => ({
    ok: true,
    reason: 'dispatched',
    wakeCount: 1,
    capHit: false,
  })),
}));

import { getDb } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Containers } from '@snaglet/db/tables/containers';
import { Memories } from '@snaglet/db/tables/memories';
import { Messages } from '@snaglet/db/tables/messages';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Threads } from '@snaglet/db/tables/threads';
import { Docs } from '@snaglet/db/tables/docs';
import { Users } from '@snaglet/db/tables/users';
import { Subagents, type SubagentRow } from '@snaglet/db/tables/subagents';
import containersRouter from '@server/domains/containers/containers.routes';
import { registerThreadCrudRoutes } from '@server/domains/threads/handlers/threadCrud';
import { errorHandler } from '@server/middleware';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { purgeExpiredArchivedNodes } from '@server/services/ArchivePurge';
import { archiveItem } from '@server/services/ArchiveService';
import { automationService } from '@server/services/automations/AutomationService';
import { subagentService } from '@server/services/subagents/SubagentService';
import { residue, sentinelHits, unseen } from './support/residueScan';

const ORCH = 'test-agent-a';

const threadsRouter = Router();
registerThreadCrudRoutes(threadsRouter);
const app = express()
  .use(express.json())
  .use('/api/threads', threadsRouter)
  .use('/api/containers', containersRouter)
  .use(errorHandler);

let providerId = '';
let model = '';
let userId = '';
let runSerial = 0;

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await getDb().query<T>(text, params)).rows;
}

let parentSerial = 0;

/** A workspace thread with the orchestrator in it, to start helpers from. */
async function parentThread(): Promise<string> {
  const threadId = `thread-${String(++parentSerial).padStart(13, '0')}-parentaaa`;
  await Threads.create({ id: threadId, title: 'Quarterly file' });
  await ThreadParticipants.addParticipant({ threadId, agentId: ORCH });
  return threadId;
}

async function startHelper(parentThreadId: string, name: string): Promise<SubagentRow> {
  return subagentService.start({
    orchestratorAgentId: ORCH,
    parentThreadId,
    name,
    model,
    brief: `Find the quarterly file, ${name}.`,
  });
}

/** A finished run of the helper in its thread, with one tool call. */
async function helperRun(sub: SubagentRow): Promise<string> {
  runSerial += 1;
  const runId = `run-${String(runSerial).padStart(13, '1')}-aaaaaaaaa`;
  await sql(
    `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
     VALUES ($1, $2, $3, $4, $5, 'completed', now())`,
    [runId, sub.threadId, sub.agentId, providerId, model]
  );
  await sql(
    `INSERT INTO public.agent_activity_log (agent_id, action_type, trigger_type, run_id)
     VALUES ($1, 'tool_call', 'message_received', $2)`,
    [sub.agentId, runId]
  );
  return runId;
}

interface BuiltThread {
  threadId: string;
  ids: string[];
}

/**
 * A workspace thread (in `projectId`, or flat) with what a delete must take
 * along: messages, a run with activity, a digest, a memory, a live helper,
 * an automation with a run log and a reminder, a tray notification and a
 * hook run. Its text carries `sentinel`.
 */
async function threadWithResidue(
  tag: string,
  sentinel: string,
  projectId: string | null
): Promise<BuiltThread> {
  const id = (kind: string, n: number) => `${kind}-${tag}${String(n).padStart(12, '0')}-aaaaaaaaa`;
  const threadId = id('thread', 1);
  await Threads.create({ id: threadId, title: `Planning ${tag}`, projectId });
  await ThreadParticipants.addParticipant({ threadId, agentId: ORCH });
  await Messages.create({
    id: id('message', 2),
    threadId,
    role: 'user',
    userId,
    content: `Plan the ${sentinel} launch.`,
  });
  const run = id('run', 3);
  await sql(
    `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
     VALUES ($1, $2, $3, $4, $5, 'completed', now())`,
    [run, threadId, ORCH, providerId, model]
  );
  await sql(
    `INSERT INTO public.agent_activity_log (agent_id, action_type, trigger_type, run_id, content)
     VALUES ($1, 'thinking', 'message_received', $2, $3)`,
    [ORCH, run, `Thinking about the ${sentinel} launch.`]
  );
  await ThreadSummaries.insertNewVersion({
    id: id('thread_summary', 4),
    threadId,
    agentId: ORCH,
    summaryText: `The ${sentinel} launch was planned.`,
    messagesCovered: 1,
  });
  await Memories.create({
    id: id('memory', 5),
    agentId: ORCH,
    key: `launch-${tag}`,
    content: `The ${sentinel} launch is in spring.`,
    sourceThreadId: threadId,
  });
  const helper = await startHelper(threadId, 'Scout');
  const helperRunId = await helperRun(helper);
  const automation = await automationService.create(
    {
      name: `Launch check ${tag}`,
      prompt: `Check the ${sentinel} launch.`,
      when: { every: '1h' },
      threadId,
      agentId: ORCH,
    },
    { kind: 'person' }
  );
  const [schedule] = await sql<{ id: string }>(
    `SELECT id FROM public.schedules WHERE action_json->>'automationId' = $1`,
    [automation.id]
  );
  await sql(`INSERT INTO public.reminder_deliveries (key, delivered_at) VALUES ($1, now())`, [
    `automation:${automation.id}@2026-01-01T09:00:00.000Z#start`,
  ]);
  await sql(
    `INSERT INTO public.notifications (id, type, title, body, thread_id, agent_id, run_id)
     VALUES ($1, 'run_completed', 'Test Agent A finished', $2, $3, $4, $5)`,
    [id('notif', 6), `The ${sentinel} plan is ready.`, threadId, ORCH, run]
  );
  await sql(
    `INSERT INTO public.hook_runs (id, hook_name, source, event_name, status, thread_id, stdout)
     VALUES ($1, 'test-hook', 'event', 'message:create', 'succeeded', $2, $3)`,
    [id('hookrun', 7), threadId, `Saw the ${sentinel} launch.`]
  );
  return {
    threadId,
    ids: [
      threadId,
      id('message', 2),
      run,
      id('thread_summary', 4),
      id('memory', 5),
      helper.threadId!,
      helper.id,
      helperRunId,
      automation.id,
      schedule!.id,
      id('notif', 6),
      id('hookrun', 7),
    ],
  };
}

async function memberOf(agentId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(`SELECT id FROM public.members WHERE agent_id = $1`, [
    agentId,
  ]);
  return row!.id;
}

async function count(text: string, params: unknown[]): Promise<number> {
  const [row] = await sql<{ n: number }>(text, params);
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  const [seeded] = await sql<{ provider_id: string; model_id: string }>(
    `SELECT provider_id, model_id FROM public.models
      WHERE is_active AND supports_tools AND type = 'llm'
      ORDER BY provider_id, sort_order, model_id LIMIT 1`
  );
  if (!seeded) throw new Error('the seed needs a tool-capable model');
  providerId = seeded.provider_id;
  model = seeded.model_id;
  await Agents.create({ id: ORCH, name: 'Test Agent A', providerId, modelId: model });
  const user = (await Users.getActiveUser()) ?? (await Users.getOrCreateLocalUser());
  userId = user.id;
  subagentService.init({ recoverAfterRestart: false });
});

afterAll(() => {
  subagentService.shutdown();
});

beforeEach(async () => {
  await sql(
    `DELETE FROM public.nodes WHERE id IN (SELECT id FROM public.threads WHERE kind = 'dm')`
  );
});

describe('deleting a thread with subagent helpers', () => {
  it('takes the helper threads and runs, and keeps the helper agents and what they wrote', async () => {
    const parent = await parentThread();
    const scout = await startHelper(parent, 'Scout');
    const scoutRun = await helperRun(scout);
    const clerk = await startHelper(parent, 'Clerk');
    const clerkRun = await helperRun(clerk);
    expect(await subagentService.retire(clerk, 'done')).toBe(true);
    // A retire deletes the helper thread and keeps its runs, thread-less.
    expect(await sql(`SELECT thread_id FROM public.runs WHERE id = $1`, [clerkRun])).toEqual([
      { thread_id: null },
    ]);

    // Scout wrote a doc: its member is the author, editor and assignee, and
    // a snapshot names it too.
    const scoutMember = await memberOf(scout.agentId);
    const doc = await Docs.create({ title: 'Quarterly file notes', content: 'Found it.' });
    await sql(
      `UPDATE public.docs SET created_by = $1, last_edited_by = $1, assigned_to = $1 WHERE id = $2`,
      [scoutMember, doc.id]
    );
    await sql(
      `INSERT INTO public.doc_snapshots (id, doc_id, content, content_bytes, created_by)
       VALUES ('doc_snapshot-1111111111111-aaaaaaaaa', $1, 'Found it.', 9, $2)`,
      [doc.id, scoutMember]
    );

    await request(app).delete(`/api/threads/${parent}`).expect(200);

    expect(
      await count(`SELECT count(*)::int AS n FROM public.nodes WHERE id = ANY($1::text[])`, [
        [parent, scout.threadId],
      ])
    ).toBe(0);
    expect(
      await count(`SELECT count(*)::int AS n FROM public.runs WHERE id = ANY($1::text[])`, [
        [scoutRun, clerkRun],
      ])
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM public.agent_activity_log WHERE run_id = ANY($1::text[])`,
        [[scoutRun, clerkRun]]
      )
    ).toBe(0);
    expect(
      await count(`SELECT count(*)::int AS n FROM public.subagents WHERE parent_thread_id = $1`, [
        parent,
      ])
    ).toBe(0);
    expect(
      await sql(`SELECT id, archived FROM public.agents WHERE id = ANY($1::text[]) ORDER BY id`, [
        [scout.agentId, clerk.agentId],
      ])
    ).toEqual([scout.agentId, clerk.agentId].sort().map((id) => ({ id, archived: true })));
    expect(
      await sql(`SELECT created_by, last_edited_by, assigned_to FROM public.docs WHERE id = $1`, [
        doc.id,
      ])
    ).toEqual([{ created_by: scoutMember, last_edited_by: scoutMember, assigned_to: scoutMember }]);
    expect(
      await sql(`SELECT created_by FROM public.doc_snapshots WHERE doc_id = $1`, [doc.id])
    ).toEqual([{ created_by: scoutMember }]);
    expect(
      await count(`SELECT count(*)::int AS n FROM public.members WHERE id = $1`, [scoutMember])
    ).toBe(1);
  });

  it('refuses while a helper is running, and removes nothing', async () => {
    const parent = await parentThread();
    const scout = await startHelper(parent, 'Scout');
    const scoutRun = await helperRun(scout);
    const session = 'session-1111111111111-aaaaaaaaa';
    expect(activeRunTracker.startSession(session, scout.threadId!)).toBe(true);
    try {
      const res = await request(app).delete(`/api/threads/${parent}`);

      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('subagent that is still running');
      expect(
        await count(`SELECT count(*)::int AS n FROM public.nodes WHERE id = ANY($1::text[])`, [
          [parent, scout.threadId],
        ])
      ).toBe(2);
      expect(
        await count(`SELECT count(*)::int AS n FROM public.runs WHERE id = $1`, [scoutRun])
      ).toBe(1);
      expect(await Subagents.findById(scout.id)).toMatchObject({ deletedAt: null });
      expect(await Agents.findById(scout.agentId)).toMatchObject({ archived: false });
      // Nothing is left reserved: the parent can take a new run.
      expect(activeRunTracker.isThreadPurgeReserved(parent)).toBe(false);
    } finally {
      activeRunTracker.finishSession(session);
    }

    await request(app).delete(`/api/threads/${parent}`).expect(200);
  });
  it('a project delete takes what its threads leave behind', async () => {
    const projectId = 'container-1111111111111-aaaaaaaaa';
    const sentinel = 'zqxprojectsentinelzqx';
    await Containers.create({ id: projectId, name: 'Launch', category: 'project' });
    const built = [
      await threadWithResidue('3', sentinel, projectId),
      await threadWithResidue('4', sentinel, projectId),
    ];
    const ids = built.flatMap((thread) => thread.ids);
    expect(await unseen(ids)).toEqual([]);

    await request(app).delete(`/api/containers/${projectId}`).expect(200);

    expect(await residue(ids)).toEqual([]);
    expect(await sentinelHits(sentinel)).toEqual([]);
  });

  it('an archive sweep of several threads takes what they leave behind', async () => {
    const sentinel = 'zqxsweepsentinelzqx';
    const built = [
      await threadWithResidue('5', sentinel, null),
      await threadWithResidue('6', sentinel, null),
    ];
    const ids = built.flatMap((thread) => thread.ids);
    expect(await unseen(ids)).toEqual([]);
    for (const thread of built) await archiveItem(thread.threadId);

    await purgeExpiredArchivedNodes('0 seconds');

    expect(await residue(ids)).toEqual([]);
    expect(await sentinelHits(sentinel)).toEqual([]);
  });
});
