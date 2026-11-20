/**
 * The home thread (the user's DM with one agent) against the real database:
 * DELETE /api/threads/:id, the thread tool's delete, archiving it and moving
 * it into a project are all refused and leave it whole, while
 * DELETE /api/agents/:id still deletes the agent's DMs, the home thread
 * included, and this pins what that removes.
 *
 * The fixture hangs everything that can belong to a conversation off the
 * thread (see buildHomeThread) and writes a sentinel word through its text.
 * After the delete, every column of every table that can hold text is
 * searched for the thread's ids and for the sentinel, and each hit is named
 * by table and column. What stays is pinned: another thread's tool log of a
 * DM the agent sent or read from there, the helper agents (archived), and an
 * image uploaded in the thread. The memories formed in it go with it (their
 * source FK cascades); whether they should be archived or kept instead is
 * not decided. Only socket fan-out and the dispatch wave are stubbed. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync } from 'node:fs';
import express, { Router } from 'express';
import request from 'supertest';

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: jest.fn(),
    broadcastToChannel: (...args: unknown[]) => broadcastToChannel(...args),
    registerHandler: jest.fn(),
  },
  addChannelObserver: jest.fn(),
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: jest.fn(async () => ({
    ok: true as const,
    wakeCount: 0,
    capHit: false,
    reason: 'completed' as const,
  })),
  dispatchToThreadInternal: jest.fn(),
  redispatchPersistedMessage: jest.fn(async () => undefined),
}));

import { getDb } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Containers } from '@snaglet/db/tables/containers';
import { Docs } from '@snaglet/db/tables/docs';
import { imageBlobPath } from '@snaglet/db/tables/images';
import { Memories } from '@snaglet/db/tables/memories';
import { Messages } from '@snaglet/db/tables/messages';
import { Runs } from '@snaglet/db/tables/runs';
import { Subagents } from '@snaglet/db/tables/subagents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import { WORKSPACE_EVENT_CHANNEL } from '@snaglet/shared/types/workspace-events';
import agentsRouter from '@server/domains/agents/agents.routes';
import imagesRouter from '@server/domains/images/images.routes';
import { registerDmRoutes } from '@server/domains/threads/handlers/dmHandlers';
import { registerThreadCrudRoutes } from '@server/domains/threads/handlers/threadCrud';
import { errorHandler } from '@server/middleware';
import { archiveItem } from '@server/services/ArchiveService';
import { automationService } from '@server/services/automations/AutomationService';
import threadDelete from '@server/services/ToolService/handlers/threads/threadDelete';
import { DmService } from '@server/services/dm/DmService';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { settingsService } from '@server/services/settings';
import { agentSettings } from '@server/services/settings/categories/agent';
import { residue, sentinelHits, unseen } from './support/residueScan';

const AGENT = 'test-agent-a';
const OTHER_AGENT = 'test-agent-b';
const HOME_THREAD_REFUSAL = "The home thread can't be deleted. Use Clear to remove its messages.";
const PROVIDER = 'test-provider-a';
const EMBEDDING_MODEL = 'model-1111111111111-aaaaaaaaa';
const SKILL = 'skill-1111111111111-aaaaaaaaa';
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const threadsRouter = Router();
// Same order as threads.routes.ts: the DM routes before the `/:id` routes.
registerDmRoutes(threadsRouter);
registerThreadCrudRoutes(threadsRouter);
const app = express()
  .use(express.json())
  .use('/api/threads', threadsRouter)
  .use('/api/images', imagesRouter)
  .use('/api/agents', agentsRouter)
  .use(errorHandler);

let userId: string;
let userMemberId: string;

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await getDb().query<T>(text, params)).rows;
}

function vector(): string {
  const values = new Array<number>(768).fill(0);
  values[7] = 1;
  return `[${values.join(',')}]`;
}

async function embed(nodeId: string): Promise<void> {
  await sql(
    `INSERT INTO public.embeddings (id, node_id, model_id, vector, content_hash)
     VALUES ($1, $2, $3, $4::vector, 'test-hash')`,
    [`embedding-${nodeId}`, nodeId, EMBEDDING_MODEL, vector()]
  );
}

interface HomeThread {
  threadId: string;
  /** Every id that belonged to the conversation; none may survive its delete. */
  ids: string[];
  /** A word written all through the conversation (messages, summaries, memories, logs). */
  sentinel: string;
  /** The DM the agent sent from another thread (logged in that thread's tool log). */
  sentMessageId: string;
  notificationIds: string[];
  /** The live and the retired helper agent: kept, archived, after the delete. */
  helperAgentIds: string[];
  imageId: string;
  imageFile: string;
}

