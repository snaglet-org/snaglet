/**
 * ensureStartupEmbeddingBackfill — the post-migration re-embed trigger.
 *
 * Verifies the gating contract: it starts a backfill_missing job when nodes
 * lack local-model embeddings, is a no-op when the corpus is fully embedded,
 * and routes every node through embedNode (which is content_hash-aware, so a
 * restarted job skips already-written rows — the "resumable" property).
 */

import { beforeEach, describe, expect, it } from '@jest/globals';

const getLocalEmbedderStatus = jest.fn();
const findByProviderAndModelId = jest.fn();
const findById = jest.fn();
const getActiveModel = jest.fn();
const listEmbeddingTargets = jest.fn();
const classifyEmbeddingTargets = jest.fn();
const probeEmbeddingModel = jest.fn();
const resolveEmbeddingProviderForModel = jest.fn();
const embedNode = jest.fn();
const embedFileContent = jest.fn();
const dbQuery = jest.fn();
const countFileEmbeddingRows = jest.fn();

const EMBEDDING_NODE_TYPES = [
  'container',
  'doc',
  'memory',
  'message',
  'thread_summary',
  'file',
  'image',
] as const;

jest.mock('@snaglet/db/db', () => ({
  getDb: jest.fn(() => ({ query: (...args: unknown[]) => dbQuery(...args) })),
}));

jest.mock('@snaglet/db/tables/embeddings', () => ({
  Embeddings: { deleteByModelId: jest.fn(), deleteAll: jest.fn() },
}));

jest.mock('@snaglet/db/tables/files', () => ({
  FileEmbeddings: {
    countRows: (...args: unknown[]) => countFileEmbeddingRows(...args),
    deleteAll: jest.fn(),
    deleteByModelId: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: (...args: unknown[]) => findByProviderAndModelId(...args),
    findById: (...args: unknown[]) => findById(...args),
  },
}));

jest.mock('@server/services/embedding/EmbeddingNodeClassifier.js', () => ({
  BACKFILL_EMBEDDING_NODE_TYPES: EMBEDDING_NODE_TYPES,
  isEmbeddingNodeType: (value: string) =>
    (EMBEDDING_NODE_TYPES as readonly string[]).includes(value),
  listEmbeddingTargets: (...args: unknown[]) => listEmbeddingTargets(...args),
  classifyEmbeddingTargets: (...args: unknown[]) => classifyEmbeddingTargets(...args),
}));

jest.mock('@server/services/embedding/EmbeddingProvider.js', () => ({
  probeEmbeddingModel: (...args: unknown[]) => probeEmbeddingModel(...args),
  resolveEmbeddingProviderForModel: (...args: unknown[]) =>
    resolveEmbeddingProviderForModel(...args),
}));

const classifySemanticEntries = jest.fn();
const embedSemanticEntryTarget = jest.fn();
jest.mock('@server/services/tableSemantic/TableSemanticService', () => ({
  classifySemanticEntries: (...args: unknown[]) => classifySemanticEntries(...args),
  embedSemanticEntryTarget: (...args: unknown[]) => embedSemanticEntryTarget(...args),
}));
jest.mock('@server/services/embedding/EmbeddingOrchestrator.js', () => ({
  embedNode: (...args: unknown[]) => embedNode(...args),
}));

jest.mock('@server/services/embedding/fileContentEmbedding.js', () => ({
  embedFileContent: (...args: unknown[]) => embedFileContent(...args),
}));

jest.mock('@server/services/embedding/EmbeddingSettings.js', () => ({
  embeddingSettings: {
    getActiveModel: (...args: unknown[]) => getActiveModel(...args),
  },
}));

jest.mock('@server/services/embedding/LocalEmbedderService.js', () => ({
  getLocalEmbedderStatus: (...args: unknown[]) => getLocalEmbedderStatus(...args),
}));

import {
  cleanupStartupMessageEmbeddings,
  ensureStartupEmbeddingBackfill,
  getMaintenanceStatus,
  listMaintenanceModels,
  startMaintenanceJob,
} from '@server/services/EmbeddingMaintenanceService';

const MODEL_ROW = {
  id: 'model-local',
  providerId: 'local-onnx',
  modelId: 'nomic-embed-text-v1.5',
  dimensions: 768,
  isActive: true,
  type: 'embedding',
  contextWindowTokens: 512,
  metadata: {},
};

