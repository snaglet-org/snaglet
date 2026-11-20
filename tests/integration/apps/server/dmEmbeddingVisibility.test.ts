/**
 * DM threads are never embedded and never surface through the vector
 * lane, against the real database. The backfill and sweeps skip them
 * (the shared eligibility SQL); this covers the live path every chat send and
 * agent reply takes (`syncMessageEmbedding` -> `embedNode`), the per-id
 * embedding target, the live summary embed, and semantic-hit hydration, which
 * drops a hit inside a DM thread even when a vector for it exists.
 *
 * Only socket fan-out, the dispatch wave and the embedding model are stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import type { EmbeddingProvider } from '@server/services/embedding/EmbeddingProvider';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { sendToClient: jest.fn(), broadcastToChannel: jest.fn(), registerHandler: jest.fn() },
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
// The embedding model the chat path resolves, stubbed with a fixed vector.
jest.mock('@server/services/embedding/EmbeddingProvider', () => ({
  ...jest.requireActual<object>('@server/services/embedding/EmbeddingProvider'),
  resolveEmbeddingProvider: async () => testProvider(),
}));

import { getDb } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { Messages } from '@snaglet/db/tables/messages';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import { syncMessageEmbedding } from '@server/services/EmbeddingService';
import { syncThreadSummaryEmbedding } from '@server/services/SummaryService';
import { buildEmbeddingTarget } from '@server/services/embedding/EmbeddingNodeClassifier';
import { DmService } from '@server/services/dm/DmService';
import { isHelperThread, isHiddenThread } from '@server/services/subagents/helperVisibility';
import { hydrateSemanticHits } from '@server/services/ToolService/handlers/search/workspaceSearch/hydration';

const PROVIDER_ID = 'test-provider-a';
const MODEL_KEY = 'test-embedding-model-a';
const MODEL_ID = 'model-1111111111111-aaaaaaaaa';
const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';
const CHAT_THREAD = 'thread-1111111111111-aaaaaaaaa';
const CHAT_MESSAGE = 'message-1111111111111-aaaaaaaaa';
const USER_DM_MESSAGE = 'message-2222222222222-bbbbbbbbb';
const CHAT_SUMMARY = 'thread_summary-1111111111111-aaaaaaaaa';
const DM_SUMMARY = 'thread_summary-2222222222222-bbbbbbbbb';

function topicVector(): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[17] = 1;
  return vector;
}

function testProvider(): EmbeddingProvider {
  return {
    info: { provider: PROVIDER_ID, model: MODEL_KEY, dimensions: 768 },
    embedDocument: async () => topicVector(),
    embedQuery: async () => topicVector(),
  };
}

let userId: string;
let userDmThread: string;
let agentDmThread: string;
let agentDmMessage: string;
const previousIntelligence = process.env.SNAGLET_LOCAL_INTELLIGENCE;

beforeAll(async () => {
  // Automatic write-side embedding is opt-in; the chat path checks this.
  process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
  const pool = getDb();
  await pool.query(
    `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Test Provider A', 'runtime')`,
    [PROVIDER_ID]
  );
  await pool.query(
    `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
     VALUES ($1, $2, $3, 'Test Embedding Model A', 'embedding', 768)`,
    [MODEL_ID, PROVIDER_ID, MODEL_KEY]
  );
  await Agents.create({ id: AGENT_A, name: 'Test Agent A' });
  await Agents.create({ id: AGENT_B, name: 'Test Agent B' });
  const user =
    (await Users.findByName('Test User')) ??
    (await Users.createLocalUser({ name: 'Test User', email: 'user@example.com' }));
  userId = user.id;

  await Threads.create({ id: CHAT_THREAD, title: 'Release planning' });
  await Messages.create({
    id: CHAT_MESSAGE,
    threadId: CHAT_THREAD,
    role: 'user',
    userId,
    content: 'Ship the release notes on Friday.',
  });

  // The user's DM with an agent: the user writes in it through the chat path.
  userDmThread = (
    await DmService.findOrCreate({ kind: 'user', userId }, { kind: 'agent', agentId: AGENT_A })
  ).id;
  await Messages.create({
    id: USER_DM_MESSAGE,
    threadId: userDmThread,
    role: 'user',
    userId,
    content: 'Ship the release notes on Friday, privately.',
  });

  // An agent-to-agent DM.
  const sent = await DmService.send({
    from: { kind: 'agent', agentId: AGENT_A },
    to: { kind: 'agent', agentId: AGENT_B },
    content: 'Ship the release notes on Friday, between us.',
  });
  agentDmThread = sent.threadId;
  agentDmMessage = sent.messageId;

  await ThreadSummaries.insertNewVersion({
    id: CHAT_SUMMARY,
    threadId: CHAT_THREAD,
    agentId: AGENT_A,
    summaryText: 'The team planned the release notes.',
    messagesCovered: 1,
  });
  await ThreadSummaries.insertNewVersion({
    id: DM_SUMMARY,
    threadId: userDmThread,
    agentId: AGENT_A,
    summaryText: 'The user and Test Agent A planned the release notes privately.',
    messagesCovered: 1,
  });
});

afterAll(() => {
  if (previousIntelligence === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
  else process.env.SNAGLET_LOCAL_INTELLIGENCE = previousIntelligence;
});

describe('the hidden-thread check', () => {
  it('treats DM threads as hidden while isHelperThread keeps its helper-only answer', async () => {
    expect(await isHiddenThread(userDmThread)).toBe(true);
    expect(await isHiddenThread(agentDmThread)).toBe(true);
    expect(await isHiddenThread(CHAT_THREAD)).toBe(false);
    expect(await isHiddenThread(null)).toBe(false);
    // Notifications and subagent bookkeeping rely on the helper-only answer.
    expect(await isHelperThread(userDmThread)).toBe(false);
  });
});

describe('live embedding', () => {
  it('a user message in a DM thread gets no vector through the chat send path', async () => {
    await syncMessageEmbedding(USER_DM_MESSAGE, 'Ship the release notes on Friday, privately.');
    expect(await Embeddings.listByNode(USER_DM_MESSAGE)).toHaveLength(0);
  });

  it('an agent-to-agent DM gets no vector, and one written earlier is dropped', async () => {
    await Embeddings.create({
      nodeId: agentDmMessage,
      modelId: MODEL_ID,
      vector: topicVector(),
      contentHash: `hash-${agentDmMessage}`,
    });
    await syncMessageEmbedding(agentDmMessage, 'Ship the release notes on Friday, between us.');
    expect(await Embeddings.listByNode(agentDmMessage)).toHaveLength(0);
  });

  it('a message in an ordinary thread is still embedded', async () => {
    await syncMessageEmbedding(CHAT_MESSAGE, 'Ship the release notes on Friday.');
    expect(await Embeddings.listByNode(CHAT_MESSAGE)).toHaveLength(1);
  });

  it('a DM message or summary is never an embedding target; ordinary ones are', async () => {
    expect(await buildEmbeddingTarget('message', USER_DM_MESSAGE)).toBeNull();
    expect(await buildEmbeddingTarget('message', agentDmMessage)).toBeNull();
    expect(await buildEmbeddingTarget('message', CHAT_MESSAGE)).not.toBeNull();
    expect(await buildEmbeddingTarget('thread_summary', DM_SUMMARY)).toBeNull();
    expect(await buildEmbeddingTarget('thread_summary', CHAT_SUMMARY)).not.toBeNull();
  });

  it('a DM thread summary gets no vector; an ordinary one does', async () => {
    const dmSummary = await ThreadSummaries.findById(DM_SUMMARY);
    const chatSummary = await ThreadSummaries.findById(CHAT_SUMMARY);
    if (!dmSummary || !chatSummary) throw new Error('summaries were not seeded');
    await syncThreadSummaryEmbedding(dmSummary);
    await syncThreadSummaryEmbedding(chatSummary);
    expect(await Embeddings.listByNode(DM_SUMMARY)).toHaveLength(0);
    expect(await Embeddings.listByNode(CHAT_SUMMARY)).toHaveLength(1);
  });
});

describe('semantic-hit hydration', () => {
  it('drops a message or summary hit inside a DM thread even when a vector exists', async () => {
    for (const nodeId of [USER_DM_MESSAGE, DM_SUMMARY]) {
      await Embeddings.create({
        nodeId,
        modelId: MODEL_ID,
        vector: topicVector(),
        contentHash: `hash-${nodeId}`,
      });
    }
    const hits = await hydrateSemanticHits([
      { id: USER_DM_MESSAGE, kind: 'message', score: 1, channels: ['vector'] },
      { id: agentDmMessage, kind: 'message', score: 0.9, channels: ['vector'] },
      { id: CHAT_MESSAGE, kind: 'message', score: 0.8, channels: ['vector'] },
      { id: DM_SUMMARY, kind: 'thread_summary', score: 0.7, channels: ['vector'] },
      { id: CHAT_SUMMARY, kind: 'thread_summary', score: 0.6, channels: ['vector'] },
    ]);
    expect(hits.map((hit) => hit.id)).toEqual([CHAT_MESSAGE, CHAT_SUMMARY]);
  });
});
