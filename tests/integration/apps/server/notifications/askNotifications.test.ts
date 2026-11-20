/**
 * Every agent ask notifies, against the real database: a tool-permission
 * prompt (a normal agent's and a subagent helper's) and a Triage question
 * each raise one notification, and each way the ask settles dismisses it
 * with a `notification.dismissed` event. A run that ends on a question
 * raises one "has a question for you" mention instead of run_completed; a
 * helper's run still raises nothing. Boot clears asks a restart orphaned.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const broadcast = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => broadcast(...args) },
}));

import { Agents, Messages, Notifications, Threads, closeDatabase, getDb } from '@snaglet/db';
import { Subagents } from '@snaglet/db/tables/subagents';
import type { ClarificationRequest, NotificationRecord } from '@snaglet/shared/types';
import {
  cancelToolConfirmationsForThread,
  resolveToolConfirmation,
  waitForConfirmation,
} from '@server/services/SocketService/confirmation';
import {
  cancelClarificationsForThread,
  resolveClarification,
  waitForClarification,
} from '@server/services/SocketService/clarification';
import {
  dismissStaleAskNotifications,
  notifyToolApprovalAsk,
} from '@server/services/askNotifications';
import {
  ASK_NOTIFICATION_ID_PREFIX,
  notificationService,
} from '@server/services/NotificationService';
import { notifyRunEnd } from '@server/services/notificationHooks';

const AGENT_ID = 'test-agent-a';
const AGENT_NAME = 'Test Agent A';
const HELPER_AGENT_ID = 'subagent-11111111-1111-4111-8111-111111111111';
const HELPER_NAME = 'Test Helper A';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const HELPER_THREAD_ID = 'thread-2222222222222-bbbbbbbbb';
const SESSION_ID = 'session-test-a';

const REQUEST: ClarificationRequest = {
  questions: [
    { id: 'target', prompt: 'Which environment should the deploy target?', type: 'text' },
    { id: 'window', prompt: 'When may it run?', type: 'text' },
  ],
};

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out; last value ${JSON.stringify(value)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** All notifications (dismissed or not) raised for a thread. */
async function notificationsFor(threadId: string): Promise<NotificationRecord[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id FROM public.notifications WHERE thread_id = $1 ORDER BY created_at, id`,
    [threadId]
  );
  const records = await Promise.all(rows.map((row) => Notifications.findById(row.id)));
  return records.filter((r): r is NotificationRecord => r !== null);
}

/** The one ask notification for a thread, once it has been written. */
async function askNotification(threadId: string): Promise<NotificationRecord> {
  const [record] = await waitFor(
    () => notificationsFor(threadId),
    (list) => list.length === 1
  );
  return record;
}

async function waitDismissed(id: string): Promise<NotificationRecord | null> {
  return waitFor(
    () => Notifications.findById(id),
    (row) => row?.dismissed === true
  );
}

function workspaceEvents(type: string): Array<Record<string, unknown>> {
  return broadcast.mock.calls
    .filter((call) => call[0] === 'workspace')
    .map((call) => (call[1] as { payload: Record<string, unknown> }).payload)
    .filter((payload) => payload.type === type);
}

function dismissedIds(): unknown[] {
  return workspaceEvents('notification.dismissed').map((event) => event.id);
}

async function insertRun(id: string, threadId: string, agentId: string): Promise<void> {
  await getDb().query(
    `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
     VALUES ($1, $2, $3, 'test-provider-a', 'test-model-a', 'completed', now())`,
    [id, threadId, agentId]
  );
}

async function notificationsForRun(runId: string): Promise<NotificationRecord[]> {
  const { rows } = await getDb().query<{ id: string }>(
    `SELECT id FROM public.notifications WHERE run_id = $1`,
    [runId]
  );
  const records = await Promise.all(rows.map((row) => Notifications.findById(row.id)));
  return records.filter((r): r is NotificationRecord => r !== null);
}

beforeAll(async () => {
  await Agents.create({ id: AGENT_ID, name: AGENT_NAME, role: 'Test role' });
  await Agents.create({
    id: HELPER_AGENT_ID,
    name: HELPER_NAME,
    role: 'subagent',
    parentAgentId: AGENT_ID,
  });
  await Threads.create({ id: THREAD_ID, title: 'Release planning' });
  await Threads.create({
    id: HELPER_THREAD_ID,
    title: `${AGENT_NAME} › ${HELPER_NAME}`,
    parentThreadId: THREAD_ID,
  });
  await Subagents.create({
    parentThreadId: THREAD_ID,
    orchestratorAgentId: AGENT_ID,
    agentId: HELPER_AGENT_ID,
    threadId: HELPER_THREAD_ID,
    startedByRunId: null,
    name: HELPER_NAME,
    providerId: 'test-provider-a',
    modelId: 'test-model-a',
  });
});

beforeEach(async () => {
  broadcast.mockClear();
  await getDb().query('DELETE FROM public.notifications');
});

afterAll(async () => {
  await closeDatabase();
});

describe('tool-permission prompts', () => {
  const prompt = {
    threadId: THREAD_ID,
    sessionId: SESSION_ID,
    callId: 'call-1',
    agentId: AGENT_ID,
    toolName: 'shell',
    toolInput: { command: 'git status' },
  };

  it('raise one tool_approval notification that is dismissed once approved', async () => {
    const result = waitForConfirmation(prompt);

    const notification = await askNotification(THREAD_ID);
    expect(notification).toMatchObject({
      type: 'tool_approval',
      title: `${AGENT_NAME} needs your approval`,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      dismissed: false,
    });
    expect(notification.id.startsWith(ASK_NOTIFICATION_ID_PREFIX)).toBe(true);
    expect(notification.body).toBe('Wants to use shell. Open the thread to see the details.');
    expect(notification.body).not.toContain('git status');
    expect(workspaceEvents('notification.created')).toEqual([
      expect.objectContaining({ notification: expect.objectContaining({ id: notification.id }) }),
    ]);

    await resolveToolConfirmation(THREAD_ID, 'call-1', 'approve_once');
    await expect(result).resolves.toEqual({ approved: true, timedOut: false });
    await waitDismissed(notification.id);
    expect(dismissedIds()).toEqual([notification.id]);
  });

  it("name the orchestrator and the helper for a helper's prompt, in its hidden thread", async () => {
    const result = waitForConfirmation({
      ...prompt,
      threadId: HELPER_THREAD_ID,
      agentId: HELPER_AGENT_ID,
      mode: 'allow_list',
    });

    const notification = await askNotification(HELPER_THREAD_ID);
    expect(notification).toMatchObject({
      type: 'tool_approval',
      title: `${AGENT_NAME}'s subagent ${HELPER_NAME} needs your approval`,
      threadId: HELPER_THREAD_ID,
      agentId: HELPER_AGENT_ID,
    });

    await resolveToolConfirmation(HELPER_THREAD_ID, 'call-1', 'deny');
    await expect(result).resolves.toEqual({ approved: false, timedOut: false });
    await waitDismissed(notification.id);
    expect(dismissedIds()).toEqual([notification.id]);
  });

  it('raise one notification per call id', async () => {
    const ask = {
      threadId: THREAD_ID,
      callId: 'call-dup',
      agentId: AGENT_ID,
      toolName: 'shell',
      inputSummary: '{}',
    };
    const first = notifyToolApprovalAsk(ask);
    expect(notifyToolApprovalAsk(ask)).toBe(first);

    const id = await first.notificationId;
    expect((await notificationsFor(THREAD_ID)).map((n) => n.id)).toEqual([id]);
    await first.settle();
    expect((await Notifications.findById(id ?? ''))?.dismissed).toBe(true);
  });

  it('are dismissed even when answered before the notification was written', async () => {
    const result = waitForConfirmation(prompt);
    await resolveToolConfirmation(THREAD_ID, 'call-1', 'approve_once');
    await result;

    const notification = await askNotification(THREAD_ID);
    await waitDismissed(notification.id);
    expect(dismissedIds()).toEqual([notification.id]);
  });

  it("are dismissed when the run's abort signal fires", async () => {
    const controller = new AbortController();
    const result = waitForConfirmation({ ...prompt, abortSignal: controller.signal });
    const notification = await askNotification(THREAD_ID);

    controller.abort();
    await expect(result).resolves.toEqual({ approved: false, timedOut: false });
    await waitDismissed(notification.id);
  });

  it("are dismissed when the thread's prompts are canceled", async () => {
    const result = waitForConfirmation(prompt);
    const notification = await askNotification(THREAD_ID);

    expect(cancelToolConfirmationsForThread(THREAD_ID)).toBe(1);
    await expect(result).resolves.toEqual({ approved: false, timedOut: false });
    await waitDismissed(notification.id);
  });
});

