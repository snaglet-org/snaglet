import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const findMessage = jest.fn<(...args: unknown[]) => Promise<unknown>>(async () => null);
const deleteByNodeId = jest.fn(async (_id: string) => undefined);
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { findById: (...args: unknown[]) => findMessage(...args) },
}));

const resolveEmbeddingProvider = jest.fn(async () => null);
const findByNodeModelHash = jest.fn(async () => null);
const replaceChunks = jest.fn(async () => []);
const touchByNodeModel = jest.fn(async () => undefined);
const findByProviderAndModelId = jest.fn(async () => ({
  id: 'model-row-1',
  contextWindowTokens: 512,
}));

jest.mock('@server/services/embedding/EmbeddingProvider', () => ({
  resolveEmbeddingProvider: (...args: unknown[]) => resolveEmbeddingProvider(...args),
}));

jest.mock('@snaglet/db/tables/embeddings', () => ({
  Embeddings: {
    deleteByNodeId,
    findByNodeModelHash: (...args: unknown[]) => findByNodeModelHash(...args),
    replaceChunks: (...args: unknown[]) => replaceChunks(...args),
    touchByNodeModel: (...args: unknown[]) => touchByNodeModel(...args),
  },
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: (...args: unknown[]) => findByProviderAndModelId(...args),
  },
}));

import { embedNode, embedNodeNow } from '@server/services/embedding/EmbeddingOrchestrator';

const previousLocalIntelligence = process.env.SNAGLET_LOCAL_INTELLIGENCE;

describe('automatic node embedding policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMessage.mockResolvedValue(null);
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    findByNodeModelHash.mockResolvedValue(null);
    replaceChunks.mockResolvedValue([]);
    findByProviderAndModelId.mockResolvedValue({
      id: 'model-row-1',
      contextWindowTokens: 512,
    });
  });

  afterAll(() => {
    if (previousLocalIntelligence === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    else process.env.SNAGLET_LOCAL_INTELLIGENCE = previousLocalIntelligence;
  });

  it('does not resolve a provider for an ordinary write by default', async () => {
    embedNodeNow('doc-1', 'quiet write');
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveEmbeddingProvider).not.toHaveBeenCalled();
  });

  it('restores immediate indexing after explicit opt-in', async () => {
    process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
    embedNodeNow('doc-1', 'indexed write');
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveEmbeddingProvider).toHaveBeenCalledTimes(1);
  });

  it('reports a guarded stale write as superseded without exposing partial persistence', async () => {
    const expectedNodeUpdatedAt = '2026-07-20T00:00:00.000Z';
    replaceChunks.mockResolvedValue(null);

    const result = await embedNode({
      nodeId: 'image-1',
      content: 'old image metadata',
      expectedNodeUpdatedAt,
      providerOverride: {
        info: { provider: 'test-provider', model: 'test-model', dimensions: 768 },
        embedDocument: jest.fn(async () => new Array(768).fill(0.2)),
        embedQuery: jest.fn(async () => new Array(768).fill(0.2)),
      },
    });

    expect(replaceChunks).toHaveBeenCalledWith(
      'image-1',
      'model-row-1',
      expect.any(String),
      expect.any(Array),
      { expectedNodeUpdatedAt }
    );
    expect(result).toMatchObject({ ok: false, skipped: 'superseded' });
  });
});

describe('injected message guard', () => {
  it.each(['user', 'assistant'])(
    'rejects injected %s rows before provider lookup',
    async (role) => {
      jest.clearAllMocks();
      findMessage.mockResolvedValue({ role, messageType: 'message', injectedDuringRun: true });
      const result = await embedNode({
        nodeId: 'message-injected',
        content: 'operational content',
      });
      expect(result.skipped).toBe('ineligible');
      expect(resolveEmbeddingProvider).not.toHaveBeenCalled();
      expect(deleteByNodeId).toHaveBeenCalledWith('message-injected');
    }
  );
  it('rejects thread events even without the injected flag', async () => {
    jest.clearAllMocks();
    findMessage.mockResolvedValue({
      role: 'user',
      messageType: 'thread_event',
      injectedDuringRun: false,
    });
    expect((await embedNode({ nodeId: 'message-event', content: 'event' })).skipped).toBe(
      'ineligible'
    );
  });
});
