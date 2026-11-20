/**
 * An agent saved with no provider and no model (a starter agent) adopts what
 * the user connected on its first run: a tested key first, then an untested
 * one, then a keyless local provider with imported models; never a key that
 * failed. It picks a general-purpose model of that provider and saves it.
 */
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockListSafe = jest.fn();
const mockListProviders = jest.fn();
const mockListAuthTypes = jest.fn();
const mockListModels = jest.fn();

jest.mock('@server/services/AgentService', () => ({
  agentService: { get: mockGet, update: mockUpdate },
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { listSafe: mockListSafe },
}));
jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { listAll: mockListProviders },
}));
jest.mock('@snaglet/db/tables/provider_auth_types', () => ({
  ProviderAuthTypes: { listByProviderIds: mockListAuthTypes },
}));
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { listActiveByProviderId: mockListModels },
}));

import { adoptConnectedModel, suggestConnectedModel } from '@server/services/agentDefaultModel';

function model(providerId: string, modelId: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId,
    modelId,
    displayName: `${modelId} (name)`,
    supportsTools: true,
    type: 'llm',
    ...overrides,
  };
}

const MODELS: Record<string, unknown[]> = {
  hosted: [
    // Most capable by id, but marked deprecated: never the default.
    model('hosted', 'big-opus-1', { metadata: { lifecycle: 'deprecated' } }),
    model('hosted', 'mid-model-20250101'),
    model('hosted', 'mid-model'),
    model('hosted', 'small-nano'),
  ],
  other: [model('other', 'other-model')],
  local: [model('local', 'llama-local')],
  failing: [model('failing', 'failing-model')],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({ id: 'patty', provider: '', modelId: null });
  mockUpdate.mockResolvedValue({});
  mockListProviders.mockResolvedValue(
    ['hosted', 'other', 'local', 'failing'].map((id) => ({ id, type: 'llm', enabled: true }))
  );
  mockListAuthTypes.mockResolvedValue([
    { providerId: 'hosted', type: 'api_key' },
    { providerId: 'other', type: 'api_key' },
    { providerId: 'failing', type: 'api_key' },
    { providerId: 'local', type: 'none' },
  ]);
  mockListModels.mockImplementation(async (providerId: string) => MODELS[providerId] ?? []);
  mockListSafe.mockResolvedValue([]);
});

