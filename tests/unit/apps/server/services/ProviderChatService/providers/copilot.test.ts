/**
 * Copilot chat auth for "API key" credentials. Both auth types store a GitHub
 * token (gho_* OAuth token or a PAT), and the chat endpoints never accept the
 * GitHub token itself. These tests pin that the API-key path exchanges it via
 * copilot_internal/v2/token first, uses the exchanged token's embedded
 * proxy-ep base URL, and reuses the cached exchange instead of re-exchanging
 * per request.
 */

// Replace the wire-format helpers — we assert on the request envelope
// chatCopilot builds, never on a real chat HTTP roundtrip.
jest.mock('@server/services/ProviderChatService/providers/shared/chat-completions', () => ({
  callOpenAICompatibleChatCompletions: jest.fn(async () => ({
    reply: 'ok',
    stopReason: 'end_turn',
    usage: {},
  })),
}));
jest.mock('@server/services/ProviderChatService/providers/shared/responses-api', () => ({
  callResponsesEndpoint: jest.fn(),
}));

// Stub secret resolution — pickSecret reaches the credential store (DB).
jest.mock('@server/services/ProviderChatService/shared', () => ({
  pickSecret: jest.fn(async () => 'ghp_test_pat'),
  assertSecret: jest.fn((secret: string, provider: string) => {
    if (!secret) throw new Error(`Missing credentials for provider '${provider}'.`);
  }),
}));

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getFullCredentialById: jest.fn(),
    updateSecret: jest.fn(async () => null),
  },
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: jest.fn(async () => null),
    deactivate: jest.fn(),
    setEntitlement: jest.fn(async () => undefined),
    listActiveByProviderId: jest.fn(async () => []),
  },
}));

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findProvider: jest.fn(async () => null) },
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import {
  chatCopilot,
  classifyCopilotRejection,
  buildCopilotPlanSuggestions,
  copilotMaxTokensField,
} from '@server/services/ProviderChatService/providers/copilot';
import type { ModelRow } from '@snaglet/db/tables/models';
import { callOpenAICompatibleChatCompletions } from '@server/services/ProviderChatService/providers/shared/chat-completions';
import { callResponsesEndpoint } from '@server/services/ProviderChatService/providers/shared/responses-api';
import { providerCredentialService } from '@server/services/ProviderCredentialService';
import { Models } from '@snaglet/db/tables/models';

const callHelper = callOpenAICompatibleChatCompletions as jest.Mock;
const responsesHelper = callResponsesEndpoint as jest.Mock;
const getFullCredentialById = providerCredentialService.getFullCredentialById as jest.Mock;

// The subscription token GitHub's exchange endpoint returns. `proxy-ep`
// deliberately differs from the individual fallback so the base-URL
// assertion proves the URL came from the token, not the fallback constant.
const SUBSCRIPTION_TOKEN = 'tid=abc123;proxy-ep=proxy.business.githubcopilot.com;sku=test';
const EXPECTED_BASE_URL = 'https://api.business.githubcopilot.com';

const originalFetch = global.fetch;
const fetchMock = jest.fn(async () => ({
  ok: true,
  json: async () => ({
    token: SUBSCRIPTION_TOKEN,
    // Seconds epoch, one hour out — comfortably past the 5-minute margin.
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }),
}));

function makeAgent(credentialId: string | null): SnagletAgent {
  return {
    id: 'agent-copilot',
    name: 'Copilot Test Agent',
    provider: 'copilot',
    modelId: 'gpt-4o',
    systemPrompt: 'You are a test.',
    credentialId,
  } as unknown as SnagletAgent;
}