describe('Triage questions', () => {
  it('raise one mention notification that is dismissed once answered', async () => {
    const parked = waitForClarification(THREAD_ID, 'call-c1', AGENT_ID, undefined, REQUEST);

    const notification = await askNotification(THREAD_ID);
    expect(notification).toMatchObject({
      type: 'mention',
      title: `${AGENT_NAME} needs your answer`,
      body: 'Which environment should the deploy target? (+1 more)',
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });
    expect(notification.id.startsWith(ASK_NOTIFICATION_ID_PREFIX)).toBe(true);

    resolveClarification(THREAD_ID, 'call-c1', { status: 'answered', answers: {} });
    await expect(parked).resolves.toEqual({ status: 'answered', answers: {} });
    await waitDismissed(notification.id);
    expect(dismissedIds()).toEqual([notification.id]);
  });

  it('are dismissed when they time out', async () => {
    const parked = waitForClarification(THREAD_ID, 'call-c1', AGENT_ID, undefined, REQUEST, 300);
    const notification = await askNotification(THREAD_ID);

    await expect(parked).resolves.toEqual({ status: 'timed_out', answers: {} });
    await waitDismissed(notification.id);
  });

  it("are dismissed when the turn's abort signal fires", async () => {
    const controller = new AbortController();
    const parked = waitForClarification(
      THREAD_ID,
      'call-c1',
      AGENT_ID,
      undefined,
      REQUEST,
      60_000,
      60_000,
      controller.signal
    );
    const notification = await askNotification(THREAD_ID);

    controller.abort();
    await expect(parked).resolves.toEqual({ status: 'dismissed', answers: {} });
    await waitDismissed(notification.id);
  });

  it("are dismissed when the thread's questions are canceled", async () => {
    const parked = waitForClarification(THREAD_ID, 'call-c1', AGENT_ID, undefined, REQUEST);
    const notification = await askNotification(THREAD_ID);

    expect(cancelClarificationsForThread(THREAD_ID)).toBe(1);
    await expect(parked).resolves.toEqual({ status: 'timed_out', answers: {} });
    await waitDismissed(notification.id);
  });
});