/**
 * A home thread with messages from both sides, runs with tool activity, a
 * digest and a fold, memories (the agent's and the user's) with embeddings,
 * an uploaded image, a doc elsewhere linking to it, per-thread settings, an
 * automation with a run log, a live and a retired subagent helper, tray
 * notifications, a hook run log row, a socket session and a queued message.
 */
async function buildHomeThread(tag: string): Promise<HomeThread> {
  let serial = 0;
  /** A fixture id, unique within this thread: `<kind>-<tag><serial>-aaaaaaaaa`. */
  const id = (kind: string) => `${kind}-${tag}${String(++serial).padStart(12, '0')}-aaaaaaaaa`;
  const sentinel = `zqx${tag}sentinelzqx`;
  const opened = await request(app).post('/api/threads/dm').send({ agentId: AGENT }).expect(200);
  const threadId: string = opened.body.data.thread.id;
  const ids: string[] = [threadId];

  // Messages from both sides; the agent's DM also raises a tray notification.
  const sent = await DmService.send({
    from: { kind: 'agent', agentId: AGENT },
    to: { kind: 'user', userId },
    content: `The ${sentinel} numbers are in.`,
  });
  ids.push(sent.messageId);
  const userMessage = id('message');
  await Messages.create({
    id: userMessage,
    threadId,
    role: 'user',
    userId,
    content: `Thanks, send me the ${sentinel} summary.`,
  });
  ids.push(userMessage);

  // A run with tool activity, and the reply it wrote.
  const run = id('run');
  await Runs.create({ id: run, threadId, agentId: AGENT, providerId: PROVIDER, model: 'test' });
  await Runs.markCompleted(run);
  const reply = id('message');
  await Messages.create({
    id: reply,
    threadId,
    role: 'assistant',
    agentId: AGENT,
    runId: run,
    content: `Here is the ${sentinel} summary.`,
  });
  const activity = id('activity');
  await sql(
    `INSERT INTO public.agent_activity_log
       (id, agent_id, action_type, trigger_type, run_id, tool, tool_input, content)
     VALUES ($1, $2, 'tool_call', 'message_received', $3, 'search', $4::jsonb, $5)`,
    [
      activity,
      AGENT,
      run,
      JSON.stringify({ thread_id: threadId, query: sentinel }),
      `Searched for ${sentinel}`,
    ]
  );
  ids.push(run, reply, activity);

  // An image uploaded in the thread, shown in a message.
  const uploaded = await request(app)
    .post('/api/images')
    .send({ name: 'chart.png', dataUrl: PNG_DATA_URL, threadId })
    .expect(201);
  const imageId: string = uploaded.body.data.id;
  const imageMessage = id('message');
  await Messages.create({
    id: imageMessage,
    threadId,
    role: 'user',
    userId,
    content: `<image id="${imageId}"/> What does this ${sentinel} chart say?`,
  });
  ids.push(imageMessage);
  const [image] = await sql<{ url: string }>(`SELECT url FROM public.images WHERE id = $1`, [
    imageId,
  ]);
  const imageFile = imageBlobPath(image!.url);

  // An ordinary digest and a fold, both embedded.
  const digest = id('thread_summary');
  await ThreadSummaries.insertNewVersion({
    id: digest,
    threadId,
    agentId: AGENT,
    summaryText: `The user asked for the ${sentinel} summary.`,
    messagesCovered: 2,
    lastMessageId: reply,
  });
  const fold = id('thread_summary');
  await ThreadSummaries.insertNewVersion({
    id: fold,
    threadId,
    agentId: AGENT,
    summaryText: `Folded: ${sentinel} summary.`,
    messagesCovered: 3,
    lastMessageId: reply,
    compaction: { throughMessageId: reply },
  });
  await embed(digest);
  ids.push(digest, fold);

  // Memories formed here: the agent's and the user's own, embedded and linked.
  const agentMemory = id('memory');
  await Memories.create({
    id: agentMemory,
    agentId: AGENT,
    key: 'quarterly-numbers',
    content: `The user reads the ${sentinel} numbers first.`,
    sourceThreadId: threadId,
  });
  const userMemory = id('memory');
  await Memories.create({
    id: userMemory,
    memberId: userMemberId,
    key: 'summary-style',
    content: `Summaries of ${sentinel} go out as bullet points.`,
    sourceThreadId: threadId,
  });
  await embed(agentMemory);
  await embed(userMemory);
  await sql(
    `INSERT INTO public.links (id, source_id, target_id, relation)
     VALUES ($1, $2, $3, 'summarizes')`,
    [id('link'), agentMemory, threadId]
  );
  ids.push(agentMemory, userMemory);

  // A doc elsewhere that links to the thread and to one of its messages.
  await Docs.create({
    title: `Notes ${tag}`,
    content: `See [the thread](${threadId}) and [the reply](${reply}).`,
  });

  // Per-thread settings: participant overrides and unread cursor, a thread
  // skill pick, run notifications and a summary model.
  await sql(
    `UPDATE public.thread_participants
        SET system_prompt_addendum = 'Answer in bullet points.', model_id = 'test-model',
            last_read_at = now()
      WHERE thread_id = $1`,
    [threadId]
  );
  await sql(
    `INSERT INTO public.agent_skill_assignments (agent_id, skill_id, thread_id) VALUES ($1, $2, $3)`,
    [AGENT, SKILL, threadId]
  );
  await sql(
    `INSERT INTO public.thread_notification_settings (thread_id, enabled) VALUES ($1, true)`,
    [threadId]
  );
  const overrides = await settingsService.read(agentSettings.threadSummaryModelOverrides);
  await settingsService.write(agentSettings.threadSummaryModelOverrides, {
    ...overrides,
    [threadId]: { [AGENT]: { providerId: PROVIDER, modelId: 'test-model' } },
  });

  // An automation that wakes the agent here, with its schedule and a run log.
  const automation = await automationService.create(
    {
      name: `Check-in ${tag}`,
      prompt: `Check the ${sentinel} numbers.`,
      when: { every: '1h' },
      threadId,
      agentId: AGENT,
    },
    { kind: 'person' }
  );
  const [schedule] = await sql<{ id: string }>(
    `SELECT id FROM public.schedules WHERE action_json->>'automationId' = $1`,
    [automation.id]
  );
  const scheduleRun = id('schedule_run');
  await sql(
    `INSERT INTO public.schedule_runs (id, schedule_id, scheduled_for, status, output)
     VALUES ($1, $2, now(), 'succeeded', $3)`,
    [scheduleRun, schedule!.id, `Checked the ${sentinel} numbers.`]
  );
  // A reminder the automation fired, in the delivery ledger.
  await sql(`INSERT INTO public.reminder_deliveries (key, delivered_at) VALUES ($1, now())`, [
    `automation:${automation.id}@2026-01-01T09:00:00.000Z#start`,
  ]);
  ids.push(automation.id, schedule!.id, scheduleRun);

  // A live helper started from the thread: its own thread, run, activity,
  // summary and memory.
  const helperAgent = `subagent-${tag}${'1'.repeat(7)}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
  await Agents.create({ id: helperAgent, name: 'Scout', role: 'subagent', parentAgentId: AGENT });
  const helperThread = id('thread');
  await Threads.create({
    id: helperThread,
    title: 'Test Agent A › Scout',
    parentThreadId: threadId,
  });
  await ThreadParticipants.addParticipant({ threadId: helperThread, agentId: helperAgent });
  const subagent = await Subagents.create({
    parentThreadId: threadId,
    orchestratorAgentId: AGENT,
    agentId: helperAgent,
    threadId: helperThread,
    startedByRunId: run,
    name: 'Scout',
    providerId: PROVIDER,
    modelId: 'test-model',
  });
  const helperRun = id('run');
  await Runs.create({
    id: helperRun,
    threadId: helperThread,
    agentId: helperAgent,
    providerId: PROVIDER,
    model: 'test-model',
  });
  await Runs.markCompleted(helperRun);
  const helperMessage = id('message');
  await Messages.create({
    id: helperMessage,
    threadId: helperThread,
    role: 'assistant',
    agentId: helperAgent,
    runId: helperRun,
    content: `Found the ${sentinel} file.`,
  });
  const helperActivity = id('activity');
  await sql(
    `INSERT INTO public.agent_activity_log (id, agent_id, action_type, trigger_type, run_id)
     VALUES ($1, $2, 'tool_call', 'message_received', $3)`,
    [helperActivity, helperAgent, helperRun]
  );
  const helperSummary = id('thread_summary');
  await ThreadSummaries.insertNewVersion({
    id: helperSummary,
    threadId: helperThread,
    agentId: helperAgent,
    summaryText: `Scout looked for the ${sentinel} file.`,
    messagesCovered: 1,
  });
  const helperMemory = id('memory');
  await Memories.create({
    id: helperMemory,
    agentId: helperAgent,
    key: 'quarterly-file',
    content: `The ${sentinel} file is in the shared folder.`,
    sourceThreadId: helperThread,
  });
  ids.push(
    helperThread,
    subagent.id,
    helperRun,
    helperMessage,
    helperActivity,
    helperSummary,
    helperMemory
  );

  // A retired helper: its thread is gone, its run stayed as usage.
  const retiredAgent = `subagent-${tag}${'2'.repeat(7)}-aaaa-aaaa-aaaa-aaaaaaaaaaaa`;
  await Agents.create({ id: retiredAgent, name: 'Clerk', role: 'subagent', parentAgentId: AGENT });
  await Agents.archive(retiredAgent);
  const retired = await Subagents.create({
    parentThreadId: threadId,
    orchestratorAgentId: AGENT,
    agentId: retiredAgent,
    threadId: null,
    startedByRunId: run,
    name: 'Clerk',
    providerId: PROVIDER,
    modelId: 'test-model',
  });
  await Subagents.markDeleted(retired.id);
  const retiredRun = id('run');
  await sql(
    `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
     VALUES ($1, NULL, $2, $3, 'test-model', 'completed', now())`,
    [retiredRun, retiredAgent, PROVIDER]
  );
  ids.push(retired.id, retiredRun);

  // A tray notification about the run, a helper's ask, a hook run log row and
  // a live socket session.
  const runNotification = id('notif');
  await sql(
    `INSERT INTO public.notifications (id, type, title, body, thread_id, agent_id, run_id)
     VALUES ($1, 'run_completed', 'Test Agent A finished', $5, $2, $3, $4)`,
    [runNotification, threadId, AGENT, run, `Here is the ${sentinel} summary.`]
  );
  const askNotification = `notif-ask-${tag}${'1'.repeat(7)}`;
  await sql(
    `INSERT INTO public.notifications (id, type, title, thread_id, agent_id)
     VALUES ($1, 'tool_approval', $4, $2, $3)`,
    [askNotification, helperThread, helperAgent, `Scout needs approval to read ${sentinel}`]
  );
  const hookRun = id('hookrun');
  await sql(
    `INSERT INTO public.hook_runs (id, hook_name, source, event_name, status, agent_id, thread_id, stdout)
     VALUES ($1, 'test-hook', 'event', 'message:create', 'succeeded', $2, $3, $4)`,
    [hookRun, AGENT, threadId, `Thanks, send me the ${sentinel} summary.`]
  );
  const session = id('session');
  await sql(`INSERT INTO public.socket_sessions (id, agent_id, thread_id) VALUES ($1, $2, $3)`, [
    session,
    AGENT,
    threadId,
  ]);
  ids.push(runNotification, askNotification, hookRun, session);
  const [dmNotification] = await sql<{ id: string }>(
    `SELECT id FROM public.notifications WHERE thread_id = $1 AND type = 'thread_activity'`,
    [threadId]
  );
  expect(dmNotification).toBeDefined();
  ids.push(dmNotification!.id);

  // A message the agent has not read yet, queued in memory.
  pendingAgentMessages.enqueue({
    threadId,
    targetAgentId: AGENT,
    senderUserId: userId,
    senderName: 'Test User',
    content: `One more ${sentinel} thing.`,
    reason: 'thread-message',
  });

  // The agent working in another thread: from there it sent the user a DM
  // (thread op dm_send) and read the home thread (op dm_read). That run's
  // tool log holds the text; it is the other thread's history.
  const otherThread = id('thread');
  await Threads.create({ id: otherThread, title: `Planning ${tag}` });
  const otherRun = id('run');
  await Runs.create({
    id: otherRun,
    threadId: otherThread,
    agentId: AGENT,
    providerId: PROVIDER,
    model: 'test',
  });
  await sql(
    `INSERT INTO public.agent_activity_log
       (agent_id, action_type, trigger_type, run_id, tool, tool_input, tool_output)
     VALUES ($1, 'tool_call', 'message_received', $2, 'thread', $3::jsonb, $4::jsonb),
            ($1, 'tool_call', 'message_received', $2, 'thread', $5::jsonb, $6::jsonb)`,
    [
      AGENT,
      otherRun,
      JSON.stringify({ op: 'dm_send', to: 'user', content: `The ${sentinel} numbers are in.` }),
      JSON.stringify({ success: true, message_id: sent.messageId, thread_id: threadId }),
      JSON.stringify({ op: 'dm_read', id: threadId }),
      JSON.stringify({
        messages: [
          { text: `[DM from Test User (the user)]: Thanks, send me the ${sentinel} summary.` },
        ],
      }),
    ]
  );

  const notificationIds = [runNotification, askNotification, dmNotification!.id];
  return {
    threadId,
    ids,
    sentinel,
    sentMessageId: sent.messageId,
    notificationIds,
    helperAgentIds: [helperAgent, retiredAgent],
    imageId,
    imageFile,
  };
}

/**
 * What stays of the home thread after its delete: the other thread's tool log
 * of the dm_send and dm_read, which is that thread's history.
 */
function keptInOtherThread(home: HomeThread): string[] {
  return [
    `public.agent_activity_log.tool_input: ${home.threadId}`,
    `public.agent_activity_log.tool_output: ${[home.sentMessageId, home.threadId].sort().join(', ')}`,
  ];
}

/** Where the sentinel stays after the delete: the same tool log, one row each. */
const SENTINEL_KEPT = [
  'public.agent_activity_log.tool_input: 1 row(s)',
  'public.agent_activity_log.tool_output: 1 row(s)',
];

/** Where the conversation's text is before the delete, for a scan that can see it. */
const SENTINEL_WRITTEN = [
  'public.agent_activity_log.content',
  'public.automations.prompt',
  'public.hook_runs.stdout',
  'public.memories.content',
  'public.memories.search_text',
  'public.messages.content',
  'public.messages.search_text',
  'public.notifications.body',
  'public.notifications.title',
  'public.schedule_runs.output',
  'public.thread_summaries.summary_text',
];

const columnsOf = (hits: string[]) => hits.map((hit) => hit.slice(0, hit.indexOf(':')));

/** Workspace events broadcast so far with this type, as their payloads. */
function workspaceEvents(type: string): Array<Record<string, unknown>> {
  return broadcastToChannel.mock.calls
    .filter(([channel]) => channel === WORKSPACE_EVENT_CHANNEL)
    .map(([, frame]) => (frame as { payload?: Record<string, unknown> }).payload ?? {})
    .filter((payload) => payload.type === type);
}

const previousImagesDir = process.env.SNAGLET_IMAGES_DIR;

beforeAll(async () => {
  delete process.env.SNAGLET_IMAGES_DIR;
  await sql(
    `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Test Provider A', 'runtime')`,
    [PROVIDER]
  );
  await sql(
    `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
     VALUES ($1, $2, 'test-embedding-model-a', 'Test Embedding Model A', 'embedding', 768)`,
    [EMBEDDING_MODEL, PROVIDER]
  );
  await sql(
    `INSERT INTO public.skill_registry (id, scope, slug, name, source_path)
     VALUES ($1, 'personal', 'test-skill', 'Test skill', 'skills/test-skill/SKILL.md')`,
    [SKILL]
  );
  const user = (await Users.getActiveUser()) ?? (await Users.getOrCreateLocalUser());
  userId = user.id;
  const [member] = await sql<{ id: string }>(`SELECT id FROM public.members WHERE user_id = $1`, [
    userId,
  ]);
  userMemberId = member!.id;
});