describe('chatCopilot API-key path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('exchanges the GitHub token before hitting the chat endpoint', async () => {
    getFullCredentialById.mockResolvedValue({
      id: 'cred-apikey-1',
      authType: 'api_key',
      encryptedSecret: 'ghp_test_pat',
      metadataJson: {},
    });

    await chatCopilot(makeAgent('cred-apikey-1'), []);

    // The exchange hit GitHub's token endpoint with the PAT…
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string> },
    ];
    expect(tokenUrl).toBe('https://api.github.com/copilot_internal/v2/token');
    expect(tokenInit.headers.Authorization).toBe('Bearer ghp_test_pat');

    // …strictly before the chat request went out.
    expect(callHelper).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      callHelper.mock.invocationCallOrder[0]
    );

    // The chat request carries the exchanged subscription token (never the
    // raw PAT) and the base URL embedded in that token.
    const req = callHelper.mock.calls[0][0] as {
      url: string;
      headers: Record<string, string>;
    };
    expect(req.headers.Authorization).toBe(`Bearer ${SUBSCRIPTION_TOKEN}`);
    expect(req.url).toBe(`${EXPECTED_BASE_URL}/chat/completions`);
  });

  it('reuses the cached exchange on subsequent requests for the same credential', async () => {
    getFullCredentialById.mockResolvedValue({
      id: 'cred-apikey-cached',
      authType: 'api_key',
      encryptedSecret: 'ghp_test_pat',
      metadataJson: {},
    });
    const agent = makeAgent('cred-apikey-cached');

    await chatCopilot(agent, []);
    await chatCopilot(agent, []);

    // One exchange, two chat calls — the in-memory token cache absorbed the second.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(callHelper).toHaveBeenCalledTimes(2);
    const secondReq = callHelper.mock.calls[1][0] as { headers: Record<string, string> };
    expect(secondReq.headers.Authorization).toBe(`Bearer ${SUBSCRIPTION_TOKEN}`);
  });

  it('uses a still-valid subscription token from credential metadata without exchanging', async () => {
    getFullCredentialById.mockResolvedValue({
      id: 'cred-apikey-meta',
      authType: 'api_key',
      encryptedSecret: 'ghp_test_pat',
      metadataJson: {
        copilot_token: SUBSCRIPTION_TOKEN,
        copilot_base_url: EXPECTED_BASE_URL,
        copilot_expires_at: Date.now() + 30 * 60 * 1000,
      },
    });

    await chatCopilot(makeAgent('cred-apikey-meta'), []);

    expect(fetchMock).not.toHaveBeenCalled();
    const req = callHelper.mock.calls[0][0] as { url: string; headers: Record<string, string> };
    expect(req.headers.Authorization).toBe(`Bearer ${SUBSCRIPTION_TOKEN}`);
    expect(req.url).toBe(`${EXPECTED_BASE_URL}/chat/completions`);
  });
});

// A cached, non-expired subscription token so these tests never hit the exchange.
function cachedOauthCred(id: string) {
  return {
    id,
    authType: 'oauth',
    encryptedSecret: 'gho_test',
    metadataJson: {
      copilot_token: SUBSCRIPTION_TOKEN,
      copilot_base_url: EXPECTED_BASE_URL,
      copilot_expires_at: Date.now() + 30 * 60 * 1000,
    },
  };
}

describe('copilot surface routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it.each(['gpt-5.4-mini', 'mai-code-1-flash-picker', 'gpt-5.3-codex'])(
    'routes responses-only model %s to the Responses endpoint',
    async (modelId) => {
      getFullCredentialById.mockResolvedValue(cachedOauthCred('c1'));
      const agent = makeAgent('c1');
      (agent as { modelId: string }).modelId = modelId;
      await chatCopilot(agent, []);
      expect(responsesHelper).toHaveBeenCalledTimes(1);
      expect(callHelper).not.toHaveBeenCalled();
    }
  );

  it('routes a plain chat model (gpt-4o) to chat-completions', async () => {
    getFullCredentialById.mockResolvedValue(cachedOauthCred('c2'));
    await chatCopilot(makeAgent('c2'), []);
    expect(callHelper).toHaveBeenCalledTimes(1);
    expect(responsesHelper).not.toHaveBeenCalled();
  });
});

describe('copilot param compat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('maps the token cap field per model family', () => {
    expect(copilotMaxTokensField('gpt-5.4')).toBe('max_completion_tokens');
    expect(copilotMaxTokensField('gpt-5.5')).toBe('max_completion_tokens');
    expect(copilotMaxTokensField('o3')).toBe('max_completion_tokens');
    expect(copilotMaxTokensField('gpt-4o')).toBe('max_tokens');
    expect(copilotMaxTokensField('gpt-4.1')).toBe('max_tokens');
  });

  it('passes max_completion_tokens + strictToolSchemas for gpt-5.4 chat-completions', async () => {
    getFullCredentialById.mockResolvedValue(cachedOauthCred('c3'));
    const agent = makeAgent('c3');
    (agent as { modelId: string }).modelId = 'gpt-5.4';
    await chatCopilot(agent, []);
    const req = callHelper.mock.calls[0][0] as {
      maxTokensField: string;
      strictToolSchemas: boolean;
      toolNameGrammar: { pattern: RegExp };
    };
    expect(req.maxTokensField).toBe('max_completion_tokens');
    expect(req.strictToolSchemas).toBe(true);
    // no-dots grammar so a dotted/MCP tool name can't 400 the request
    expect(req.toolNameGrammar.pattern.source).toBe('^[a-zA-Z0-9_-]+$');
  });
});

