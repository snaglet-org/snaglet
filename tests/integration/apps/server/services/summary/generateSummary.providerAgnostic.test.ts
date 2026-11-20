/**
 * Integration (real managed PostgreSQL): provider-agnostic thread-summary
 * generation end-to-end — real thread/agent/participant/message rows, the
 * real UtilityModelResolver + settings registry, real thread_summaries
 * writes. Only the network boundary (providerChatService.complete) and the
 * local embedder are faked.
 *
 *  1. An agent on Ollama gets a summary via its own model, stamped with
 *     provider-qualified provenance.
 *  2. A deliberately-garbage fake exercises the quality floor: one
 *     simplified-prompt retry, then a visible skip and no row written.
 */

const completeMock = jest.fn(async (): Promise<{ reply: string }> => ({ reply: '' }));
const broadcastToChannel = jest.fn();

jest.mock('@server/services/ProviderChatService', () => ({
  providerChatService: {
    complete: (...args: unknown[]) => completeMock(...(args as [])),
  },
}));
jest.mock('@server/services/EmbeddingService', () => ({
  generateDocumentEmbedding: jest.fn(async () => ({ embedding: null, modelRowId: null })),
}));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a) },
}));

import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { closeDatabase, getDb, Messages, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { settingsService } from '@server/services/settings';
import { agentSettings } from '@server/services/settings/categories/agent';
import { summaryService } from '@server/services/SummaryService';
import { resetUtilityConcurrencyForTests } from '@server/services/summary/utilityConcurrency';

const PREFIX = `summary-pa-it-${Date.now()}`;
const THREAD_ID = `thread-${PREFIX}`;
const AGENT_ID = `agent-${PREFIX}`;

const GOOD_SUMMARY =
  'The user asked the ollama agent to outline a migration plan; the agent proposed three steps ' +
  'and the user approved the first two. Next step: verify the backup path.';

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(
    `DELETE FROM public.links WHERE source_id IN
       (SELECT id FROM public.thread_summaries WHERE thread_id = $1)`,
    [THREAD_ID]
  );
  await pool.query(
    `DELETE FROM public.nodes WHERE id IN
       (SELECT id FROM public.thread_summaries WHERE thread_id = $1)`,
    [THREAD_ID]
  );
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.thread_participants WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1) OR id LIKE $2`, [
    [THREAD_ID, AGENT_ID],
    `message-${PREFIX}-%`,
  ]);
}

let priorCompactPolicy: string | undefined;

describe('provider-agnostic thread summaries (real DB)', () => {
  beforeAll(async () => {
    // A developer .env may ship COMPACT_CONVERSATIONS=false (it is gitignored,
    // so this suite passes on CI and fails locally otherwise). That override is
    // checked before anything else in generateSummary, which would answer
    // 'compact-conversations-disabled' for every case here. Pin it on, exactly
    // as summaryHandlers.compactHalt.test.ts does.
    priorCompactPolicy = process.env.COMPACT_CONVERSATIONS;
    process.env.COMPACT_CONVERSATIONS = 'true';
    await cleanup();
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
    // The participant row carries the provider (ollama = keyless local).
    await ThreadParticipants.addParticipant({
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      providerId: 'ollama',
      modelId: 'qwen2.5:3b',
    });
    // Step 3 of the resolution chain — summarize on the agent's own effective
    // model — is what this file is about, and it is off by default
    // (`agent.summary_model_require_explicit`). Opt in, exactly as the setting
    // documents, so the own-model path is exercised rather than the override
    // path; the default's visible skip is covered by the resolver and
    // summary-halt suites.
    await settingsService.write(agentSettings.summaryModelRequireExplicit, false);
    const user = await Users.getOrCreateLocalUser();
    for (let i = 0; i < 3; i++) {
      await Messages.create({
        id: `message-${PREFIX}-${i}`,
        threadId: THREAD_ID,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: i % 2 === 0 ? `User request number ${i}.` : `Agent reply number ${i}.`,
        agentId: i % 2 === 0 ? null : AGENT_ID,
        userId: i % 2 === 0 ? user.id : null,
      });
    }
  });

  // Nested inside the describe so this unwinds before the shared DB teardown
  // (see packages/db/db.ts close-ordering guard).
  afterAll(async () => {
    if (priorCompactPolicy === undefined) {
      delete process.env.COMPACT_CONVERSATIONS;
    } else {
      process.env.COMPACT_CONVERSATIONS = priorCompactPolicy;
    }
    await settingsService.write(agentSettings.summaryModelRequireExplicit, true);
    await cleanup();
    await closeDatabase();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetUtilityConcurrencyForTests();
  });
  it('generates via the ollama agent own-model and stamps provenance', async () => {
    completeMock.mockImplementation(async () => ({ reply: GOOD_SUMMARY }));

    const outcome = await summaryService.generateSummary({
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      force: true,
    });

    expect(outcome).toMatchObject({
      status: 'generated',
      providerId: 'ollama',
      modelId: 'qwen2.5:3b',
    });

    // The fake provider was invoked with a synthetic ollama agent.
    const call = completeMock.mock.calls[0] as unknown[] | undefined;
    expect(call?.[0]).toMatchObject({ provider: 'ollama', modelId: 'qwen2.5:3b' });

    const row = await ThreadSummaries.getByThreadAndAgent(THREAD_ID, AGENT_ID);
    expect(row).not.toBeNull();
    expect(row?.summaryText).toBe(GOOD_SUMMARY);
    expect(row?.modelUsed).toBe('ollama/qwen2.5:3b');
  });

  it('garbage output hits the quality floor: retry once, then visible skip, nothing written', async () => {
    // Fresh thread state matters: remove the summary from the previous test.
    const pool = getDb();
    await pool.query(
      `DELETE FROM public.links WHERE source_id IN
         (SELECT id FROM public.thread_summaries WHERE thread_id = $1)`,
      [THREAD_ID]
    );
    await pool.query(`DELETE FROM public.thread_summaries WHERE thread_id = $1`, [THREAD_ID]);

    completeMock.mockImplementation(async () => ({ reply: 'I cannot summarize this.' }));

    const outcome = await summaryService.generateSummary({
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      force: true,
    });

    expect(outcome).toMatchObject({
      status: 'skipped',
      reason: 'quality-floor',
      detail: expect.stringContaining('ollama/qwen2.5:3b'),
    });
    expect(completeMock).toHaveBeenCalledTimes(2); // standard, then simplified retry

    const row = await ThreadSummaries.getByThreadAndAgent(THREAD_ID, AGENT_ID);
    expect(row).toBeNull();
  });
});
