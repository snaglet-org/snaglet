/**
 * prompt_cache_key: OpenAI itself (the openai provider, codex with an API key,
 * and the Codex backend) gets a stable per-agent key; OpenAI-compatible
 * servers (LM Studio, Together, Mistral, DeepSeek, xAI) and Copilot never do,
 * since they may refuse a field they do not know.
 */

// Replace the chat-completions helper: the tests read the request envelope
// chatOpenAI builds, never a real HTTP roundtrip.
jest.mock('@server/services/ProviderChatService/providers/shared/chat-completions', () => ({
  callOpenAICompatibleChatCompletions: jest.fn(async () => ({
    reply: 'ok',
    stopReason: 'end_turn',
    usage: {},
  })),
}));
// Secret resolution reaches the credential store (DB); payload logging is noise.
jest.mock('@server/services/ProviderChatService/shared', () => ({
  pickSecret: jest.fn(async () => 'sk-test'),
  assertSecret: jest.fn(),
  logProviderPayload: jest.fn(),
  parseToolInputJson: jest.fn(() => ({})),
}));
jest.mock('@server/config/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('@snaglet/db/tables/providers', () => ({
  // No providers row: every provider uses its baked-in URL.
  Providers: { findProvider: jest.fn(async () => null) },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import { callOpenAICompatibleChatCompletions } from '@server/services/ProviderChatService/providers/shared/chat-completions';
import { callResponsesEndpoint } from '@server/services/ProviderChatService/providers/shared/responses-api';
import {
  isOfficialOpenAIUrl,
  openAIPromptCacheKey,
} from '@server/services/ProviderChatService/providers/shared/promptCacheKey';
import { chatOpenAI } from '@server/services/ProviderChatService/providers/openai';
import { chatMistral } from '@server/services/ProviderChatService/providers/mistral';
import { chatDeepseek } from '@server/services/ProviderChatService/providers/deepseek';
import { chatXai } from '@server/services/ProviderChatService/providers/xai';
import { chatTogether } from '@server/services/ProviderChatService/providers/together';
import { chatLmStudio } from '@server/services/ProviderChatService/providers/lm-studio';

const callHelper = callOpenAICompatibleChatCompletions as jest.Mock;

function makeAgent(provider: string, id = 'venus'): SnagletAgent {
  return {
    id,
    name: 'Cache Key Agent',
    provider,
    modelId: 'test-model',
    systemPrompt: 'You are a test.',
    credentialId: null,
  } as unknown as SnagletAgent;
}

function lastRequest(): { url: string; bodyExtensions?: Record<string, unknown> } {
  expect(callHelper).toHaveBeenCalledTimes(1);
  return callHelper.mock.calls[0][0];
}

beforeEach(() => callHelper.mockClear());

describe('openAIPromptCacheKey', () => {
  it('is stable per agent, distinct across agents, fixed-length and name-free', () => {
    const key = openAIPromptCacheKey('venus');
    expect(key).toBe(openAIPromptCacheKey('venus'));
    expect(key).not.toBe(openAIPromptCacheKey('clio'));
    expect(key).toMatch(/^snaglet-[0-9a-f]{32}$/);
    expect(key).not.toContain('venus');
  });
});

describe('isOfficialOpenAIUrl', () => {
  it.each([
    ['https://api.openai.com/v1', true],
    ['https://api.openai.com/v1/chat/completions', true],
    ['https://API.OPENAI.COM/v1', true],
    ['http://localhost:1234/v1', false],
    ['https://api.together.xyz/v1', false],
    ['https://api.openai.com.example.net/v1', false],
    ['http://api.openai.com/v1', false],
    ['', false],
  ])('%s -> %s', (url, expected) => {
    expect(isOfficialOpenAIUrl(url)).toBe(expected);
  });
});

describe('chat completions', () => {
  it('sends the per-agent key to OpenAI itself (provider openai)', async () => {
    await chatOpenAI(makeAgent('openai'), []);
    const req = lastRequest();
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.bodyExtensions).toEqual({ prompt_cache_key: openAIPromptCacheKey('venus') });
  });

  it('sends it for codex with an API key (it calls api.openai.com)', async () => {
    await chatOpenAI(makeAgent('codex'), []);
    expect(lastRequest().bodyExtensions).toEqual({
      prompt_cache_key: openAIPromptCacheKey('venus'),
    });
  });

  it.each([
    ['mistral', chatMistral],
    ['together', chatTogether],
    ['deepseek', chatDeepseek],
    ['xai', chatXai],
    ['lm-studio', chatLmStudio],
  ])('never sends it to the compatible endpoint %s', async (provider, chat) => {
    await chat(makeAgent(provider), []);
    const req = lastRequest();
    expect(isOfficialOpenAIUrl(req.url)).toBe(false);
    expect(req.bodyExtensions).toBeUndefined();
  });

  it('never sends it to a base URL override, even for the openai path', async () => {
    await chatOpenAI(makeAgent('openai'), [], undefined, undefined, {
      baseUrl: 'http://localhost:11434/v1',
    });
    expect(lastRequest().bodyExtensions).toBeUndefined();
  });
});

describe('responses endpoint', () => {
  const originalFetch = global.fetch;
  let sent: Record<string, unknown> | undefined;

  beforeEach(() => {
    sent = undefined;
    // A refused request is enough: the body is captured before the response is read.
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: string }) => {
      sent = JSON.parse(init?.body ?? '{}');
      return new Response('{"error":{"message":"stop here"}}', { status: 400 });
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  const call = (promptCacheKey?: string) =>
    callResponsesEndpoint({
      url: 'https://backend.example/responses',
      headers: {},
      agent: makeAgent('codex'),
      messages: [],
      providerLabel: 'test',
      promptCacheKey,
    });

  it('sends prompt_cache_key when the provider passes one (codex)', async () => {
    await expect(call(openAIPromptCacheKey('venus'))).rejects.toThrow(/stop here/);
    expect(sent?.prompt_cache_key).toBe(openAIPromptCacheKey('venus'));
  });

  it('sends no prompt_cache_key when the provider passes none (copilot)', async () => {
    await expect(call()).rejects.toThrow(/stop here/);
    expect(sent).toBeDefined();
    expect(sent).not.toHaveProperty('prompt_cache_key');
  });
});
