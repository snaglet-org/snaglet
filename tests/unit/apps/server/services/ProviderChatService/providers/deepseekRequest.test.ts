/**
 * DeepSeek request-builder smoke — drives the real openaiCompatible chat path
 * (no chat-completions mock) with a stubbed global fetch, and asserts the
 * provider builds a correct OpenAI-compatible request: the right base URL, a
 * bearer auth header from the resolved secret, and sanitized tool names on the
 * wire (the poison-arrow name never escapes). This is the end-to-end guard the
 * expansion half needs, short of a live API key.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isValidToolName } from '@server/services/ToolService/lib/toolName';

// Passthrough tool serializer — keeps the tool id as the function name so the
// sanitizer's seeding (which keys off tool.id) still owns the wire name.
jest.mock('@server/services/ToolService', () => ({
  toOpenAITools: (tools: Array<{ id: string; description?: string; parametersSchema?: unknown }>) =>
    tools.map((t) => ({
      type: 'function',
      function: {
        name: t.id,
        description: t.description ?? '',
        parameters: t.parametersSchema ?? { type: 'object' },
      },
    })),
}));

// pickSecret (in ../shared) resolves the credential via this service.
const getSecret = jest.fn<(providerId: string) => Promise<string | null>>();
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getSecret: (...args: [string]) => getSecret(...args),
    getSecretById: async () => null,
  },
}));

// No providers row → each factory falls back to its baked-in base URL.
jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findProvider: jest.fn(async () => null) },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import { chatDeepseek } from '@server/services/ProviderChatService/providers/deepseek';

const fetchMock = jest.fn();
// @ts-expect-error — override the global for the test.
global.fetch = fetchMock;

function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = events.map((e) => `data: ${e}\n\n`).join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function okStream() {
  return {
    ok: true,
    body: sseStream([
      JSON.stringify({
        choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      '[DONE]',
    ]),
  } as unknown as Response;
}

const tools = [
  {
    id: 'file_read',
    name: 'Read',
    description: 'read a file',
    parametersSchema: { type: 'object' },
  },
];

// A replayed assistant turn carrying the poison `action→…` (U+2192) name that
// 400-ed OpenAI-compatible providers before the sanitizer landed.
const messages: ProviderMessage[] = [
  { role: 'user', content: 'hello' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'working' },
      { type: 'tool_use', id: 'call_1', name: 'action→database_query', input: { tool: 'x' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
];

const cases: Array<{
  id: string;
  chat: typeof chatDeepseek;
  url: string;
}> = [{ id: 'deepseek', chat: chatDeepseek, url: 'https://api.deepseek.com/v1/chat/completions' }];

beforeEach(() => {
  jest.clearAllMocks();
  getSecret.mockResolvedValue('sk-secret');
  fetchMock.mockResolvedValue(okStream());
});

describe('DeepSeek request builder (through openaiCompatible)', () => {
  it.each(cases)('$id posts to the right URL with a bearer header', async ({ id, chat, url }) => {
    const agent = {
      id: 'agent-1',
      name: 'Smoke Agent',
      provider: id,
      modelId: 'test-model',
      systemPrompt: 'You are a test.',
      credentialId: null,
    } as unknown as SnagletAgent;

    await chat(agent, messages, undefined, { tools });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
    expect(getSecret).toHaveBeenCalledWith(id);
  });

  it.each(cases)(
    '$id sanitizes tool names on the wire — the arrow never escapes',
    async ({ id, chat }) => {
      const agent = {
        id: 'agent-1',
        name: 'Smoke Agent',
        provider: id,
        modelId: 'test-model',
        systemPrompt: 'You are a test.',
        credentialId: null,
      } as unknown as SnagletAgent;

      await chat(agent, messages, undefined, { tools });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;

      // Advertised tool defs are legal.
      const advertised = body.tools as Array<{ function: { name: string } }>;
      expect(advertised).toHaveLength(1);
      expect(isValidToolName(advertised[0].function.name)).toBe(true);

      // The replayed tool_use name is sanitized to a legal grammar.
      const msgs = body.messages as Array<Record<string, unknown>>;
      const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)) as {
        tool_calls: Array<{ id: string; function: { name: string } }>;
      };
      expect(isValidToolName(assistant.tool_calls[0].function.name)).toBe(true);
      expect(assistant.tool_calls[0].function.name).toBe('action_database_query');

      // The whole serialized request is free of the illegal U+2192 char.
      expect(String(init.body)).not.toContain('→');
      expect(body.model).toBe('test-model');
    }
  );
});