describe('run ends', () => {
  it('a run that ends on a question raises one mention instead of run_completed', async () => {
    const runId = 'run-1111111111111-aaaaaaaaa';
    await insertRun(runId, THREAD_ID, AGENT_ID);
    await Messages.create({
      threadId: THREAD_ID,
      role: 'assistant',
      agentId: AGENT_ID,
      content: 'The draft is ready.\n\nShould I publish the release notes today?',
      messageType: 'question',
      runId,
    });

    await notifyRunEnd({ runId, agentId: AGENT_ID, threadId: THREAD_ID, status: 'completed' });

    const notifications = await notificationsForRun(runId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: 'mention',
      title: `${AGENT_NAME} has a question for you`,
      body: 'The draft is ready. Should I publish the release notes today?',
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });
  });

  it('a run that ends on a plain reply still raises run_completed', async () => {
    const runId = 'run-2222222222222-bbbbbbbbb';
    await insertRun(runId, THREAD_ID, AGENT_ID);
    await Messages.create({
      threadId: THREAD_ID,
      role: 'assistant',
      agentId: AGENT_ID,
      content: 'The release notes are published.',
      messageType: 'message',
      runId,
    });

    await notifyRunEnd({ runId, agentId: AGENT_ID, threadId: THREAD_ID, status: 'completed' });

    const notifications = await notificationsForRun(runId);
    expect(notifications.map((n) => [n.type, n.title])).toEqual([
      ['run_completed', `${AGENT_NAME} completed`],
    ]);
  });

  it("an earlier run's question does not turn a later, silent run into a question", async () => {
    const askedRun = 'run-3333333333333-ccccccccc';
    const silentRun = 'run-6666666666666-fffffffff';
    await insertRun(askedRun, THREAD_ID, AGENT_ID);
    await insertRun(silentRun, THREAD_ID, AGENT_ID);
    await Messages.create({
      threadId: THREAD_ID,
      role: 'assistant',
      agentId: AGENT_ID,
      content: 'Should the notes mention the migration?',
      messageType: 'question',
      runId: askedRun,
    });

    await notifyRunEnd({
      runId: silentRun,
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      status: 'completed',
    });

    expect((await notificationsForRun(silentRun)).map((n) => n.type)).toEqual(['run_completed']);
  });

  it("a helper's run raises nothing, whether it completed or ended on a question", async () => {
    const completedRun = 'run-4444444444444-ddddddddd';
    const questionRun = 'run-5555555555555-eeeeeeeee';
    await insertRun(completedRun, HELPER_THREAD_ID, HELPER_AGENT_ID);
    await insertRun(questionRun, HELPER_THREAD_ID, HELPER_AGENT_ID);
    await notifyRunEnd({
      runId: completedRun,
      agentId: HELPER_AGENT_ID,
      threadId: HELPER_THREAD_ID,
      status: 'completed',
    });
    await Messages.create({
      threadId: HELPER_THREAD_ID,
      role: 'assistant',
      agentId: HELPER_AGENT_ID,
      content: 'Which branch should I read?',
      messageType: 'question',
      runId: questionRun,
    });
    await notifyRunEnd({
      runId: questionRun,
      agentId: HELPER_AGENT_ID,
      threadId: HELPER_THREAD_ID,
      status: 'completed',
    });

    expect(await notificationsFor(HELPER_THREAD_ID)).toEqual([]);
  });
});

describe('boot', () => {
  it('dismisses ask notifications an earlier process left, and nothing else', async () => {
    const orphan = await notificationService.createAsk({
      type: 'tool_approval',
      title: `${AGENT_NAME} needs your approval`,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });
    const failure = await notificationService.create({
      type: 'run_failed',
      title: `${AGENT_NAME} failed`,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });

    // An ask raised after this process started is live and stays.
    await dismissStaleAskNotifications(new Date(Date.now() - 60_000));
    expect((await Notifications.findById(orphan.id))?.dismissed).toBe(false);

    await dismissStaleAskNotifications(new Date(Date.now() + 60_000));
    expect((await Notifications.findById(orphan.id))?.dismissed).toBe(true);
    expect((await Notifications.findById(failure?.id ?? ''))?.dismissed).toBe(false);
  });
});
