/**
 * Trust boundary for `metadata.chain`: only the server stamps a
 * message's chain context. Snaglet does not refuse on depth, but the recorded
 * depth and chain must stay trustworthy for visibility, so a client that sends
 * a forged `metadata.chain` (to misreport the depth) through the socket send
 * or the REST message edit must not get it onto the row.
 *
 * Real DB and real handlers; only socket fan-out, embeddings and the dispatch
 * wave are stubbed (same seams as persistFirstMidRun.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const sendToClient = jest.fn();
const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: (...a: unknown[]) => sendToClient(...a),
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    registerHandler: jest.fn(),
  },
}));
jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: jest.fn(async () => undefined),
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

import { getDb, Messages, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { errorHandler } from '@server/middleware';
import { registerMessageRoutes } from '@server/domains/threads/handlers/messageHandlers';
import {
  processChatSend,
  type ChatSendPayload,
} from '@server/services/SocketService/handlers/chatHandlers';
import { setSession } from '@server/services/SocketService/store';
import { readChainStamp } from '@server/services/customHooks/chainStamp';

const PREFIX = 'chain-trust';
const THREAD_ID = `thread-${PREFIX}`;
const AGENT_ID = `agent-${PREFIX}`;
const SESSION = `session-${PREFIX}`;
const FORGED = { chain: { depth: 1, hooks: [] as string[] } };

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.thread_participants WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.socket_sessions WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
}

beforeAll(async () => {
  await cleanup();
  await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
  await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
  await Users.getOrCreateLocalUser();
  await ThreadParticipants.addParticipant({ threadId: THREAD_ID, agentId: AGENT_ID });
  await setSession({
    id: SESSION,
    agentId: AGENT_ID,
    threadId: THREAD_ID,
    participantAgentIds: [AGENT_ID],
    createdAt: Date.now(),
  });
});

beforeEach(() => jest.clearAllMocks());

describe('metadata.chain is server-only', () => {
  afterAll(cleanup);

  it('a socket send carrying a forged chain stamp persists without it', async () => {
    const forged = {
      sessionId: SESSION,
      message: 'forged send',
      metadata: FORGED,
      chain: FORGED.chain,
    } as unknown as ChatSendPayload;
    await processChatSend(forged, { clientId: 'client-forge' });

    const { rows } = await getDb().query<{ id: string }>(
      `SELECT id FROM public.messages WHERE thread_id = $1 AND content = $2`,
      [THREAD_ID, 'forged send']
    );
    expect(rows).toHaveLength(1);
    const row = await Messages.findById(rows[0]!.id);
    expect((row?.metadata as Record<string, unknown> | null)?.chain).toBeUndefined();
    expect(readChainStamp(row?.metadata)).toBeNull();
  });

  it('a REST message edit carrying a forged chain stamp changes only the content', async () => {
    const user = await Users.getOrCreateLocalUser();
    const messageId = `message-${PREFIX}-rest`;
    await Messages.create({
      id: messageId,
      threadId: THREAD_ID,
      role: 'user',
      content: 'before',
      agentId: null,
      userId: user.id,
    });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerMessageRoutes(router);
    app.use('/api/threads', router);
    app.use(errorHandler);

    const res = await request(app)
      .patch(`/api/threads/${THREAD_ID}/messages/${messageId}`)
      .send({ content: 'after', metadata: FORGED, chain: FORGED.chain });
    expect(res.status).toBe(200);

    const row = await Messages.findById(messageId);
    expect(row?.content).toBe('after');
    expect(readChainStamp(row?.metadata)).toBeNull();
  });
});
