/**
 * Subagent helper threads are never embedded or announced, against the real
 * database: the helper predicates, the shared message eligibility SQL
 * (sweeps, backfill, startup purge), embedNode and the embedding targets, and
 * notifications. They are summarized (their summaries compact the helper's
 * context until it is removed), but a helper summary gets no vector, the
 * backfill skips them, and a failing summary never halts one.
 */

import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import {
  Messages,
  Notifications,
  ThreadSummaries,
  Threads,
  closeDatabase,
  getDb,
} from '@snaglet/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import type { EmbeddingProvider } from '@server/services/embedding/EmbeddingProvider';
import { embedNode } from '@server/services/embedding/EmbeddingOrchestrator';
import {
  buildEmbeddingTarget,
  listEmbeddingTargets,
} from '@server/services/embedding/EmbeddingNodeClassifier';
import { EMBEDDABLE_MESSAGE_SQL } from '@server/services/embedding/messageEligibility';
import { removeAllIneligibleMessageEmbeddings } from '@server/services/embedding/injectedMessageCleanup';
import {
  isHelperAgent,
  isHelperThread,
  isKnownHelperThread,
} from '@server/services/subagents/helperVisibility';
import { summaryService } from '@server/services/SummaryService';
import { resetMemoryGuardrailsForTests } from '@server/services/summary/memoryGuardrails';
import { haltOnSummaryFailure } from '@server/services/summary/summaryHalt';
import { notificationService } from '@server/services/NotificationService';
import {
  AGENT_ID,
  HELPER_AGENT_ID,
  HELPER_MESSAGE_ID,
  HELPER_SUMMARY_ID,
  HELPER_THREAD_ID,
  MESSAGE_ID,
  SUMMARY_ID,
  THREAD_ID,
  seedHelperWorkspace,
} from './helperFixture';

const PROVIDER_ID = 'test-provider-a';
const MODEL_KEY = 'test-embedding-model-a';
const MODEL_ID = 'model-1111111111111-aaaaaaaaa';
/** An injected run error in the helper thread: eligible anywhere else. */
const HELPER_RUN_ERROR_ID = 'message-3333333333333-ccccccccc';
const LATE_HELPER_THREAD_ID = 'thread-5555555555555-eeeeeeeee';

function topicVector(): number[] {
  const vector = new Array<number>(768).fill(0);
  vector[17] = 1;
  return vector;
}

const provider: EmbeddingProvider = {
  info: { provider: PROVIDER_ID, model: MODEL_KEY, dimensions: 768 },
  async embedDocument(): Promise<number[]> {
    return topicVector();
  },
  async embedQuery(): Promise<number[]> {
    return topicVector();
  },
};

async function vectorize(nodeId: string): Promise<void> {
  await Embeddings.create({
    nodeId,
    modelId: MODEL_ID,
    vector: topicVector(),
    contentHash: `hash-${nodeId}`,
  });
}

async function seedConversation(threadId: string, agentId: string): Promise<void> {
  await ThreadParticipants.addParticipant({
    threadId,
    agentId,
    providerId: 'ollama',
    modelId: 'qwen2.5:3b',
  });
  for (let i = 0; i < 10; i++) {
    await Messages.create({
      id: `message-${threadId.slice('thread-'.length)}-${i}`,
      threadId,
      role: 'assistant',
      agentId,
      content: `Step ${i} of the checklist.`,
    });
  }
}

