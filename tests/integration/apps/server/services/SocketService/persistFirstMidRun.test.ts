/**
 * Persist-first mid-run messages against the real database.
 *
 * A message sent to a thread whose run is wedged in a never-returning tool
 * call must be durably written to `messages` the moment chatHandlers receives
 * it — the mid-run injection queue holds a reference, never the only copy.
 * Covers, end to end:
 *   - the row exists in the DB immediately, stamped injected_during_run, and
 *     the persisted ack (socket:chat:message_created) is broadcast;
 *   - the sender is acked socket:chat:queued (not a "sent" signal);
 *   - the queue entry carries persisted=true, so the run-end flush skips the
 *     re-create (no duplicate row, no PK collision);
 *   - after the wedged run ends, the thread accepts a new send: the fresh
 *     message persists and dispatch runs (the "next wave" that delivers).
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

// The local embedder must not spin up in jest.
jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: jest.fn(async () => undefined),
}));

// Wave-loop internals are out of scope — this suite pins the persist/queue/ack
// seam in chatHandlers. The mock also covers redispatchPersistedMessage so the
// raced-persist branch can't fire a real dispatch.
const dispatchToThreadInternal = jest.fn(async () => ({
  ok: true as const,
  wakeCount: 1,
  capHit: false,
  reason: 'completed' as const,
}));
const redispatchPersistedMessage = jest.fn(async () => undefined);
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThreadInternal: (...a: unknown[]) => dispatchToThreadInternal(...a),
  dispatchToThread: jest.fn(),
  redispatchPersistedMessage: (...a: unknown[]) => redispatchPersistedMessage(...a),
}));

import { getDb, Messages, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { processChatSend } from '@server/services/SocketService/handlers/chatHandlers';
import { persistLeftoverQueuedMessages } from '@server/services/SocketService/handlers/chatPhases/midRunMessages';
import { setSession } from '@server/services/SocketService/store';

const PREFIX = 'persist-first-it';
const THREAD_ID = `thread-${PREFIX}`;
const AGENT_ID = `agent-${PREFIX}`;
const BLOCKED_SESSION = `session-${PREFIX}-blocked`;
const SENDER_SESSION = `session-${PREFIX}-sender`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.thread_participants WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.socket_sessions WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1 OR id LIKE $2`, [
    THREAD_ID,
    `message-%`,
  ]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
}

function queuedAcks(): Array<{ sessionId: string; messageId: string }> {
  return sendToClient.mock.calls
    .map((c) => c[1] as { type: string; payload: { sessionId: string; messageId: string } })
    .filter((m) => m.type === 'socket:chat:queued')
    .map((m) => m.payload);
}

beforeAll(async () => {
  await cleanup();
  await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
  await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
  await Users.getOrCreateLocalUser();
  await ThreadParticipants.addParticipant({ threadId: THREAD_ID, agentId: AGENT_ID });
  await setSession({
    id: SENDER_SESSION,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    participantAgentIds: [AGENT_ID],
    createdAt: Date.now(),
  });
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('persist-first mid-run messages', () => {
  // Inside the describe so it runs before the shared closeDatabase() teardown; getDbClient() throws after close.
  afterAll(async () => {
    activeRunTracker.finishSession(BLOCKED_SESSION);
    activeRunTracker.finishSession(SENDER_SESSION);
    await cleanup();
  });

  it('persists an inbound message to the DB the moment it is queued behind a wedged run', async () => {
    // A run holds the thread lock and never drains (blocked in a tool call).
    expect(activeRunTracker.startSession(BLOCKED_SESSION, THREAD_ID)).toBe(true);

    await processChatSend(
      { sessionId: SENDER_SESSION, message: 'am I lost?' },
      { clientId: 'client-1' }
    );

    // The sender was acked "queued" — not an error, not a drop.
    const acks = queuedAcks();
    expect(acks).toHaveLength(1);
    const messageId = acks[0]!.messageId;

    // The row is in the DB now, before any drain ever runs.
    const row = await Messages.findById(messageId);
    expect(row).not.toBeNull();
    expect(row!.threadId).toBe(THREAD_ID);
    expect(row!.content).toBe('am I lost?');
    expect(row!.injectedDuringRun).toBe(true);

    // The persisted ack was broadcast to the thread (the UI's pending → sent
    // transition keys on this, not on socket:chat:queued).
    const created = broadcastToChannel.mock.calls
      .map((c) => c[1] as { type: string; payload: { id: string } })
      .find((m) => m.type === 'socket:chat:message_created');
    expect(created).toBeDefined();
    expect(created!.payload.id).toBe(messageId);

    // No dispatch started — the wedged run still owns the thread.
    expect(dispatchToThreadInternal).not.toHaveBeenCalled();
  });

  it('run-end flush treats the queued entry as a reference — no duplicate row', async () => {
    // The wedged run finally dies (abort/timeout/reap); its queue is handed back.
    const leftovers = activeRunTracker.finishSession(BLOCKED_SESSION);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatchObject({ content: 'am I lost?', persisted: true });

    // The flush path must skip the already-persisted row (re-creating it would
    // PK-collide), leaving exactly one copy in the thread.
    await persistLeftoverQueuedMessages(leftovers, {
      threadId: THREAD_ID,
      threadName: 'test',
    });
    const pool = getDb();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM public.messages WHERE thread_id = $1 AND content = $2`,
      [THREAD_ID, 'am I lost?']
    );
    expect(rows[0].count).toBe(1);
  });

  it('after the run ends the thread accepts new sends: persists and dispatches', async () => {
    await processChatSend(
      { sessionId: SENDER_SESSION, message: 'hello again' },
      { clientId: 'client-1' }
    );

    // Fresh run: message persisted through the normal path and dispatch ran —
    // its context rebuild includes the persist-first row from the wedged run.
    const pool = getDb();
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM public.messages WHERE thread_id = $1 AND content = $2`,
      [THREAD_ID, 'hello again']
    );
    expect(rows[0].count).toBe(1);
    expect(dispatchToThreadInternal).toHaveBeenCalledTimes(1);

    // The mocked dispatch never releases the lock — do it here so later suites
    // in this file's DB see a clean tracker.
    activeRunTracker.finishSession(SENDER_SESSION);
  });
});
