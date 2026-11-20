/**
 * xAI (Grok) request-builder smoke — drives the real openaiCompatible chat path
 * (no chat-completions mock) with a stubbed global fetch, and asserts xAI builds
 * a correct OpenAI-compatible request: the right base URL, a bearer auth header
 * from the resolved secret, and sanitized tool names on the wire (the poison
 * arrow never escapes). This is the end-to-end guard short of a live API key.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isValidToolName } from '@server/services/ToolService/lib/toolName';

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

const getSecret = jest.fn<(providerId: string) => Promise<string | null>>();
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    getSecret: (...args: [string]) => getSecret(...args),
    getSecretById: async () => null,
  },
}));

// No providers row → the factory falls back to its baked-in base URL.
jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findProvider: jest.fn(async () => null) },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import { chatXai } from '@server/services/ProviderChatService/providers/xai';

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

// A replayed assistant turn carrying the poison `action→…` (U+2192) name.
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

const agent = {
  id: 'agent-1',
  name: 'Smoke Agent',
  provider: 'xai',
  modelId: 'grok-4',
  systemPrompt: 'You are a test.',
  credentialId: null,
} as unknown as SnagletAgent;

beforeEach(() => {
  jest.clearAllMocks();
  getSecret.mockResolvedValue('xai-secret');
  fetchMock.mockResolvedValue(okStream());
});

describe('xAI request builder (through openaiCompatible)', () => {
  it('posts to api.x.ai/v1/chat/completions with a bearer header', async () => {
    await chatXai(agent, messages, undefined, { tools });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('https://api.x.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xai-secret');
    expect(getSecret).toHaveBeenCalledWith('xai');
  });

  it('sanitizes tool names on the wire — the arrow never escapes', async () => {
    await chatXai(agent, messages, undefined, { tools });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;

    const advertised = body.tools as Array<{ function: { name: string } }>;
    expect(advertised).toHaveLength(1);
    expect(isValidToolName(advertised[0].function.name)).toBe(true);

    const msgs = body.messages as Array<Record<string, unknown>>;
    const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)) as {
      tool_calls: Array<{ id: string; function: { name: string } }>;
    };
    expect(isValidToolName(assistant.tool_calls[0].function.name)).toBe(true);
    expect(assistant.tool_calls[0].function.name).toBe('action_database_query');

    expect(String(init.body)).not.toContain('→');
    expect(body.model).toBe('grok-4');
  });
});