beforeEach(async () => {
  // A test that failed partway must not hand its home thread to the next one.
  await sql(
    `DELETE FROM public.nodes WHERE id IN (SELECT id FROM public.threads WHERE kind = 'dm')`
  );
  if (!(await Agents.findById(AGENT))) await Agents.create({ id: AGENT, name: 'Test Agent A' });
  if (!(await Agents.findById(OTHER_AGENT))) {
    await Agents.create({ id: OTHER_AGENT, name: 'Test Agent B' });
  }
  broadcastToChannel.mockClear();
});

afterAll(() => {
  if (previousImagesDir === undefined) delete process.env.SNAGLET_IMAGES_DIR;
  else process.env.SNAGLET_IMAGES_DIR = previousImagesDir;
});

describe('the home thread cannot be deleted', () => {
  it('DELETE /api/threads/:id refuses it with the Clear hint and leaves all of it', async () => {
    const home = await buildHomeThread('1');

    const refused = await request(app).delete(`/api/threads/${home.threadId}`).expect(403);

    expect(refused.body.error).toMatchObject({ code: 'FORBIDDEN', message: HOME_THREAD_REFUSAL });
    expect(await unseen(home.ids)).toEqual([]);
    expect(columnsOf(await sentinelHits(home.sentinel))).toEqual(
      expect.arrayContaining(SENTINEL_WRITTEN)
    );
    expect(workspaceEvents('thread.deleted')).toEqual([]);
  });

  it("refuses the thread tool's delete with the same message", async () => {
    const opened = await request(app).post('/api/threads/dm').send({ agentId: AGENT }).expect(200);
    const threadId: string = opened.body.data.thread.id;

    await expect(threadDelete({ thread_id: threadId, confirm: true })).rejects.toThrow(
      HOME_THREAD_REFUSAL
    );
    expect(await Threads.findById(threadId)).toBeTruthy();
  });

  it('refuses archiving it, so it never expires into a delete', async () => {
    const opened = await request(app).post('/api/threads/dm').send({ agentId: AGENT }).expect(200);
    const threadId: string = opened.body.data.thread.id;

    await expect(archiveItem(threadId)).rejects.toMatchObject({
      statusCode: 403,
      message: "The home thread can't be archived. Use Clear to remove its messages.",
    });
    expect(await sql(`SELECT archived FROM public.nodes WHERE id = $1`, [threadId])).toEqual([
      { archived: false },
    ]);
  });

  it('refuses moving it into a project, whose delete would take it along', async () => {
    const opened = await request(app).post('/api/threads/dm').send({ agentId: AGENT }).expect(200);
    const threadId: string = opened.body.data.thread.id;
    const project = await Containers.create({ name: 'Test project', category: 'project' });

    await expect(Threads.moveTo(threadId, { projectId: project.id })).rejects.toThrow(
      "The home thread can't be moved into a project."
    );
    expect((await Threads.findById(threadId))?.projectId ?? null).toBeNull();
  });
});