describe('adoptConnectedModel', () => {
  it('leaves an agent that has a model alone', async () => {
    mockGet.mockResolvedValue({ id: 'nova', provider: 'hosted', modelId: 'mid-model' });
    expect(await adoptConnectedModel('nova')).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('takes a tested key over a newer untested one and never a failed one', async () => {
    mockListSafe.mockResolvedValue([
      { providerId: 'failing', verificationStatus: 'fail', updatedAt: '2026-03-01' },
      { providerId: 'other', verificationStatus: 'untested', updatedAt: '2026-02-01' },
      { providerId: 'hosted', verificationStatus: 'ok', updatedAt: '2026-01-01' },
    ]);
    expect(await adoptConnectedModel('patty')).toEqual({
      provider: 'hosted',
      modelId: 'mid-model',
    });
    expect(mockUpdate).toHaveBeenCalledWith('patty', { provider: 'hosted', modelId: 'mid-model' });
  });

  it('falls back to an untested key, then to a local provider with models', async () => {
    mockListSafe.mockResolvedValue([
      { providerId: 'other', verificationStatus: 'untested', updatedAt: '2026-02-01' },
    ]);
    expect(await adoptConnectedModel('patty')).toEqual({
      provider: 'other',
      modelId: 'other-model',
    });

    mockListSafe.mockResolvedValue([
      { providerId: 'failing', verificationStatus: 'fail', updatedAt: '2026-02-01' },
    ]);
    expect(await adoptConnectedModel('patty')).toEqual({
      provider: 'local',
      modelId: 'llama-local',
    });
  });

  it('reports no model when nothing usable is connected', async () => {
    mockListModels.mockResolvedValue([]);
    expect(await adoptConnectedModel('patty')).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('reports no model instead of throwing when a lookup fails', async () => {
    mockListProviders.mockRejectedValue(new Error('database unavailable'));
    expect(await adoptConnectedModel('patty')).toBeNull();
  });
});

describe('suggestConnectedModel', () => {
  it('names the model an agent with none would adopt, with its display name, and saves nothing', async () => {
    mockListSafe.mockResolvedValue([
      { providerId: 'other', verificationStatus: 'untested', updatedAt: '2026-02-01' },
      { providerId: 'hosted', verificationStatus: 'ok', updatedAt: '2026-01-01' },
    ]);
    expect(await suggestConnectedModel()).toEqual({
      providerId: 'hosted',
      modelId: 'mid-model',
      displayName: 'mid-model (name)',
    });
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('suggests the most capable current Claude model, whatever order the catalog rows come in', async () => {
    // Rows in database order (sort_order, then model_id): older rows first,
    // the newest generation at the bottom, as on a catalog with stale sort numbers.
    mockListModels.mockImplementation(async () =>
      [
        'claude-opus-4-5',
        'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'claude-fable-5',
        'claude-fable-5-1',
        'claude-fable-5-2',
        'claude-haiku-5-5',
        'claude-opus-4-8',
        'claude-opus-5-5',
        'claude-sonnet-5',
        'claude-sonnet-5-5',
      ].map((id) => model('anthropic', id))
    );
    mockListProviders.mockResolvedValue([{ id: 'anthropic', type: 'llm', enabled: true }]);
    mockListAuthTypes.mockResolvedValue([{ providerId: 'anthropic', type: 'api_key' }]);
    mockListSafe.mockResolvedValue([
      { providerId: 'anthropic', verificationStatus: 'ok', updatedAt: '2026-11-19' },
    ]);

    expect(await suggestConnectedModel()).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-fable-5-2',
    });
  });

  describe("a provider's pinned default", () => {
    beforeEach(() => {
      mockListProviders.mockResolvedValue([
        {
          id: 'mistral',
          type: 'llm',
          enabled: true,
          defaultMetadata: { defaultModelId: 'mistral-large-latest' },
        },
      ]);
      mockListAuthTypes.mockResolvedValue([{ providerId: 'mistral', type: 'api_key' }]);
      mockListSafe.mockResolvedValue([
        { providerId: 'mistral', verificationStatus: 'ok', updatedAt: '2026-11-19' },
      ]);
    });

    it('is suggested over a model the provider hosts for another vendor', async () => {
      mockListModels.mockImplementation(async () => [
        model('mistral', 'mistral-large-latest'),
        model('mistral', 'deepseek-v4-1-flash-1017'),
        model('mistral', 'mistral-large-4'),
      ]);
      expect(await suggestConnectedModel()).toMatchObject({ modelId: 'mistral-large-latest' });
    });

    it('is skipped once it is gone or no longer current', async () => {
      mockListModels.mockImplementation(async () => [
        model('mistral', 'mistral-large-latest', { metadata: { lifecycle: 'deprecated' } }),
        model('mistral', 'mistral-large-4'),
        model('mistral', 'mistral-small-2603', { metadata: { lifecycle: 'legacy' } }),
      ]);
      expect(await suggestConnectedModel()).toMatchObject({ modelId: 'mistral-large-4' });

      mockListModels.mockImplementation(async () => [model('mistral', 'mistral-large-4')]);
      expect(await suggestConnectedModel()).toMatchObject({ modelId: 'mistral-large-4' });
    });

    it('is ignored when it cannot call tools, and no tool-less model is ever suggested', async () => {
      mockListModels.mockImplementation(async () => [
        model('mistral', 'mistral-large-latest', { supportsTools: false }),
        model('mistral', 'mistral-large-4'),
      ]);
      expect(await suggestConnectedModel()).toMatchObject({ modelId: 'mistral-large-4' });

      mockListModels.mockImplementation(async () => [
        model('mistral', 'mistral-large-latest', { supportsTools: false }),
        model('mistral', 'mistral-large-4', { supportsTools: false }),
      ]);
      expect(await suggestConnectedModel()).toBeNull();
    });
  });

  it('is null when no connected provider has a usable model', async () => {
    mockListModels.mockResolvedValue([model('hosted', 'embedder', { type: 'embedding' })]);
    expect(await suggestConnectedModel()).toBeNull();
  });
});
