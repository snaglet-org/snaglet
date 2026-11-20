/**
 * Discovery → catalog persistence: brand-new models are imported with their
 * discovered metadata; existing rows are never upserted (no resurrection of
 * user-deactivated models, no overwrites) — only NULL window/output fields
 * are backfilled. Discovery is mocked; no network or DB is touched.
 */

const listByProviderId = jest.fn();
const updateModel = jest.fn(async () => null);
const bulkUpsert = jest.fn(async (_providerId: string, rows: unknown[]) => rows);

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    listByProviderId: (...a: unknown[]) => listByProviderId(...a),
    updateModel: (...a: unknown[]) => updateModel(...a),
    bulkUpsert: (...a: unknown[]) => bulkUpsert(...a),
  },
}));

const discoverModels = jest.fn();

jest.mock('@server/services/ProviderModelDiscoveryService/index', () => ({
  discoverModels: (...a: unknown[]) => discoverModels(...a),
}));

const emitModelsChanged = jest.fn();
jest.mock('@server/realtime/surfaces/models', () => ({
  emitModelsChanged: (...a: unknown[]) => emitModelsChanged(...a),
}));

import { persistDiscoveredModels } from '@server/services/ProviderModelDiscoveryService/persistence';
import type { DiscoveredModel } from '@server/services/ProviderModelDiscoveryService/types';

function discovered(modelId: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return { modelId, displayName: modelId, alreadyImported: false, ...extra };
}

beforeEach(() => {
  jest.clearAllMocks();
  listByProviderId.mockResolvedValue([]);
});