async function waitForJobToFinish(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (!getMaintenanceStatus().running) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('maintenance job never finished');
}

beforeEach(() => {
  classifySemanticEntries.mockResolvedValue({ fresh: 0, missing: 0, stale: 0, target: [] });
  embedSemanticEntryTarget.mockResolvedValue(true);
  jest.clearAllMocks();
  getLocalEmbedderStatus.mockResolvedValue({ ready: true });
  findByProviderAndModelId.mockResolvedValue(MODEL_ROW);
  findById.mockResolvedValue(MODEL_ROW);
  getActiveModel.mockResolvedValue({
    providerId: MODEL_ROW.providerId,
    modelId: MODEL_ROW.modelId,
    dimensions: MODEL_ROW.dimensions,
  });
  listEmbeddingTargets.mockResolvedValue([]);
  classifyEmbeddingTargets.mockResolvedValue([]);
  probeEmbeddingModel.mockResolvedValue(null);
  resolveEmbeddingProviderForModel.mockResolvedValue({
    info: { provider: 'local-onnx', model: 'nomic-embed-text-v1.5', dimensions: 768 },
  });
  embedNode.mockResolvedValue({ ok: true });
  embedFileContent.mockResolvedValue({ ok: true });
  countFileEmbeddingRows.mockResolvedValue(0);
  dbQuery.mockImplementation(async (sql: unknown) => ({
    rows: String(sql).includes('AS bytes') ? [{ bytes: '0' }] : [{ count: '0' }],
  }));
});

