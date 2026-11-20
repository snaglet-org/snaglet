/**
 * Gemini usage/cache accounting — pins that `usageMetadata` parsing surfaces
 * implicit-cache reads: `cachedContentTokenCount` → usage.cacheReadTokens,
 * `promptTokenCount` stays the inclusive total (no roll-up, unlike anthropic),
 * and a [cache_metrics] line is logged with fresh = prompt − cached.
 */

jest.mock('@server/services/ProviderChatService/shared', () => {
  const actual = jest.requireActual('@server/services/ProviderChatService/shared');
  return {
    ...actual,
    pickSecret: jest.fn(async () => 'gemini-test-key'),
    logProviderPayload: jest.fn(),
  };
});

jest.mock('@server/services/ToolService', () => ({
  toGeminiTools: jest.fn(() => ({ functionDeclarations: [] })),
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import { chatGemini } from '@server/services/ProviderChatService/providers/gemini';
import { logger } from '@server/config/logger';

const agent = {
  id: 'agent-1',
  name: 'Test Agent',
  provider: 'gemini',
  modelId: 'gemini-2.5-pro',
  systemPrompt: 'be helpful',
} as unknown as SnagletAgent;

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const textChunk = (text: string, usage?: Record<string, number>) => ({
  candidates: [{ content: { parts: [{ text }] } }],
  ...(usage ? { usageMetadata: usage } : {}),
});

afterEach(() => {
  jest.restoreAllMocks();
  // The module-mocked logger fns are created once in the factory —
  // restoreAllMocks does not reset their call history between tests.
  (logger.info as jest.Mock).mockClear();
});

describe('chatGemini usage parsing', () => {
  test('surfaces cachedContentTokenCount as cacheReadTokens; prompt stays inclusive', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        textChunk('hello'),
        textChunk(' world', {
          promptTokenCount: 1000,
          candidatesTokenCount: 40,
          cachedContentTokenCount: 800,
        }),
      ])
    );

    const result = await chatGemini(agent, [{ role: 'user', content: 'hi' }]);

    expect(result.reply).toBe('hello world');
    expect(result.usage).toEqual({
      inputTokens: 1000, // inclusive of cached — not rolled up further
      outputTokens: 40,
      cacheReadTokens: 800,
    });
  });

  test('logs [cache_metrics] with fresh = prompt − cached and creation always 0', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        textChunk('x', {
          promptTokenCount: 1000,
          candidatesTokenCount: 40,
          cachedContentTokenCount: 800,
        }),
      ])
    );

    await chatGemini(agent, [{ role: 'user', content: 'hi' }], undefined, {
      threadId: 'thread-test-1',
    });

    const line = (logger.info as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('[cache_metrics]'));
    expect(line).toBeDefined();
    expect(line).toContain('thread_id=thread-test-1');
    expect(line).toContain('input=200'); // 1000 − 800 fresh
    expect(line).toContain('cache_read=800');
    expect(line).toContain('cache_creation=0');
    expect(line).toContain('hit_ratio=0.800');
  });

  test('no usageMetadata at all → usage fields undefined, metrics line still logged', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse([textChunk('ok')]));

    const result = await chatGemini(agent, [{ role: 'user', content: 'hi' }]);

    expect(result.usage).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
    });
    const line = (logger.info as jest.Mock).mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('[cache_metrics]'));
    expect(line).toContain('input=0 cache_read=0');
    expect(line).toContain('hit_ratio=0.000');
  });
});

describe('chatGemini output limit', () => {
  test('reports a MAX_TOKENS finish as max_tokens, a function call in it not a tool turn', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'search', args: {} } }] },
              finishReason: 'MAX_TOKENS',
            },
          ],
        },
      ])
    );

    const result = await chatGemini(agent, [{ role: 'user', content: 'hi' }]);

    expect(result.stopReason).toBe('max_tokens');
  });

  test('leaves maxOutputTokens out of the request when the catalog does not know it', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(sseResponse([textChunk('ok')]));

    await chatGemini(agent, [{ role: 'user', content: 'hi' }]);

    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.generationConfig?.maxOutputTokens).toBeUndefined();
  });
});
