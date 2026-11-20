/**
 * A summary-halted thread refuses new user messages on the real send path
 * (`socket:chat:send` -> `processChatSend`), and lifts the block the moment a
 * working summary model is set: the composer bounces, nothing new is
 * persisted, and no dispatch starts. WebSocketService and the dispatch seam
 * are mocked; thread and message rows, the settings service and
 * `UtilityModelResolver`'s unblock check are real.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const sendToClient = jest.fn();
const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: (...a: unknown[]) => sendToClient(...a),
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    registerHandler: jest.fn(),
  },
}));

const dispatchToThreadInternal = jest.fn(async () => ({
  ok: true as const,
  wakeCount: 1,
  capHit: false,
  reason: 'completed' as const,
}));
const dispatchToThread = jest.fn(async (_input: Record<string, unknown>) => ({
  ok: true as const,
  wakeCount: 1,
  capHit: false,
  reason: 'completed' as const,
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThreadInternal: (...a: unknown[]) => dispatchToThreadInternal(...a),
  dispatchToThread: (input: Record<string, unknown>) => dispatchToThread(input),
  redispatchPersistedMessage: jest.fn(async () => undefined),
}));

import { getDb, getDbClient, Messages, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ensureBuiltinCatalog } from '@snaglet/db/migrations';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { settingsService } from '@server/services/settings';
import { agentSettings } from '@server/services/settings/categories/agent';
import { processChatSend } from '@server/services/SocketService/handlers/chatHandlers';
import { setSession } from '@server/services/SocketService/store';
import {
  holdWakeForSummaryHalt,
  listHeldWakes,
  resetHeldWakesForTests,
} from '@server/services/SocketService/dispatch/summaryHaltedWakes';
import {
  isThreadSummaryHalted,
  raiseSummaryHalt,
  resetSummaryHaltsForTests,
} from '@server/services/summary/summaryHalt';

const PREFIX = 'summary-halt-it';
const THREAD_ID = `thread-${PREFIX}`;
const AGENT_ID = `agent-${PREFIX}`;
const SESSION_ID = `session-${PREFIX}`;

/** The failure this rule guards against: a retired model id. */
const RETIRED_MODEL = 'claude-3-haiku-20240307';

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM thread_participants WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM agents WHERE id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM notifications WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM nodes WHERE id = ANY($1::text[])`, [[THREAD_ID, AGENT_ID]]);
}

async function send(message: string): Promise<void> {
  await processChatSend({ sessionId: SESSION_ID, message }, { clientId: 'client-1' });
}

async function userMessageCount(): Promise<number> {
  const rows = await Messages.listByThreadId(THREAD_ID);
  return rows.filter((m) => m.role === 'user' && m.messageType === 'message').length;
}

/** The error text pushed back to the sending client, if any. */
function lastSocketError(): string | null {
  for (let i = sendToClient.mock.calls.length - 1; i >= 0; i--) {
    const frame = sendToClient.mock.calls[i]![1] as {
      type: string;
      payload?: { message?: string };
    };
    if (frame.type === 'socket:error') return frame.payload?.message ?? '';
  }
  return null;
}

async function haltWithFailingModel(): Promise<void> {
  await raiseSummaryHalt({
    threadId: THREAD_ID,
    agentId: AGENT_ID,
    agentName: `${PREFIX}-agent`,
    kind: 'model-failing',
    reason: 'generation-failed',
    detail: `status=404, type=not_found_error, model=${RETIRED_MODEL}`,
    providerId: 'anthropic',
    modelId: RETIRED_MODEL,
  });
}

beforeAll(async () => {
  await cleanup();
  await ensureBuiltinCatalog(await getDbClient());
  await Users.getOrCreateLocalUser();
  await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
  await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
  await ThreadParticipants.addParticipant({ threadId: THREAD_ID, agentId: AGENT_ID });
  await setSession({
    id: SESSION_ID,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    participantAgentIds: [AGENT_ID],
    createdAt: Date.now(),
  });
});

describe('a summary-halted thread refuses new user messages', () => {
  // Nested so this DB-querying afterAll unwinds before the shared
  // closeDatabase() registered by pgPerFileTeardown.
  afterAll(async () => {
    activeRunTracker.finishSession(SESSION_ID);
    await settingsService.write(agentSettings.summaryModelOverrides, {});
    resetSummaryHaltsForTests();
    resetHeldWakesForTests();
    await cleanup();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    activeRunTracker.finishSession(SESSION_ID);
    resetSummaryHaltsForTests();
    resetHeldWakesForTests();
    await settingsService.write(agentSettings.summaryModelOverrides, {});
    // Clear the narration + notifications each case raises, so per-test counts
    // measure this test's halt rather than the file's running total. User
    // messages stay: several cases assert nothing new was persisted.
    const pool = getDb();
    await pool.query(`DELETE FROM messages WHERE thread_id = $1 AND message_type = $2`, [
      THREAD_ID,
      'thread_event',
    ]);
    await pool.query(`DELETE FROM notifications WHERE thread_id = $1`, [THREAD_ID]);
  });

  it('accepts a send while the compaction path is healthy', async () => {
    const before = await userMessageCount();
    await send('a perfectly ordinary message');

    expect(lastSocketError()).toBeNull();
    expect(dispatchToThreadInternal).toHaveBeenCalledTimes(1);
    expect(await userMessageCount()).toBe(before + 1);
  });

  it('bounces the send, persists nothing, and dispatches nobody once halted', async () => {
    await haltWithFailingModel();
    const before = await userMessageCount();
    jest.clearAllMocks();

    await send('this one must not go through');

    const error = lastSocketError();
    expect(error).not.toBeNull();
    // The refusal names the model and refuses to substitute one — the fix is
    // readable without opening a log.
    expect(error).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(error).toContain('no fallback model will be chosen for you');
    expect(dispatchToThreadInternal).not.toHaveBeenCalled();
    expect(await userMessageCount()).toBe(before);
  });

  it('persists the explanation as a replayable thread_event, not prompt text', async () => {
    await haltWithFailingModel();

    const rows = await Messages.listByThreadId(THREAD_ID);
    const events = rows.filter((m) => m.messageType === 'thread_event');
    expect(events).toHaveLength(1);
    // Author-less: no user, no agent — machine narration, exactly like every
    // other thread event, so replay renders it as a plain line.
    expect(events[0]).toMatchObject({ role: 'user', userId: null, agentId: null });
    expect(events[0]!.content).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(events[0]!.content).toContain('status=404');
  });

  it('raises a notification the user can click through to the thread', async () => {
    await haltWithFailingModel();

    const pool = getDb();
    const { rows } = await pool.query<{ type: string; title: string; body: string }>(
      `SELECT type, title, body FROM notifications WHERE thread_id = $1`,
      [THREAD_ID]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain(RETIRED_MODEL);
    expect(rows[0]!.body).toContain('blocked');
  });

  it('unblocks on the next send once a working summary model is set', async () => {
    await haltWithFailingModel();
    // The repair a user would actually make: point this agent's summaries at a
    // model that is not the dead one. ollama is keyless + local, so the real
    // resolver validates it without a credential or a catalog row.
    await settingsService.write(agentSettings.summaryModelOverrides, {
      [AGENT_ID]: { providerId: 'ollama', modelId: 'qwen2.5:3b' },
    });
    const before = await userMessageCount();
    jest.clearAllMocks();

    await send('back in business');

    expect(lastSocketError()).toBeNull();
    expect(isThreadSummaryHalted(THREAD_ID)).toBe(false);
    expect(dispatchToThreadInternal).toHaveBeenCalledTimes(1);
    expect(await userMessageCount()).toBe(before + 1);
  });

  it('replays the wakes the halt refused once a send lifts it', async () => {
    await haltWithFailingModel();
    const heldWake = {
      threadId: THREAD_ID,
      senderId: AGENT_ID,
      messageId: 'message-1111111111111-aaaaaaaaa',
      message: 'scheduled check-in',
      source: 'tool' as const,
      targetAgentId: AGENT_ID,
    };
    holdWakeForSummaryHalt(heldWake);
    await settingsService.write(agentSettings.summaryModelOverrides, {
      [AGENT_ID]: { providerId: 'ollama', modelId: 'qwen2.5:3b' },
    });
    jest.clearAllMocks();

    await send('fixed the summary model');
    for (let i = 0; i < 10 && dispatchToThread.mock.calls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(lastSocketError()).toBeNull();
    expect(dispatchToThread).toHaveBeenCalledWith(heldWake);
    expect(listHeldWakes(THREAD_ID)).toEqual([]);
  });

  it('keeps held wakes while the send is still refused', async () => {
    await haltWithFailingModel();
    holdWakeForSummaryHalt({
      threadId: THREAD_ID,
      senderId: AGENT_ID,
      messageId: 'message-2222222222222-bbbbbbbbb',
      message: 'scheduled check-in',
      source: 'tool',
    });
    jest.clearAllMocks();

    await send('still broken');

    expect(lastSocketError()).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(dispatchToThread).not.toHaveBeenCalled();
    expect(listHeldWakes(THREAD_ID)).toHaveLength(1);
  });

  it('stays blocked when the setting still points at the model that failed', async () => {
    await haltWithFailingModel();
    // Re-pointing at the same dead model is not a repair, even though it
    // resolves: nothing about the 404 has changed.
    await settingsService.write(agentSettings.summaryModelOverrides, {
      [AGENT_ID]: { providerId: 'anthropic', modelId: RETIRED_MODEL },
    });
    jest.clearAllMocks();

    await send('nice try');

    expect(lastSocketError()).toContain(`anthropic/${RETIRED_MODEL}`);
    expect(isThreadSummaryHalted(THREAD_ID)).toBe(true);
    expect(dispatchToThreadInternal).not.toHaveBeenCalled();
  });
});
