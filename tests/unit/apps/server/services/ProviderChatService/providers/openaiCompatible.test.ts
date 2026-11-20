/**
 * Label threading for OpenAI-compatible siblings: each factory-built provider
 * (and lm-studio, which calls chatOpenAI directly) hands its own providerLabel
 * and errorLabel to the shared chat-completions helper, so a Mistral 401 does
 * not surface as "OpenAI request failed". The canonical openai path keeps its
 * own labels.
 */

// Replace the shared wire-format helper — we only assert on the request
// envelope each provider builds, never on a real HTTP roundtrip.
jest.mock('@server/services/ProviderChatService/providers/shared/chat-completions', () => ({
  callOpenAICompatibleChatCompletions: jest.fn(async () => ({
    reply: 'ok',
    stopReason: 'end_turn',
    usage: {},
  })),
}));

// Stub secret resolution — pickSecret reaches the credential store (DB).
jest.mock('@server/services/ProviderChatService/shared', () => ({
  pickSecret: jest.fn(async () => 'sk-test'),
  assertSecret: jest.fn(),
}));

jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: {
    // No providers row → every provider falls back to its baked-in URL.
    findProvider: jest.fn(async () => null),
  },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import { callOpenAICompatibleChatCompletions } from '@server/services/ProviderChatService/providers/shared/chat-completions';
import { chatMistral } from '@server/services/ProviderChatService/providers/mistral';
import { chatDeepseek } from '@server/services/ProviderChatService/providers/deepseek';
import { chatXai } from '@server/services/ProviderChatService/providers/xai';
import { chatTogether } from '@server/services/ProviderChatService/providers/together';
import { chatLmStudio } from '@server/services/ProviderChatService/providers/lm-studio';
import { chatOpenAI } from '@server/services/ProviderChatService/providers/openai';

const callHelper = callOpenAICompatibleChatCompletions as jest.Mock;

const agent = {
  id: 'agent-1',
  name: 'Label Test Agent',
  provider: 'mistral',
  modelId: 'test-model',
  systemPrompt: 'You are a test.',
  credentialId: null,
} as unknown as SnagletAgent;

function lastRequest(): Record<string, unknown> {
  expect(callHelper).toHaveBeenCalledTimes(1);
  return callHelper.mock.calls[0][0] as Record<string, unknown>;
}

describe('OpenAI-compatible provider labels', () => {
  beforeEach(() => {
    callHelper.mockClear();
  });

  const factoryProviders: Array<[string, typeof chatMistral, string]> = [
    ['mistral', chatMistral, 'Mistral'],
    ['together', chatTogether, 'Together'],
    ['deepseek', chatDeepseek, 'Deepseek'],
    ['xai', chatXai, 'Xai'],
  ];

  it.each(factoryProviders)(
    '%s passes its own labels to the chat-completions helper',
    async (id, chat, label) => {
      await chat(agent, []);
      const req = lastRequest();
      expect(req.providerLabel).toBe(id);
      expect(req.errorLabel).toBe(label);
      // Labels must never be OpenAI's.
      expect(req.providerLabel).not.toBe('openai');
      expect(req.errorLabel).not.toBe('OpenAI');
    }
  );

  it('lm-studio passes its own labels to the chat-completions helper', async () => {
    await chatLmStudio(agent, []);
    const req = lastRequest();
    expect(req.providerLabel).toBe('lm-studio');
    expect(req.errorLabel).toBe('LM Studio');
  });

  it('canonical openai keeps its own labels', async () => {
    await chatOpenAI(agent, []);
    const req = lastRequest();
    expect(req.providerLabel).toBe('openai');
    expect(req.errorLabel).toBe('OpenAI');
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
  });
});
