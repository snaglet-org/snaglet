import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';

const findById = jest.fn();
const findByKey = jest.fn();
const updateMemory = jest.fn();
const createMemory = jest.fn();
const createEmbedding = jest.fn();
const generateDocumentEmbedding = jest.fn();

jest.mock('@snaglet/db/tables/memories', () => ({
  Memories: {
    findById: (...args: unknown[]) => findById(...args),
    findByKey: (...args: unknown[]) => findByKey(...args),
    update: (...args: unknown[]) => updateMemory(...args),
    create: (...args: unknown[]) => createMemory(...args),
    findNearDuplicate: jest.fn(),
    hybridSearch: jest.fn(),
    deleteOne: jest.fn(),
    deleteByQuery: jest.fn(),
    listByAgent: jest.fn(),
    getStats: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/embeddings', () => ({
  Embeddings: {
    create: (...args: unknown[]) => createEmbedding(...args),
  },
}));

jest.mock('@snaglet/db/tables/links', () => ({
  Links: { upsert: jest.fn() },
}));

jest.mock('@snaglet/db/tables/thread_summaries', () => ({
  ThreadSummaries: { getByThreadAndAgent: jest.fn() },
}));

jest.mock('@server/services/EmbeddingService.js', () => ({
  generateDocumentEmbedding: (...args: unknown[]) => generateDocumentEmbedding(...args),
  generateQueryEmbedding: jest.fn(),
}));

import { memoryService } from '@server/services/MemoryService';

const previousLocalIntelligence = process.env.SNAGLET_LOCAL_INTELLIGENCE;

/** An agent-owned memory row as the model layer returns it. */
function agentMemory(content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'memory-1',
    agentId: 'agent-1',
    memberId: null,
    key: 'plan',
    content,
    sourceThreadId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('MemoryService.edit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    findById.mockResolvedValue(null);
    findByKey.mockResolvedValue(null);
    updateMemory.mockResolvedValue(undefined);
    createEmbedding.mockResolvedValue(undefined);
    generateDocumentEmbedding.mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
      model: 'text-embedding-test',
      provider: 'openai',
      modelRowId: 'model-row-1',
    });
  });

  afterAll(() => {
    if (previousLocalIntelligence === undefined) delete process.env.SNAGLET_LOCAL_INTELLIGENCE;
    else process.env.SNAGLET_LOCAL_INTELLIGENCE = previousLocalIntelligence;
  });

  describe('target selection', () => {
    it('edits the memory found by id', async () => {
      findById.mockResolvedValue(agentMemory('Ship the thing'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'overwrite', content: 'Ship the other thing' },
      });

      expect(findById).toHaveBeenCalledWith('memory-1');
      expect(findByKey).not.toHaveBeenCalled();
      expect(updateMemory).toHaveBeenCalledWith('memory-1', { content: 'Ship the other thing' });
      expect(result).toEqual({
        status: 'updated',
        id: 'memory-1',
        key: 'plan',
        content: 'Ship the other thing',
      });
    });

    it('edits the memory found by key, resolved inside the caller owner scope', async () => {
      findByKey.mockResolvedValue(agentMemory('Ship the thing'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        key: 'plan',
        edit: { mode: 'overwrite', content: 'Ship it twice' },
      });

      // findByKey is owner-scoped in SQL — the owner ref goes in with the key.
      expect(findByKey).toHaveBeenCalledWith({ agentId: 'agent-1' }, 'plan');
      expect(findById).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'updated', content: 'Ship it twice' });
    });

    it('rejects both selectors at once', async () => {
      await expect(
        memoryService.edit({
          agentId: 'agent-1',
          memoryId: 'memory-1',
          key: 'plan',
          edit: { mode: 'overwrite', content: 'x' },
        })
      ).rejects.toThrow('target must be exactly one of memoryId/key, got both');
      expect(updateMemory).not.toHaveBeenCalled();
    });

    it('rejects neither selector', async () => {
      await expect(
        memoryService.edit({
          agentId: 'agent-1',
          edit: { mode: 'overwrite', content: 'x' },
        })
      ).rejects.toThrow('target (memoryId or key) is required');
      expect(updateMemory).not.toHaveBeenCalled();
    });

    it('keeps the owner exactly-one discipline of the rest of the service', async () => {
      await expect(
        memoryService.edit({
          memoryId: 'memory-1',
          edit: { mode: 'overwrite', content: 'x' },
        })
      ).rejects.toThrow('memoryService.edit: owner (agentId or memberId) is required');
    });
  });

  describe('modes', () => {
    it('overwrite replaces the whole content', async () => {
      findById.mockResolvedValue(agentMemory('old text'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'overwrite', content: 'new text' },
      });

      expect(result).toMatchObject({ status: 'updated', content: 'new text' });
    });

    it('append joins with a newline by default', async () => {
      findById.mockResolvedValue(agentMemory('line one'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'append', content: 'line two' },
      });

      expect(result).toMatchObject({ status: 'updated', content: 'line one\nline two' });
    });

    it('append honors an explicit separator', async () => {
      findById.mockResolvedValue(agentMemory('a'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'append', content: 'b', separator: ', ' },
      });

      expect(result).toMatchObject({ status: 'updated', content: 'a, b' });
    });

    it('append to an empty memory adds no leading separator', async () => {
      findById.mockResolvedValue(agentMemory(''));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'append', content: 'first line' },
      });

      expect(result).toMatchObject({ status: 'updated', content: 'first line' });
    });

    it('replace changes only the first occurrence by default', async () => {
      findById.mockResolvedValue(agentMemory('red car, red bike'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'replace', find: 'red', replaceWith: 'blue' },
      });

      expect(result).toMatchObject({ status: 'updated', content: 'blue car, red bike' });
    });

    it('replace with all: true changes every occurrence', async () => {
      findById.mockResolvedValue(agentMemory('red car, red bike'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'replace', find: 'red', replaceWith: 'blue', all: true },
      });

      expect(result).toMatchObject({ status: 'updated', content: 'blue car, blue bike' });
    });

    it('treats find and replace_with as literal strings, not regex/substitution syntax', async () => {
      findById.mockResolvedValue(agentMemory('cost is $1.50 (a.b) here'));

      const dollars = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        // `$&` is String.replace substitution syntax — it must survive verbatim.
        edit: { mode: 'replace', find: '$1.50', replaceWith: '$& cheaper' },
      });
      expect(dollars).toMatchObject({
        status: 'updated',
        content: 'cost is $& cheaper (a.b) here',
      });

      const dotted = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        // `a.b` as a regex would also match "a-b"; as a literal it matches only itself.
        edit: { mode: 'replace', find: 'a.b', replaceWith: 'ok', all: true },
      });
      expect(dotted).toMatchObject({ status: 'updated', content: 'cost is $1.50 (ok) here' });
    });

    it('rejects a replace with an empty find rather than matching everywhere', async () => {
      findById.mockResolvedValue(agentMemory('anything'));

      await expect(
        memoryService.edit({
          agentId: 'agent-1',
          memoryId: 'memory-1',
          edit: { mode: 'replace', find: '', replaceWith: 'x' },
        })
      ).rejects.toThrow('replace requires a non-empty find string');
      expect(updateMemory).not.toHaveBeenCalled();
    });
  });

  describe('guardrails', () => {
    it('reports find_absent (and writes nothing) when find is not in the content', async () => {
      findById.mockResolvedValue(agentMemory('the quick brown fox'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'replace', find: 'slow', replaceWith: 'fast' },
      });

      expect(result).toEqual({ status: 'find_absent' });
      expect(updateMemory).not.toHaveBeenCalled();
      expect(generateDocumentEmbedding).not.toHaveBeenCalled();
    });

    it('refuses an edit that would blank the memory', async () => {
      findById.mockResolvedValue(agentMemory('all of it'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'replace', find: 'all of it', replaceWith: '  ' },
      });

      expect(result).toEqual({ status: 'would_blank' });
      expect(updateMemory).not.toHaveBeenCalled();
    });

    it('returns not_found for an id that resolves to nothing — and never creates', async () => {
      findById.mockResolvedValue(null);

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-missing',
        edit: { mode: 'overwrite', content: 'new' },
      });

      expect(result).toEqual({ status: 'not_found' });
      expect(updateMemory).not.toHaveBeenCalled();
      expect(createMemory).not.toHaveBeenCalled();
    });

    it('returns not_found for a key that resolves to nothing — and never creates', async () => {
      findByKey.mockResolvedValue(null);

      const result = await memoryService.edit({
        agentId: 'agent-1',
        key: 'never-saved',
        edit: { mode: 'append', content: 'new' },
      });

      expect(result).toEqual({ status: 'not_found' });
      expect(updateMemory).not.toHaveBeenCalled();
      expect(createMemory).not.toHaveBeenCalled();
    });

    it("refuses another agent's memory reached by id, reporting it as not_found", async () => {
      findById.mockResolvedValue(agentMemory('someone else knowledge', { agentId: 'agent-2' }));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'overwrite', content: 'mine now' },
      });

      // Indistinguishable from a miss: no cross-owner write, and no signal
      // that the memory exists at all.
      expect(result).toEqual({ status: 'not_found' });
      expect(updateMemory).not.toHaveBeenCalled();
    });

    it("refuses a member's memory reached by an agent caller", async () => {
      findById.mockResolvedValue(
        agentMemory('user note', { agentId: null, memberId: 'member-42' })
      );

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'overwrite', content: 'mine now' },
      });

      expect(result).toEqual({ status: 'not_found' });
      expect(updateMemory).not.toHaveBeenCalled();
    });

    it('lets a member edit its own memory', async () => {
      findById.mockResolvedValue(
        agentMemory('user note', { agentId: null, memberId: 'member-42' })
      );

      const result = await memoryService.edit({
        memberId: 'member-42',
        memoryId: 'memory-1',
        edit: { mode: 'append', content: 'and more' },
      });

      expect(result).toMatchObject({ status: 'updated', content: 'user note\nand more' });
      expect(updateMemory).toHaveBeenCalledWith('memory-1', { content: 'user note\nand more' });
    });
  });

  describe('embedding refresh', () => {
    it('re-indexes the edited content when automatic local intelligence is on', async () => {
      process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
      findById.mockResolvedValue(agentMemory('line one'));

      await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'append', content: 'line two' },
      });

      expect(generateDocumentEmbedding).toHaveBeenCalledWith('line one\nline two');
      expect(createEmbedding).toHaveBeenCalledWith({
        nodeId: 'memory-1',
        modelId: 'model-row-1',
        vector: [0.1, 0.2, 0.3],
      });
    });

    it('still writes the edit when automatic local intelligence is off', async () => {
      findById.mockResolvedValue(agentMemory('line one'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'append', content: 'line two' },
      });

      expect(result).toMatchObject({ status: 'updated' });
      expect(updateMemory).toHaveBeenCalled();
      expect(generateDocumentEmbedding).not.toHaveBeenCalled();
      expect(createEmbedding).not.toHaveBeenCalled();
    });

    it('keeps the edit when the embedding write fails', async () => {
      process.env.SNAGLET_LOCAL_INTELLIGENCE = 'true';
      findById.mockResolvedValue(agentMemory('line one'));
      createEmbedding.mockRejectedValue(new Error('index offline'));

      const result = await memoryService.edit({
        agentId: 'agent-1',
        memoryId: 'memory-1',
        edit: { mode: 'overwrite', content: 'line two' },
      });

      expect(result).toMatchObject({ status: 'updated', content: 'line two' });
    });
  });
});