describe('persistDiscoveredModels', () => {
  it('imports brand-new models with their discovered context windows', async () => {
    discoverModels.mockResolvedValue({
      providerId: 'ollama',
      models: [
        discovered('qwen3:4b', { contextWindowTokens: 40960, maxOutputTokens: 8192 }),
        discovered('llama3.2:3b', { contextWindowTokens: 131072 }),
      ],
    });

    const summary = await persistDiscoveredModels('ollama');

    expect(discoverModels).toHaveBeenCalledWith('ollama');
    expect(bulkUpsert).toHaveBeenCalledTimes(1);
    const [providerId, rows] = bulkUpsert.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(providerId).toBe('ollama');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      modelId: 'qwen3:4b',
      contextWindowTokens: 40960,
      maxOutputTokens: 8192,
    });
    expect(summary).toMatchObject({
      providerId: 'ollama',
      discovered: 2,
      imported: 2,
      backfilled: 0,
    });
  });

  it('never upserts over an existing row — user-deactivated models stay deactivated', async () => {
    // bulkUpsert's ON CONFLICT sets is_active=TRUE and clears deactivatedBy,
    // so routing an existing row through it would resurrect a model the user
    // deliberately removed. Existing rows (active or not) must be skipped.
    listByProviderId.mockResolvedValue([
      {
        id: 'row-1',
        modelId: 'qwen3:4b',
        isActive: false,
        contextWindowTokens: 40960,
        maxOutputTokens: 8192,
        metadata: { deactivatedBy: 'user' },
      },
    ]);
    discoverModels.mockResolvedValue({
      providerId: 'ollama',
      models: [discovered('qwen3:4b', { contextWindowTokens: 40960, maxOutputTokens: 8192 })],
    });

    const summary = await persistDiscoveredModels('ollama');

    expect(bulkUpsert).not.toHaveBeenCalled();
    expect(updateModel).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ discovered: 1, imported: 0, backfilled: 0 });
  });

  it('backfills only NULL window/output fields on existing rows', async () => {
    listByProviderId.mockResolvedValue([
      {
        id: 'row-1',
        modelId: 'qwen3:4b',
        isActive: true,
        contextWindowTokens: null,
        maxOutputTokens: 4096, // user-edited — must not be touched
        metadata: {},
      },
    ]);
    discoverModels.mockResolvedValue({
      providerId: 'ollama',
      models: [discovered('qwen3:4b', { contextWindowTokens: 40960, maxOutputTokens: 8192 })],
    });

    const summary = await persistDiscoveredModels('ollama');

    expect(bulkUpsert).not.toHaveBeenCalled();
    expect(updateModel).toHaveBeenCalledTimes(1);
    expect(updateModel).toHaveBeenCalledWith('row-1', { contextWindowTokens: 40960 });
    expect(summary).toMatchObject({ discovered: 1, imported: 0, backfilled: 1 });
  });

  it('replaces stored limits with the limits the provider reported', async () => {
    // A row an earlier pass wrote with inferred limits (Claude Fable 5.2 at
    // 200K / 8,192); Anthropic's list now reports 1M / 128K for it.
    listByProviderId.mockResolvedValue([
      {
        id: 'row-fable',
        modelId: 'claude-fable-5-2',
        isActive: true,
        contextWindowTokens: 200_000,
        maxOutputTokens: 8192,
        metadata: {},
      },
    ]);
    discoverModels.mockResolvedValue({
      providerId: 'anthropic',
      models: [
        discovered('claude-fable-5-2', {
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 128_000,
          reportedLimits: { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
        }),
      ],
    });

    const summary = await persistDiscoveredModels('anthropic');

    expect(updateModel).toHaveBeenCalledWith('row-fable', {
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
    expect(summary).toMatchObject({ imported: 0, backfilled: 1 });
    // Open model pickers re-read the list.
    expect(emitModelsChanged).toHaveBeenCalledWith('anthropic');
  });

  it('keeps limits a person set, even when the provider reports others', async () => {
    listByProviderId.mockResolvedValue([
      {
        id: 'row-fable',
        modelId: 'claude-fable-5-2',
        isActive: true,
        contextWindowTokens: 500_000,
        maxOutputTokens: 64_000,
        metadata: { limitsEditedBy: 'user' },
      },
    ]);
    discoverModels.mockResolvedValue({
      providerId: 'anthropic',
      models: [
        discovered('claude-fable-5-2', {
          contextWindowTokens: 1_000_000,
          maxOutputTokens: 128_000,
          reportedLimits: { contextWindowTokens: 1_000_000, maxOutputTokens: 128_000 },
        }),
      ],
    });

    await persistDiscoveredModels('anthropic');

    expect(updateModel).not.toHaveBeenCalled();
  });

  it('leaves a stored limit alone when the provider reported only the other one', async () => {
    listByProviderId.mockResolvedValue([
      {
        id: 'row-1',
        modelId: 'gemini-x',
        isActive: true,
        contextWindowTokens: 1_048_576,
        maxOutputTokens: 4096,
        metadata: {},
      },
    ]);
    discoverModels.mockResolvedValue({
      providerId: 'google',
      models: [
        discovered('gemini-x', {
          contextWindowTokens: 1_048_576,
          maxOutputTokens: 8192,
          reportedLimits: { contextWindowTokens: 1_048_576 },
        }),
      ],
    });

    await persistDiscoveredModels('google');

    expect(updateModel).not.toHaveBeenCalled();
    expect(emitModelsChanged).not.toHaveBeenCalled();
  });

  it('announces imported models', async () => {
    discoverModels.mockResolvedValue({
      providerId: 'anthropic',
      models: [discovered('claude-opus-5-5')],
    });

    await persistDiscoveredModels('anthropic');

    expect(emitModelsChanged).toHaveBeenCalledWith('anthropic');
  });

  it('propagates the discovery warning and writes nothing when discovery is empty', async () => {
    discoverModels.mockResolvedValue({
      providerId: 'ollama',
      models: [],
      warning: 'Ollama is not installed or not running on this machine.',
    });

    const summary = await persistDiscoveredModels('ollama');

    expect(bulkUpsert).not.toHaveBeenCalled();
    expect(updateModel).not.toHaveBeenCalled();
    expect(summary.warning).toContain('Ollama is not installed');
    expect(summary).toMatchObject({ discovered: 0, imported: 0, backfilled: 0 });
  });
});
