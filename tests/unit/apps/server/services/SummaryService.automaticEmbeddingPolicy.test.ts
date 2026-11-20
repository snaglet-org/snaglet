/**
 * Per-agent thread-summary policy:
 *
 * - `SNAGLET_LOCAL_INTELLIGENCE` governs local compute only — here, the thread-
 *   summary gist embedding (`syncThreadSummaryEmbedding`) stays opt-in.
 * - Summary generation resolves only Agent/thread-agent controls and the
 *   effective agent model; there is no global Memory settings gate.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const listByNode = jest.fn(async () => []);
const embedNode = jest.fn(async (_input: unknown): Promise<unknown> => ({ ok: true }));
const isHiddenThread = jest.fn(async (_threadId: string) => false);
const resolveUtilityModel = jest.fn(
  async (): Promise<unknown> => ({ ok: false, reason: 'no-model-for-agent', detail: 'test' })
);

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@snaglet/db/tables/embeddings', () => ({
  Embeddings: {
    listByNode: (...args: unknown[]) => listByNode(...(args as [])),
  },
}));
// One message, so a forced pass has something to summarize and reaches model resolution (a pass
// over an empty thread is skipped before it).
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    listByThreadId: async () => [
      {
        id: 'message-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Please summarize this.',
        messageType: 'text',
        agentId: null,
        userId: 'user-1',
        createdAt: '2026-08-11T10:00:01.000Z',
        injectedDuringRun: false,
        runId: null,
      },
    ],
  },
}));
jest.mock('@server/services/subagents/helperVisibility', () => ({
  isHiddenThread: (threadId: string) => isHiddenThread(threadId),
}));
jest.mock('@server/services/embedding/EmbeddingOrchestrator', () => ({
  embedNode: (input: unknown) => embedNode(input),
}));
jest.mock('@server/services/summary/UtilityModelResolver', () => ({
  resolveUtilityModel: (...args: unknown[]) => resolveUtilityModel(...(args as [])),
}));
jest.mock('@server/services/summary/generateUtilityText', () => ({
  generateUtilityText: jest.fn(async () => 'unused in these tests'),
}));

import { summaryService, syncThreadSummaryEmbedding } from '@server/services/SummaryService';
import { resetMemoryStatusRegistryForTests } from '@server/services/summary/MemoryStatusRegistry';
import { resetMemoryGuardrailsForTests } from '@server/services/summary/memoryGuardrails';
import { resetUtilityConcurrencyForTests } from '@server/services/summary/utilityConcurrency';

const previousLocalIntelligence = process.env.SNAGLET_LOCAL_INTELLIGENCE;
const summary = {
  id: 'thread-summary-1',
  summaryText: 'A durable summary',
};

describe('local-compute flag: thread-summary embedding policy (unchanged by D2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
  });

  afterAll(() => {
    if (previousLocalIntelligence === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    else process.env.SNAGLET_LOCAL_INTELLIGENCE = previousLocalIntelligence;
  });

  it('does not inspect or create summary embeddings by default', async () => {
    await syncThreadSummaryEmbedding(summary as never, { forceUpsert: true });

    expect(listByNode).not.toHaveBeenCalled();
    expect(embedNode).not.toHaveBeenCalled();
  });

  it('restores summary embedding after explicit opt-in', async () => {
    process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';

    await syncThreadSummaryEmbedding(summary as never, { forceUpsert: true });

    // Handed to the chunking embedder by node id, which persists the vectors itself.
    expect(embedNode).toHaveBeenCalledWith({
      nodeId: 'thread-summary-1',
      content: 'A durable summary',
    });
  });

  it('gives a summary in a hidden thread (a helper or a DM) no vector, even when asked', async () => {
    process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
    isHiddenThread.mockResolvedValueOnce(true);

    await syncThreadSummaryEmbedding({ ...summary, threadId: 'thread-dm' } as never, {
      forceUpsert: true,
      explicit: true,
    });

    expect(isHiddenThread).toHaveBeenCalledWith('thread-dm');
    expect(embedNode).not.toHaveBeenCalled();
  });

  it('does not throw when the embedder cannot embed, so a fold or digest still lands', async () => {
    process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
    embedNode.mockResolvedValueOnce({ ok: false, skipped: 'no-provider', error: 'no model' });
    await expect(
      syncThreadSummaryEmbedding(summary as never, { forceUpsert: true })
    ).resolves.toBeUndefined();
  });

  it('preserves embedding for an explicitly requested manual summary', async () => {
    await syncThreadSummaryEmbedding(summary as never, {
      forceUpsert: true,
      explicit: true,
    });

    expect(embedNode).toHaveBeenCalledTimes(1);
  });
});

describe('automatic generation uses agent-owned model resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetMemoryStatusRegistryForTests();
    resetMemoryGuardrailsForTests();
    resetUtilityConcurrencyForTests();
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    process.env.COMPACT_CONVERSATIONS = 'true';
  });

  it('reaches model resolution without a global Memory setting or local-intelligence flag', async () => {
    // Forced, because due-ness is settled before resolution (an
    // unavailable summary model stops the run, so a thread that owes no
    // summary must not report one). This test is about the absence of a global
    // Memory gate, not about cadence.
    const outcome = await summaryService.generateSummary({ threadId: 'thread-1', force: true });

    // It got past the gate and into resolution (which we made skip) — the
    // old behavior returned before ever consulting a resolver.
    expect(resolveUtilityModel).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'no-model-for-agent' });
  });
});