describe('subagent helper threads are summarized but never embedded or announced', () => {
  beforeAll(async () => {
    await seedHelperWorkspace();
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
    await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'message')`, [
      HELPER_RUN_ERROR_ID,
    ]);
    await pool.query(
      `INSERT INTO public.messages (id, thread_id, role, agent_id, content, metadata)
       VALUES ($1, $2, 'assistant', $3, 'The run timed out.', $4::jsonb)`,
      [
        HELPER_RUN_ERROR_ID,
        HELPER_THREAD_ID,
        HELPER_AGENT_ID,
        JSON.stringify({ injected_during_run: true, run_error: { kind: 'timeout' } }),
      ]
    );
  });

  afterAll(async () => {
    await closeDatabase();
  });

  describe('helper predicates', () => {
    it('tell helper threads and agents from visible ones', async () => {
      expect(await isHelperThread(HELPER_THREAD_ID)).toBe(true);
      expect(await isHelperThread(THREAD_ID)).toBe(false);
      expect(await isHelperThread(null)).toBe(false);
      expect(await isHelperAgent(HELPER_AGENT_ID)).toBe(true);
      expect(await isHelperAgent(AGENT_ID)).toBe(false);
      expect(isKnownHelperThread(HELPER_THREAD_ID)).toBe(true);
      expect(isKnownHelperThread(THREAD_ID)).toBe(false);
    });

    it('do not cache an id that has no row yet', async () => {
      expect(await isHelperThread(LATE_HELPER_THREAD_ID)).toBe(false);
      await Threads.create({
        id: LATE_HELPER_THREAD_ID,
        title: 'Late helper',
        parentThreadId: THREAD_ID,
      });
      expect(await isHelperThread(LATE_HELPER_THREAD_ID)).toBe(true);
    });
  });

  describe('embeddings', () => {
    it('the shared eligibility SQL admits nothing from a helper thread', async () => {
      const { rows } = await getDb().query<{ id: string }>(
        `SELECT m.id FROM public.messages m
          WHERE m.id = ANY($1::text[]) AND ${EMBEDDABLE_MESSAGE_SQL}
          ORDER BY m.id`,
        [[MESSAGE_ID, HELPER_MESSAGE_ID, HELPER_RUN_ERROR_ID]]
      );
      expect(rows.map((row) => row.id)).toEqual([MESSAGE_ID]);
    });

    it('the startup purge drops helper vectors and keeps the rest', async () => {
      for (const id of [MESSAGE_ID, HELPER_MESSAGE_ID, HELPER_RUN_ERROR_ID]) await vectorize(id);
      expect(await removeAllIneligibleMessageEmbeddings()).toBe(2);
      expect(await Embeddings.listByNode(MESSAGE_ID)).toHaveLength(1);
      expect(await Embeddings.listByNode(HELPER_MESSAGE_ID)).toHaveLength(0);
      expect(await Embeddings.listByNode(HELPER_RUN_ERROR_ID)).toHaveLength(0);
    });

    it('backfill targets never include a helper message', async () => {
      const ids = (await listEmbeddingTargets(['message'])).map((target) => target.nodeId);
      expect(ids).toContain(MESSAGE_ID);
      expect(ids).not.toContain(HELPER_MESSAGE_ID);
      expect(ids).not.toContain(HELPER_RUN_ERROR_ID);
      expect(await buildEmbeddingTarget('message', HELPER_MESSAGE_ID)).toBeNull();
      expect(await buildEmbeddingTarget('message', MESSAGE_ID)).not.toBeNull();
    });

    it('embedNode refuses a helper message and drops its old vectors', async () => {
      await vectorize(HELPER_MESSAGE_ID);
      const result = await embedNode({
        nodeId: HELPER_MESSAGE_ID,
        content: 'The ledger draft from the helper.',
        providerOverride: provider,
      });
      expect(result).toMatchObject({ ok: false, skipped: 'ineligible' });
      expect(await Embeddings.listByNode(HELPER_MESSAGE_ID)).toHaveLength(0);

      const visible = await embedNode({
        nodeId: MESSAGE_ID,
        content: 'The ledger is reconciled.',
        providerOverride: provider,
      });
      expect(visible.skipped).not.toBe('ineligible');
    });
  });

  describe('summaries', () => {
    it('a helper thread is summarized like any thread (its summaries compact its context)', async () => {
      const outcome = await summaryService.generateSummary({
        threadId: HELPER_THREAD_ID,
        agentId: HELPER_AGENT_ID,
        force: true,
      });
      // No summary model is configured here, so the pass stops at model
      // resolution; it does not stop earlier as a helper thread.
      expect(outcome).not.toMatchObject({ reason: 'helper-thread' });
    });

    it('a helper summary is never an embedding target', async () => {
      // seedHelperWorkspace wrote one summary in each thread.
      const ids = (await listEmbeddingTargets(['thread_summary'])).map((t) => t.nodeId);
      expect(ids).toContain(SUMMARY_ID);
      expect(ids).not.toContain(HELPER_SUMMARY_ID);
      expect(await buildEmbeddingTarget('thread_summary', HELPER_SUMMARY_ID)).toBeNull();
      expect(await buildEmbeddingTarget('thread_summary', SUMMARY_ID)).not.toBeNull();
    });

    it('a failing summary never halts a hidden helper thread; a visible one still halts', async () => {
      const broken = { status: 'skipped', reason: 'no-credentials' } as const;
      expect(await haltOnSummaryFailure(broken, { threadId: HELPER_THREAD_ID })).toBeNull();
      expect(await haltOnSummaryFailure(broken, { threadId: THREAD_ID })).not.toBeNull();
    });
  });

  it('a helper thread or agent raises no notification; a visible one still does', async () => {
    expect(
      await notificationService.create({
        type: 'run_completed',
        title: 'Helper finished',
        threadId: HELPER_THREAD_ID,
        agentId: HELPER_AGENT_ID,
      })
    ).toBeNull();
    expect(
      await notificationService.create({
        type: 'run_failed',
        title: 'Helper failed',
        agentId: HELPER_AGENT_ID,
      })
    ).toBeNull();
    const visible = await notificationService.create({
      type: 'run_completed',
      title: 'Visible finished',
      threadId: THREAD_ID,
      agentId: AGENT_ID,
    });
    expect(visible?.threadId).toBe(THREAD_ID);
    const titles = (await Notifications.listRecent(50)).map((row) => row.title);
    expect(titles).toContain('Visible finished');
    expect(titles).not.toContain('Helper finished');
    expect(titles).not.toContain('Helper failed');
  });
});
