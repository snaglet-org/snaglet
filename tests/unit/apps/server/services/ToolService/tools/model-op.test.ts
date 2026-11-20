// Unit tests for the add_model tool.
const mockFindProvider = jest.fn();
const mockFindExisting = jest.fn();
const mockCreateModel = jest.fn();

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findProvider: mockFindProvider },
}));
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: mockFindExisting, createModel: mockCreateModel },
}));
const mockEmitModelsChanged = jest.fn();
jest.mock('@server/realtime/surfaces/models', () => ({
  emitModelsChanged: (...args: unknown[]) => mockEmitModelsChanged(...args),
}));

import addModel, {
  parseModelMetadata,
} from '@server/services/ToolService/handlers/agents/addModel';

type Result = { output: string; rawContent: Record<string, unknown> };
const run = (input: Record<string, unknown>) =>
  addModel(input, {}, undefined as never) as Promise<Result>;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'row-1',
  providerId: 'openai',
  modelId: 'gpt-x',
  displayName: 'GPT X',
  type: 'llm',
  contextWindowTokens: 128000,
  maxOutputTokens: 16000,
  dimensions: null,
  isActive: true,
  metadata: {},
  ...over,
});

describe('add_model tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindProvider.mockResolvedValue({ id: 'openai', type: 'llm' });
    mockFindExisting.mockResolvedValue(null);
    mockCreateModel.mockResolvedValue(row());
  });

  it('requires provider_id and model_id', async () => {
    const r = await run({ provider_id: 'openai' });
    expect(r.output).toContain('required');
    expect(mockCreateModel).not.toHaveBeenCalled();
  });

  it('adds a model with its metadata', async () => {
    const r = await run({
      provider_id: 'openai',
      model_id: 'gpt-x',
      display_name: 'GPT X',
      context_window_tokens: 128000,
      max_output_tokens: 16000,
      metadata: { safetyMarginPct: 10, cacheTtl: '5m', summary: { maxWords: 200 } },
    });
    expect(mockCreateModel).toHaveBeenCalledWith(
      'openai',
      'gpt-x',
      'GPT X',
      { safetyMarginPct: 10, cacheTtl: '5m', summary: { maxWords: 200 } },
      128000,
      16000
    );
    expect(r.output).toMatch(/^Added model "GPT X"/);
    expect(r.rawContent.action).toBe('added');
    // Open model pickers re-read the provider's list.
    expect(mockEmitModelsChanged).toHaveBeenCalledWith('openai');
  });

  it('reports update vs restore for an existing model', async () => {
    mockFindExisting.mockResolvedValueOnce(row({ isActive: true }));
    expect((await run({ provider_id: 'openai', model_id: 'gpt-x' })).output).toMatch(/^Updated/);
    mockFindExisting.mockResolvedValueOnce(row({ isActive: false }));
    expect((await run({ provider_id: 'openai', model_id: 'gpt-x' })).output).toMatch(/^Restored/);
  });

  it('rejects unknown and non-LLM providers', async () => {
    mockFindProvider.mockResolvedValueOnce(null);
    expect((await run({ provider_id: 'nope', model_id: 'm' })).output).toContain('not found');
    mockFindProvider.mockResolvedValueOnce({ id: 'local', type: 'runtime' });
    expect((await run({ provider_id: 'local', model_id: 'm' })).output).toContain(
      'runtime provider'
    );
    expect(mockCreateModel).not.toHaveBeenCalled();
  });

  it('refuses embedding models with a clear message and changes nothing', async () => {
    for (const input of [
      { provider_id: 'openai', model_id: 'e', model_type: 'embedding' },
      { provider_id: 'openai', model_id: 'e', model_type: 'embedding', dimensions: 1536 },
      { provider_id: 'openai', model_id: 'm', dimensions: 768 },
    ]) {
      const r = await run(input);
      expect(r.output).toMatch(/^Embedding models cannot be added/);
      expect(r.output).toContain('built-in local model');
      expect(r.rawContent.error).toBe(r.output);
    }
    expect(mockFindProvider).not.toHaveBeenCalled();
    expect(mockCreateModel).not.toHaveBeenCalled();
  });

  it('refuses model_kind on add and points to op list', async () => {
    const r = await run({
      provider_id: 'openai',
      model_id: 'text-embedding-3-small',
      model_kind: 'embedding',
    });
    expect(r.output).toMatch(/^`model_kind` belongs to op list/);
    expect(r.output).toContain('Nothing was changed');
    expect(mockFindProvider).not.toHaveBeenCalled();
    expect(mockCreateModel).not.toHaveBeenCalled();
  });

  it('still accepts the old model_type:"llm" for chat models', async () => {
    const r = await run({ provider_id: 'openai', model_id: 'gpt-x', model_type: 'llm' });
    expect(r.output).toMatch(/^Added model/);
    expect(mockCreateModel).toHaveBeenCalledWith(
      'openai',
      'gpt-x',
      undefined,
      {},
      undefined,
      undefined
    );
  });

  it('rejects bad token counts', async () => {
    const r = await run({ provider_id: 'openai', model_id: 'm', context_window_tokens: -5 });
    expect(r.output).toContain('positive integer');
    expect(mockCreateModel).not.toHaveBeenCalled();
  });
});

describe('parseModelMetadata', () => {
  it('rejects keys agents must not set', () => {
    expect(parseModelMetadata({ deactivatedBy: 'user' })).toContain('Unsupported');
    expect(parseModelMetadata({ entitlement: {} })).toContain('Unsupported');
  });
  it('validates ranges', () => {
    expect(parseModelMetadata({ safetyMarginPct: 95 })).toContain('0–90');
    expect(parseModelMetadata({ cacheTtl: '2h' })).toContain('cacheTtl');
    expect(parseModelMetadata({ contextCompression: { tokenBudgetRatio: 1.5 } })).toContain(
      'tokenBudgetRatio'
    );
    expect(parseModelMetadata({ summary: { maxWords: 0 } })).toContain('maxWords');
  });
  it('takes summary.tokenThreshold and does not accept the retired messageThreshold', () => {
    expect(parseModelMetadata({ summary: { tokenThreshold: 12000 } })).toEqual({
      summary: { tokenThreshold: 12000 },
    });
    expect(parseModelMetadata({ summary: { tokenThreshold: 0 } })).toContain('tokenThreshold');
    expect(parseModelMetadata({ summary: { tokenThreshold: 1.5 } })).toContain('tokenThreshold');
    const retired = parseModelMetadata({ summary: { messageThreshold: 10 } });
    expect(retired).toContain('Unsupported summary key');
    expect(retired).toContain('messageThreshold');
  });
  it('passes valid nested metadata through', () => {
    expect(
      parseModelMetadata({ contextCompression: { tokenBudgetRatio: 0.8, tailMessages: 6 } })
    ).toEqual({ contextCompression: { tokenBudgetRatio: 0.8, tailMessages: 6 } });
  });
});