describe('ensureStartupEmbeddingBackfill', () => {
  it('does no readiness or database work without explicit local-intelligence opt-in', async () => {
    await ensureStartupEmbeddingBackfill({});

    expect(getLocalEmbedderStatus).not.toHaveBeenCalled();
    expect(findByProviderAndModelId).not.toHaveBeenCalled();
    expect(listEmbeddingTargets).not.toHaveBeenCalled();
    expect(embedNode).not.toHaveBeenCalled();
  });

  it('starts a backfill job when nodes are missing embeddings', async () => {
    const targets = [
      { nodeId: 'doc-1', nodeType: 'doc', content: 'a', estimatedTokens: 1 },
      { nodeId: 'memory-1', nodeType: 'memory', content: 'b', estimatedTokens: 1 },
    ];
    listEmbeddingTargets.mockResolvedValue(targets);
    classifyEmbeddingTargets.mockImplementation(async (input: unknown[]) =>
      (input as typeof targets).map((target) => ({ ...target, state: 'missing' }))
    );

    await ensureStartupEmbeddingBackfill({ SNAGLET_LOCAL_INTELLIGENCE: 'true' });
    await waitForJobToFinish();

    const status = getMaintenanceStatus();
    expect(status.operation).toBe('backfill');
    expect(status.succeeded).toBe(2);
    // Every node went through embedNode — the content_hash-aware writer that
    // makes a restarted backfill skip rows it already wrote.
    expect(embedNode).toHaveBeenCalledTimes(2);
    expect(embedNode).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: 'doc-1', providerOverride: expect.anything() })
    );
  });

  it('no-ops when the corpus is fully embedded', async () => {
    listEmbeddingTargets.mockResolvedValue([
      { nodeId: 'doc-1', nodeType: 'doc', content: 'a', estimatedTokens: 1 },
    ]);
    classifyEmbeddingTargets.mockImplementation(async (input: unknown[]) =>
      (input as Array<Record<string, unknown>>).map((target) => ({ ...target, state: 'fresh' }))
    );

    // Maintenance status is module-global, so compare before/after instead of
    // asserting on absolute state (an earlier test may have run a job).
    const before = getMaintenanceStatus();
    await ensureStartupEmbeddingBackfill({ SNAGLET_LOCAL_INTELLIGENCE: 'true' });

    expect(embedNode).not.toHaveBeenCalled();
    expect(getMaintenanceStatus().startedAt).toBe(before.startedAt);
  });

  it('forwards source versions and counts superseded writes as safe skips', async () => {
    const sourceUpdatedAt = '2026-07-20T00:00:00.000Z';
    const targets = [
      {
        nodeId: 'doc-superseded',
        nodeType: 'doc',
        content: 'old source',
        contentHash: 'old-hash',
        sourceUpdatedAt,
        estimatedTokens: 2,
      },
    ];
    listEmbeddingTargets.mockResolvedValue(targets);
    classifyEmbeddingTargets.mockResolvedValue([{ ...targets[0], state: 'missing' }]);
    embedNode.mockResolvedValue({ ok: false, skipped: 'superseded' });

    await startMaintenanceJob({ operation: 'backfill', modelId: MODEL_ROW.id });
    await waitForJobToFinish();

    expect(embedNode).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: 'doc-superseded',
        expectedNodeUpdatedAt: sourceUpdatedAt,
      })
    );
    expect(getMaintenanceStatus()).toMatchObject({
      succeeded: 0,
      failed: 0,
      skipped: 1,
      processed: 1,
    });
  });

  it('scopes a file backfill to files and records the requested content kind', async () => {
    const target = {
      nodeId: 'file-1',
      nodeType: 'file',
      content: 'file body',
      contentHash: 'file-hash',
      estimatedTokens: 2,
    };
    listEmbeddingTargets.mockResolvedValue([target]);
    classifyEmbeddingTargets.mockResolvedValue([{ ...target, state: 'missing' }]);

    const started = await startMaintenanceJob({
      operation: 'backfill',
      modelId: MODEL_ROW.id,
      nodeType: 'file',
    });
    await waitForJobToFinish();

    expect(started.requestedNodeType).toBe('file');
    expect(listEmbeddingTargets).toHaveBeenCalledWith(['file']);
    expect(embedFileContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contentHash: 'file-hash',
        content: 'file body',
        providerOverride: expect.anything(),
      })
    );
    expect(embedNode).not.toHaveBeenCalled();
  });

  it('rejects an unsupported content-kind scope before resolving a model', async () => {
    await expect(
      startMaintenanceJob({
        operation: 'backfill',
        modelId: MODEL_ROW.id,
        nodeType: 'tool',
      })
    ).rejects.toThrow('Unsupported backfill kind.');

    expect(findById).not.toHaveBeenCalled();
    expect(listEmbeddingTargets).not.toHaveBeenCalled();
  });

  it('reports fresh, missing, and stale coverage for every embeddable content kind', async () => {
    const targets = [
      { nodeId: 'doc-fresh', nodeType: 'doc', content: 'a', estimatedTokens: 1 },
      { nodeId: 'doc-stale', nodeType: 'doc', content: 'b', estimatedTokens: 2 },
      {
        nodeId: 'file-missing',
        nodeType: 'file',
        content: 'c',
        contentHash: 'hash-c',
        estimatedTokens: 3,
      },
    ];
    findByProviderAndModelId.mockResolvedValue({ ...MODEL_ROW, displayName: 'Local embeddings' });
    listEmbeddingTargets.mockResolvedValue(targets);
    classifyEmbeddingTargets.mockResolvedValue([
      { ...targets[0], state: 'fresh' },
      { ...targets[1], state: 'stale' },
      { ...targets[2], state: 'missing' },
    ]);
    countFileEmbeddingRows.mockResolvedValue(2);
    dbQuery.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes('AS bytes') ? [{ bytes: '2048' }] : [{ count: '4' }],
    }));

    const [summary] = await listMaintenanceModels();

    expect(summary).toMatchObject({
      id: MODEL_ROW.id,
      existing: 6,
      fresh: 1,
      stale: 1,
      missing: 1,
      storageBytes: 2048,
      estimatedMissingTokens: 3,
      estimatedStaleTokens: 2,
    });
    expect(summary?.nodeTypeCoverage).toEqual([
      { nodeType: 'container', fresh: 0, missing: 0, stale: 0 },
      { nodeType: 'doc', fresh: 1, missing: 0, stale: 1 },
      { nodeType: 'memory', fresh: 0, missing: 0, stale: 0 },
      { nodeType: 'message', fresh: 0, missing: 0, stale: 0 },
      { nodeType: 'thread_summary', fresh: 0, missing: 0, stale: 0 },
      { nodeType: 'file', fresh: 0, missing: 1, stale: 0 },
      { nodeType: 'image', fresh: 0, missing: 0, stale: 0 },
      { nodeType: 'table_entry', fresh: 0, missing: 0, stale: 0 },
    ]);
  });

  it('lists no model when the built-in row is missing or inactive', async () => {
    findByProviderAndModelId.mockResolvedValueOnce(null);
    expect(await listMaintenanceModels()).toEqual([]);
    findByProviderAndModelId.mockResolvedValueOnce({ ...MODEL_ROW, isActive: false });
    expect(await listMaintenanceModels()).toEqual([]);
    expect(listEmbeddingTargets).not.toHaveBeenCalled();
  });

  it('refuses to run a job against any model but the built-in one', async () => {
    findById.mockResolvedValueOnce({
      ...MODEL_ROW,
      id: 'model-openai-embed',
      providerId: 'openai',
      modelId: 'text-embedding-3-small',
      dimensions: 1536,
    });

    await expect(
      startMaintenanceJob({ operation: 'backfill', modelId: 'model-openai-embed' })
    ).rejects.toThrow(/built-in local model \(local-onnx:nomic-embed-text-v1\.5\)/);

    expect(probeEmbeddingModel).not.toHaveBeenCalled();
    expect(listEmbeddingTargets).not.toHaveBeenCalled();
  });

  it('skips without starting when the local model row is missing from the catalog', async () => {
    findByProviderAndModelId.mockResolvedValue(null);

    await ensureStartupEmbeddingBackfill({ SNAGLET_LOCAL_INTELLIGENCE: 'true' });

    expect(listEmbeddingTargets).not.toHaveBeenCalled();
    expect(embedNode).not.toHaveBeenCalled();
  });
});

