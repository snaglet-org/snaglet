/**
 * A send that fails after taking the thread's run lock but before dispatch
 * must release the lock and tell the sender; otherwise the thread reads "A run
 * is already in progress" until the reaper. The participant-roster read is the
 * injected failure point here.
 *
 * Conventions follow chatHandlers.summaryHalt.test.ts: WebSocketService and
 * the dispatch seam are mocked (plus the archived-participant partition, to
 * inject the failure), everything else is the live DB.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const sendToClient = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: (...a: unknown[]) => sendToClient(...a),
    broadcastToChannel: jest.fn(),
    registerHandler: jest.fn(),
  },
}));

const dispatchToThreadInternal = jest.fn(async () => ({
  ok: true as const,
  wakeCount: 1,
  capHit: false,
  reason: 'completed' as const,
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThreadInternal: (...a: unknown[]) => dispatchToThreadInternal(...a),
  dispatchToThread: jest.fn(),
  redispatchPersistedMessage: jest.fn(async () => undefined),
}));

const partitionArchivedParticipants = jest.fn(async (ids: string[]) => ({
  liveIds: ids,
  archivedIds: [] as string[],
}));
jest.mock('@server/services/SocketService/dispatch/partitionArchivedParticipants', () => ({
  partitionArchivedParticipants: (ids: string[]) => partitionArchivedParticipants(ids),
}));

import { getDb, getDbClient, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ensureBuiltinCatalog } from '@snaglet/db/migrations';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { processChatSend } from '@server/services/SocketService/handlers/chatHandlers';
import { setSession } from '@server/services/SocketService/store';

const PREFIX = 'lock-release-it';
const THREAD_ID = `thread-${PREFIX}`;
const AGENT_ID = `agent-${PREFIX}`;
const SESSION_ID = `session-${PREFIX}`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM thread_participants WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM agents WHERE id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM nodes WHERE id = ANY($1::text[])`, [[THREAD_ID, AGENT_ID]]);
}

async function send(message: string): Promise<void> {
  await processChatSend({ sessionId: SESSION_ID, message }, { clientId: 'client-1' });
}

interface ErrorFrame {
  type: string;
  payload: { sessionId?: string; threadId?: string; message?: string };
}

function socketErrors(): ErrorFrame['payload'][] {
  return sendToClient.mock.calls
    .map((call) => call[1] as ErrorFrame)
    .filter((frame) => frame.type === 'socket:error')
    .map((frame) => frame.payload);
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

describe('a send that fails before dispatch releases the run lock', () => {
  afterAll(async () => {
    activeRunTracker.finishSession(SESSION_ID);
    await cleanup();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    activeRunTracker.finishSession(SESSION_ID);
  });

  it('releases the lock and tells the sender when the roster read fails', async () => {
    partitionArchivedParticipants.mockRejectedValueOnce(new Error('connection terminated'));

    await send('first try');

    expect(activeRunTracker.hasActiveThread(THREAD_ID)).toBe(false);
    expect(activeRunTracker.hasActiveSession(SESSION_ID)).toBe(false);
    expect(dispatchToThreadInternal).not.toHaveBeenCalled();
    const errors = socketErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ sessionId: SESSION_ID, threadId: THREAD_ID });
    expect(errors[0]!.message).toMatch(/participants/i);
  });

  it('lets the very next send start a run instead of reporting one in progress', async () => {
    partitionArchivedParticipants.mockRejectedValueOnce(new Error('connection terminated'));
    await send('first try');
    jest.clearAllMocks();

    await send('second try');

    expect(socketErrors()).toEqual([]);
    expect(dispatchToThreadInternal).toHaveBeenCalledTimes(1);
  });

  it('tags every pre-dispatch refusal with the session and thread', async () => {
    partitionArchivedParticipants.mockResolvedValueOnce({ liveIds: [], archivedIds: [AGENT_ID] });

    await send('nobody home');

    expect(activeRunTracker.hasActiveThread(THREAD_ID)).toBe(false);
    expect(socketErrors()).toEqual([
      { sessionId: SESSION_ID, threadId: THREAD_ID, message: 'Thread has no active participants' },
    ]);
  });
});

describe('a send blocked by a purge reservation names the operation (fork vs clear)', () => {
  beforeAll(async () => {
    // The first describe's afterAll cleans up the DB fixtures, so rebuild the
    // thread, participant and session this describe's sends depend on.
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

  afterAll(async () => {
    activeRunTracker.releaseThreadPurge(THREAD_ID);
    activeRunTracker.finishSession(SESSION_ID);
    await cleanup();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    activeRunTracker.releaseThreadPurge(THREAD_ID);
    activeRunTracker.finishSession(SESSION_ID);
  });

  it('says "Forking" while a fork holds the thread', async () => {
    expect(activeRunTracker.reserveThreadPurge(THREAD_ID, 'fork')).toBe(true);

    await send('during a fork');

    expect(dispatchToThreadInternal).not.toHaveBeenCalled();
    expect(socketErrors()).toEqual([
      {
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        message: 'Forking this thread, try again in a moment.',
      },
    ]);
  });

  it('says "Clearing" while a clear holds the thread', async () => {
    // Default reason is 'clear'.
    expect(activeRunTracker.reserveThreadPurge(THREAD_ID)).toBe(true);

    await send('during a clear');

    expect(dispatchToThreadInternal).not.toHaveBeenCalled();
    expect(socketErrors()).toEqual([
      {
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        message: 'Clearing this thread, try again in a moment.',
      },
    ]);
  });
});