function modelRow(modelId: string, entitlementStatus?: string): ModelRow {
  return {
    id: `row-${modelId}`,
    providerId: 'copilot',
    modelId,
    displayName: modelId,
    description: '',
    family: null,
    contextWindowTokens: null,
    maxOutputTokens: null,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    isActive: true,
    sortOrder: 999,
    type: 'llm',
    dimensions: null,
    metadata: entitlementStatus
      ? { entitlement: { status: entitlementStatus as 'plan_blocked' } }
      : {},
    createdAt: '',
    updatedAt: '',
  };
}

describe('copilot rejection classification', () => {
  it('classifies the three known rejection classes and ignores others', () => {
    expect(
      classifyCopilotRejection('requested model is not available for integrator "vscode-chat"')
    ).toBe('integrator');
    expect(
      classifyCopilotRejection('model "x" is not accessible via the /chat/completions endpoint')
    ).toBe('endpoint');
    expect(classifyCopilotRejection('The requested model is not supported.')).toBe('plan');
    expect(classifyCopilotRejection('some unrelated 500 error')).toBeNull();
  });
});

describe('buildCopilotPlanSuggestions', () => {
  it('drops the rejected id and any plan_blocked/blocked rows, capping the list', () => {
    const rows = [
      modelRow('gpt-5.5'), // the one being rejected — excluded
      modelRow('claude-sonnet-4-5'), // available, kept (vendor-agnostic)
      modelRow('gpt-4.1'),
      modelRow('o3-mini', 'plan_blocked'), // excluded
      modelRow('gpt-4o'),
      modelRow('gpt-4o-mini'),
      modelRow('gpt-3.5'),
    ];
    const suggestions = buildCopilotPlanSuggestions(rows, 'gpt-5.5');
    expect(suggestions).not.toContain('gpt-5.5');
    expect(suggestions).not.toContain('o3-mini');
    expect(suggestions).toContain('claude-sonnet-4-5');
    expect(suggestions.length).toBeLessThanOrEqual(5);
  });
});

describe('copilot plan-blocked marking (no deactivation)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('marks a plan-rejected model plan_blocked (active), never deactivates, and suggests available models', async () => {
    (Models.findByProviderAndModelId as jest.Mock).mockResolvedValue({ id: 'model-row-5.5' });
    (Models.listActiveByProviderId as jest.Mock).mockResolvedValue([
      modelRow('gpt-4.1'),
      modelRow('claude-sonnet-4-5'),
    ]);
    getFullCredentialById.mockResolvedValue(cachedOauthCred('c4'));

    // Drive the errorTransform the way a real 400 does.
    callHelper.mockImplementationOnce(
      async (req: {
        errorTransform: (m: string, b: Record<string, unknown>) => Promise<string>;
      }) => {
        const message = await req.errorTransform(
          'Copilot request failed (400): The requested model is not supported.',
          { model: 'gpt-5.5' }
        );
        throw new Error(message);
      }
    );

    const agent = makeAgent('c4');
    (agent as { modelId: string }).modelId = 'gpt-5.5';

    // The turn still fails, with a clear plan message and dynamic suggestions
    // drawn from this account's rows (Claude included — entitlement is per-model).
    const err = await chatCopilot(agent, []).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/isn't included in your Copilot plan/i);
    expect(err?.message).toMatch(/gpt-4\.1/);
    expect(err?.message).toMatch(/claude-sonnet-4-5/);

    // The row was marked plan_blocked + kept active, and never deactivated.
    expect(Models.findByProviderAndModelId).toHaveBeenCalledWith('copilot', 'gpt-5.5');
    expect(Models.setEntitlement).toHaveBeenCalledWith(
      'model-row-5.5',
      expect.objectContaining({ status: 'plan_blocked', source: 'chat' }),
      true
    );
    expect(Models.deactivate).not.toHaveBeenCalled();
  });
});
