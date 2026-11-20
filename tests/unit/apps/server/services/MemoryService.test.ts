import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

const findByKey = jest.fn();
const findNearDuplicate = jest.fn();
const createMemory = jest.fn();
const updateMemory = jest.fn();
const createEmbedding = jest.fn();
const upsertLink = jest.fn();
const generateDocumentEmbedding = jest.fn();
const generateQueryEmbedding = jest.fn();
const getByThreadAndAgent = jest.fn();
const hybridSearch = jest.fn();

jest.mock('@snaglet/db/tables/memories', () => ({
  Memories: {
    findByKey: (...args: unknown[]) => findByKey(...args),
    findNearDuplicate: (...args: unknown[]) => findNearDuplicate(...args),
    create: (...args: unknown[]) => createMemory(...args),
    update: (...args: unknown[]) => updateMemory(...args),
    hybridSearch: (...args: unknown[]) => hybridSearch(...args),
    deleteOne: jest.fn(),
    deleteByQuery: jest.fn(),
    listByAgent: jest.fn(),
    findById: jest.fn(),
    getStats: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/embeddings', () => ({
  Embeddings: {
    create: (...args: unknown[]) => createEmbedding(...args),
  },
}));

jest.mock('@snaglet/db/tables/links', () => ({
  Links: {
    upsert: (...args: unknown[]) => upsertLink(...args),
  },
}));

jest.mock('@snaglet/db/tables/thread_summaries', () => ({
  ThreadSummaries: {
    getByThreadAndAgent: (...args: unknown[]) => getByThreadAndAgent(...args),
  },
}));

jest.mock('@server/services/EmbeddingService.js', () => ({
  generateDocumentEmbedding: (...args: unknown[]) => generateDocumentEmbedding(...args),
  generateQueryEmbedding: (...args: unknown[]) => generateQueryEmbedding(...args),
}));

import { memoryService } from '@server/services/MemoryService';

const previousLocalIntelligence = process.env.SNAGLET_LOCAL_INTELLIGENCE;

describe('MemoryService.store', () => {
  beforeEach(() => {
    process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
    jest.clearAllMocks();
    generateDocumentEmbedding.mockResolvedValue({
      embedding: [0.12, -0.03, 0.44],
      model: 'text-embedding-test',
      provider: 'openai',
      modelRowId: 'model-row-1',
    });
    generateQueryEmbedding.mockResolvedValue({
      embedding: [0.12, -0.03, 0.44],
      model: 'text-embedding-test',
      provider: 'openai',
      modelRowId: 'model-row-1',
    });
    findByKey.mockResolvedValue(null);
    findNearDuplicate.mockResolvedValue(null);
    createMemory.mockResolvedValue(undefined);
    createEmbedding.mockResolvedValue(undefined);
    upsertLink.mockResolvedValue(undefined);
    getByThreadAndAgent.mockResolvedValue(null);
    hybridSearch.mockResolvedValue([]);
  });

  afterAll(() => {
    if (previousLocalIntelligence === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    else process.env.SNAGLET_LOCAL_INTELLIGENCE = previousLocalIntelligence;
  });

  it('stores without automatic embedding or semantic dedup when quiet by default', async () => {
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;

    await memoryService.store({
      agentId: 'agent-1',
      key: 'quiet',
      content: 'Persist this without loading a model',
    });

    expect(generateDocumentEmbedding).not.toHaveBeenCalled();
    expect(findNearDuplicate).not.toHaveBeenCalled();
    expect(createEmbedding).not.toHaveBeenCalled();
    expect(createMemory).toHaveBeenCalled();
  });

  it('preserves explicitly requested memory recall while automatic indexing is off', async () => {
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;

    await memoryService.recall({ agentId: 'agent-1', query: 'project promise' });

    expect(generateQueryEmbedding).toHaveBeenCalledWith('project promise');
    expect(hybridSearch).toHaveBeenCalledTimes(1);
  });

  it('stores sourceThreadId and creates memory -> thread provenance link', async () => {
    const result = await memoryService.store({
      agentId: 'agent-1',
      threadId: 'thread-1',
      key: 'plan',
      content: 'Remember provenance',
    });

    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: 'thread-1',
      })
    );

    expect(upsertLink).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: result.id,
        targetId: 'thread-1',
        relation: 'context',
      })
    );

    // Service creates the thread provenance link; no summary exists, so the
    // summary link is skipped.
    expect(upsertLink).toHaveBeenCalledTimes(1);
  });

  it('threadless store creates no provenance link (agents are not nodes)', async () => {
    const result = await memoryService.store({
      agentId: 'agent-1',
      // no threadId
      key: 'standalone',
      content: 'A memory saved outside any thread',
    });

    // The memory is still stored, with a null source thread.
    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-1', sourceThreadId: null })
    );
    // No thread ⇒ no link at all: agents are not nodes, so there is no agent
    // node to link to.
    expect(upsertLink).not.toHaveBeenCalled();
    expect(result.id).toBeTruthy();
  });

  // verified / status semantics (compaction-time extraction)

  it('an explicit store defaults to verified=true, status=active (a deliberate act)', async () => {
    await memoryService.store({
      agentId: 'agent-1',
      key: 'hand-saved',
      content: 'Deliberately saved by the agent.',
    });

    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true, status: 'active' })
    );
  });

  it('extraction-style agent store passes verified=false through, still active', async () => {
    await memoryService.store({
      agentId: 'agent-1',
      key: 'extracted-fact',
      content: 'Machine-extracted, unreviewed.',
      verified: false,
    });

    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ verified: false, status: 'active' })
    );
  });

  it('a proposed store creates an inert proposal and skips semantic near-dup rewriting', async () => {
    await memoryService.store({
      memberId: 'member-1',
      key: 'user-pref',
      content: 'Test User prefers plain-language reports.',
      verified: false,
      status: 'proposed',
    });

    expect(createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'member-1', verified: false, status: 'proposed' })
    );
    // Embeddings are on in this suite; the near-dup branch must still not run
    // for a proposal — it could rewrite an existing active memory with
    // unapproved content.
    expect(findNearDuplicate).not.toHaveBeenCalled();
  });

  it('a proposal never overwrites an existing active memory under the same key', async () => {
    findByKey.mockResolvedValue({
      id: 'memory-active',
      key: 'user-pref',
      content: 'The approved version.',
      status: 'active',
      verified: true,
    });

    const result = await memoryService.store({
      memberId: 'member-1',
      key: 'user-pref',
      content: 'Unapproved replacement.',
      verified: false,
      status: 'proposed',
    });

    expect(result).toEqual({ id: 'memory-active', key: 'user-pref', isDuplicate: true });
    expect(updateMemory).not.toHaveBeenCalled();
    expect(createMemory).not.toHaveBeenCalled();
  });

  it('a proposal refreshes an existing pending proposal in place (stays proposed)', async () => {
    findByKey.mockResolvedValue({
      id: 'memory-proposed',
      key: 'user-pref',
      content: 'Older proposal text.',
      status: 'proposed',
      verified: false,
    });

    await memoryService.store({
      memberId: 'member-1',
      key: 'user-pref',
      content: 'Fresher proposal text.',
      verified: false,
      status: 'proposed',
    });

    expect(updateMemory).toHaveBeenCalledWith(
      'memory-proposed',
      expect.objectContaining({
        content: 'Fresher proposal text.',
        verified: false,
        status: 'proposed',
      })
    );
    expect(createMemory).not.toHaveBeenCalled();
  });

  it('an explicit active store onto a proposed row promotes it (re-saving is approval)', async () => {
    findByKey.mockResolvedValue({
      id: 'memory-proposed',
      key: 'user-pref',
      content: 'Pending proposal.',
      status: 'proposed',
      verified: false,
    });

    await memoryService.store({
      memberId: 'member-1',
      key: 'user-pref',
      content: 'The member saved this themselves.',
    });

    expect(updateMemory).toHaveBeenCalledWith(
      'memory-proposed',
      expect.objectContaining({ verified: true, status: 'active' })
    );
  });
});
