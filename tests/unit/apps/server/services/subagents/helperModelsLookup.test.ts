/**
 * helperModels lookup — what `subagent` op "models" returns: the models a
 * helper can run on for the caller's own provider, deduplicated by display
 * name, with context/reasoning/vision tags and the caller's own model marked.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ModelRow } from '@snaglet/db/tables/models';

const mockListActive = jest.fn<(providerId: string) => Promise<ModelRow[]>>();
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { listActiveByProviderId: (id: string) => mockListActive(id) },
}));
const mockEffective =
  jest.fn<(t: string, a: string) => Promise<{ providerId: string; modelId: string } | null>>();
jest.mock('@snaglet/db/tables/threads', () => ({
  Threads: { getEffectiveModel: (t: string, a: string) => mockEffective(t, a) },
}));
const mockAgent =
  jest.fn<(id: string) => Promise<{ providerId: string | null; modelId: string | null } | null>>();
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (id: string) => mockAgent(id) },
}));

import {
  describeHelperModels,
  describeModelsDetailed,
} from '@server/services/subagents/helperModels';

function model(over: Partial<ModelRow> & { modelId: string }): ModelRow {
  return {
    id: `test-provider:${over.modelId}`,
    providerId: 'test-provider',
    displayName: over.modelId,
    description: '',
    family: null,
    contextWindowTokens: null,
    maxOutputTokens: null,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    isActive: true,
    sortOrder: 0,
    type: 'llm',
    dimensions: null,
    metadata: {} as ModelRow['metadata'],
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...over,
  };
}

describe('describeModelsDetailed', () => {
  it('tags context, reasoning, vision and marks the caller’s own model', () => {
    const text = describeModelsDetailed(
      [
        model({ modelId: 'test-fast', contextWindowTokens: 200_000 }),
        model({
          modelId: 'test-strong',
          contextWindowTokens: 1_000_000,
          supportsReasoning: true,
          supportsVision: true,
        }),
      ],
      'test-strong'
    );
    expect(text).toContain('- test-fast · 200k context');
    expect(text).toContain('- test-strong · 1M context · reasoning · vision · your model');
  });

  it('lists a dated snapshot that shares its alias’s display name once', () => {
    const text = describeModelsDetailed(
      [
        model({ modelId: 'test-small', displayName: 'Test Small' }),
        model({ modelId: 'test-small-20251001', displayName: 'Test Small' }),
      ],
      null
    );
    expect(text.match(/^- /gm)).toHaveLength(1);
    expect(text).toContain('- test-small');
    expect(text).not.toContain('20251001');
  });

  it('says dated snapshot ids are accepted too', () => {
    expect(describeModelsDetailed([model({ modelId: 'test-small' })], null)).toContain(
      'dated snapshot'
    );
  });
});

describe('describeHelperModels', () => {
  beforeEach(() => {
    mockListActive
      .mockReset()
      .mockResolvedValue([
        model({ modelId: 'test-fast' }),
        model({ modelId: 'test-embed', type: 'embedding' }),
        model({ modelId: 'test-notools', supportsTools: false }),
      ]);
    mockEffective
      .mockReset()
      .mockResolvedValue({ providerId: 'test-provider', modelId: 'test-fast' });
    mockAgent.mockReset().mockResolvedValue({ providerId: 'test-provider', modelId: 'test-fast' });
  });

  it('lists only tool-capable chat models of the caller’s provider and marks the caller’s own', async () => {
    const text = await describeHelperModels('thread-1', 'test-agent-a');
    expect(mockListActive).toHaveBeenCalledWith('test-provider');
    expect(text).toContain('test-provider');
    expect(text).toContain('- test-fast · your model');
    expect(text).not.toContain('test-embed');
    expect(text).not.toContain('test-notools');
  });

  it('uses the agent’s own provider when it has no thread override', async () => {
    mockEffective.mockResolvedValue(null);
    mockAgent.mockResolvedValue({ providerId: 'test-provider-2', modelId: null });
    await describeHelperModels('thread-1', 'test-agent-a');
    expect(mockListActive).toHaveBeenCalledWith('test-provider-2');
  });

  it('says so plainly when there is no provider', async () => {
    mockEffective.mockResolvedValue(null);
    mockAgent.mockResolvedValue({ providerId: null, modelId: null });
    expect(await describeHelperModels('thread-1', 'test-agent-a')).toContain(
      'No tool-capable model is active on your provider'
    );
    expect(mockListActive).not.toHaveBeenCalled();
  });

  it('says so plainly when the provider has no tool-capable model', async () => {
    mockListActive.mockResolvedValue([]);
    expect(await describeHelperModels('thread-1', 'test-agent-a')).toContain(
      'No tool-capable model is active on your provider'
    );
  });
});