it('runs startup cleanup with a message-only join and reports the deleted count', async () => {
  dbQuery.mockResolvedValueOnce({ rowCount: 3 });
  expect(await cleanupStartupMessageEmbeddings()).toBe(3);
  expect(dbQuery).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM public.embeddings e USING public.messages m')
  );
});

describe('unified backfill', () => {
  it.each(['missing', 'stale'])(
    'backfills %s node targets while automatic intelligence is paused',
    async (state) => {
      listEmbeddingTargets.mockResolvedValue([
        { nodeId: 'doc-unified', nodeType: 'doc', content: 'body', estimatedTokens: 1 },
      ]);
      classifyEmbeddingTargets.mockResolvedValue([
        { nodeId: 'doc-unified', nodeType: 'doc', content: 'body', estimatedTokens: 1, state },
      ]);
      await startMaintenanceJob({ operation: 'backfill', modelId: MODEL_ROW.id, nodeType: 'doc' });
      await waitForJobToFinish();
      expect(embedNode).toHaveBeenCalled();
      expect(getMaintenanceStatus()).toMatchObject({ processed: 1, succeeded: 1 });
    }
  );
  it('includes table-semantic targets in the same job progress', async () => {
    classifySemanticEntries.mockResolvedValue({
      fresh: 1,
      missing: 1,
      stale: 1,
      target: [{ entryId: 'entry1' }, { entryId: 'entry2' }],
    });
    await startMaintenanceJob({
      operation: 'backfill',
      modelId: MODEL_ROW.id,
      nodeType: 'table_entry',
    });
    await waitForJobToFinish();
    expect(embedNode).not.toHaveBeenCalled();
    expect(embedSemanticEntryTarget).toHaveBeenCalledTimes(2);
    expect(getMaintenanceStatus()).toMatchObject({ total: 2, processed: 2, succeeded: 2 });
  });
});

describe('unified scope boundaries', () => {
  it('mixes missing and stale, excludes fresh, and completes a no-op', async () => {
    listEmbeddingTargets.mockResolvedValue([
      { nodeId: 'a', nodeType: 'doc' },
      { nodeId: 'b', nodeType: 'doc' },
      { nodeId: 'c', nodeType: 'doc' },
    ]);
    classifyEmbeddingTargets.mockResolvedValue([
      { nodeId: 'a', nodeType: 'doc', state: 'missing', content: 'a', estimatedTokens: 1 },
      { nodeId: 'b', nodeType: 'doc', state: 'stale', content: 'b', estimatedTokens: 1 },
      { nodeId: 'c', nodeType: 'doc', state: 'fresh', content: 'c', estimatedTokens: 1 },
    ]);
    await startMaintenanceJob({ operation: 'backfill', modelId: MODEL_ROW.id, nodeType: 'doc' });
    await waitForJobToFinish();
    expect(embedNode).toHaveBeenCalledTimes(2);
    expect(classifySemanticEntries).not.toHaveBeenCalled();
    listEmbeddingTargets.mockResolvedValue([]);
    await startMaintenanceJob({ operation: 'backfill', modelId: MODEL_ROW.id, nodeType: 'doc' });
    await waitForJobToFinish();
    expect(getMaintenanceStatus()).toMatchObject({ total: 0, processed: 0, running: false });
  });
});