describe('deleting the agent of a home thread', () => {
  it("DELETE /api/agents/:id leaves only the other thread's tool log of its home thread", async () => {
    const home = await buildHomeThread('2');

    await request(app).delete(`/api/agents/${AGENT}`).expect(200);

    expect(await residue(home.ids)).toEqual(keptInOtherThread(home));
    expect(await sentinelHits(home.sentinel)).toEqual(SENTINEL_KEPT);
    expect(pendingAgentMessages.hasUnread(home.threadId, AGENT)).toBe(false);
  });

  it('keeps an image uploaded in the thread: it is a Workspace item of its own', async () => {
    const home = await buildHomeThread('3');
    expect(existsSync(home.imageFile)).toBe(true);

    await request(app).delete(`/api/agents/${AGENT}`).expect(200);

    // The image lands at the Workspace root when uploaded (a home thread has
    // no project) and stays there, with its file, after the delete.
    expect(await sql(`SELECT id FROM public.images WHERE id = $1`, [home.imageId])).toHaveLength(1);
    expect(existsSync(home.imageFile)).toBe(true);
  });
});

describe('deleting an agent-to-agent DM', () => {
  it('keeps a hook run that is still going and refreshes the hook history views', async () => {
    const { threadId } = await DmService.send({
      from: { kind: 'agent', agentId: AGENT },
      to: { kind: 'agent', agentId: OTHER_AGENT },
      content: 'hello from test-agent-a',
    });
    await sql(
      `INSERT INTO public.hook_runs (id, hook_name, source, event_name, status, thread_id, stdout)
       VALUES ('hookrun-1111111111111-aaaaaaaaa', 'test-hook', 'event', 'message:create',
               'succeeded', $1, 'Done.'),
              ('hookrun-1111111111111-bbbbbbbbb', 'test-hook', 'event', 'message:create',
               'running', $1, NULL)`,
      [threadId]
    );

    await request(app).delete(`/api/threads/${threadId}`).expect(200);

    // The runner writes a running hook's result into its row when it ends.
    expect(await sql(`SELECT id FROM public.hook_runs WHERE thread_id = $1`, [threadId])).toEqual([
      { id: 'hookrun-1111111111111-bbbbbbbbb' },
    ]);
    expect(workspaceEvents('hook.runs_changed')).toEqual([
      expect.objectContaining({ hookNames: ['test-hook'], reason: 'thread-delete' }),
    ]);
  });
});
