// Unit tests for the get_provider_models tool.
const mockDiscoverModels = jest.fn();

jest.mock('@server/services/ProviderModelDiscoveryService', () => ({
  discoverModels: mockDiscoverModels,
}));

import getProviderModels from '@server/services/ToolService/handlers/agents/getProviderModels';

describe('get_provider_models tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires a provider_id', async () => {
    const result = (await getProviderModels({}, {}, undefined as never)) as { output: string };
    expect(result.output).toContain('`provider_id` is required');
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('lists the chat catalog; an old model_kind:"chat" still works', async () => {
    mockDiscoverModels.mockResolvedValue({ models: [] });

    await getProviderModels({ provider_id: 'anthropic' }, {}, undefined as never);
    await getProviderModels(
      { provider_id: 'anthropic', model_kind: 'chat' },
      {},
      undefined as never
    );

    expect(mockDiscoverModels).toHaveBeenCalledTimes(2);
    expect(mockDiscoverModels).toHaveBeenNthCalledWith(1, 'anthropic');
    expect(mockDiscoverModels).toHaveBeenNthCalledWith(2, 'anthropic');
  });

  it('refuses model_kind:"embedding" with a clear message and no discovery call', async () => {
    const result = (await getProviderModels(
      { provider_id: 'openai', model_kind: 'embedding' },
      {},
      undefined as never
    )) as { output: string };

    expect(result.output).toMatch(/only chat models/);
    expect(result.output).toMatch(/built-in local model/);
    expect(mockDiscoverModels).not.toHaveBeenCalled();
  });

  it('renders discovered models with capabilities', async () => {
    mockDiscoverModels.mockResolvedValue({
      models: [
        {
          modelId: 'claude-sonnet-4-5',
          displayName: 'Claude Sonnet 4.5',
          supportsTools: true,
          supportsVision: true,
          supportsReasoning: false,
          alreadyImported: true,
        },
      ],
    });

    const result = (await getProviderModels(
      { provider_id: 'anthropic' },
      {},
      undefined as never
    )) as { output: string };

    expect(result.output).toContain('claude-sonnet-4-5');
    expect(result.output).toContain('tools');
    expect(result.output).toContain('vision');
    expect(result.output).toContain('imported');
  });

  it('surfaces a warning when no models are returned', async () => {
    mockDiscoverModels.mockResolvedValue({ models: [], warning: 'provider unreachable' });

    const result = (await getProviderModels({ provider_id: 'ollama' }, {}, undefined as never)) as {
      output: string;
    };

    expect(result.output).toContain('No chat models');
    expect(result.output).toContain('provider unreachable');
  });
});
