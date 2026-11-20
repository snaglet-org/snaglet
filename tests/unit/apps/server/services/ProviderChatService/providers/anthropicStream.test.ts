/**
 * Anthropic SSE stream parsing — pins the wire-to-result contract of
 * chatAnthropic's streaming loop: text deltas accumulate into `reply` (and
 * stream through onChunk), thinking deltas ride onThinkingChunk, tool_use
 * blocks assemble from partial-JSON deltas, usage rolls up fresh+cache tokens,
 * and pre-content transient stream errors retry while post-content ones don't.
 */

// Stub secret resolution — pickSecret reaches the credential store (DB).
// Everything else in `shared` is pure and used for real.
jest.mock('@server/services/ProviderChatService/shared', () => {
  const actual = jest.requireActual('@server/services/ProviderChatService/shared');
  return {
    ...actual,
    pickSecret: jest.fn(async () => 'sk-ant-test-key'),
    logProviderPayload: jest.fn(),
  };
});

// toAnthropicTools drags in the full ToolService registry — not under test.
jest.mock('@server/services/ToolService', () => ({
  toAnthropicTools: jest.fn(() => []),
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import { chatAnthropic } from '@server/services/ProviderChatService/providers/anthropic';
import { ProviderRetryHandledError } from '@server/services/ProviderChatService/errors';

const agent = {
  id: 'agent-1',
  name: 'Test Agent',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  systemPrompt: 'be helpful',
} as unknown as SnagletAgent;

function sseResponse(
  events: Array<Record<string, unknown>>,
  opts?: { trailer?: string }
): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      }
      if (opts?.trailer) controller.enqueue(enc.encode(opts.trailer));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const messageStart = (usage: Record<string, number>) => ({
  type: 'message_start',
  message: { usage },
});

const textDelta = (text: string) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text },
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('chatAnthropic stream parsing', () => {
  test('accumulates text deltas into reply and streams each through onChunk', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        messageStart({ input_tokens: 10 }),
        { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
        textDelta('Hello'),
        textDelta(', world'),
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 7 },
        },
        { type: 'message_stop' },
      ])
    );

    const chunks: string[] = [];
    const result = await chatAnthropic(agent, [{ role: 'user', content: 'hi' }], (c) =>
      chunks.push(c)
    );

    expect(result.reply).toBe('Hello, world');
    expect(chunks).toEqual(['Hello', ', world']);
    expect(result.stopReason).toBe('end_turn');
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 7 });
  });

  test('assembles a tool call from content_block_start + input_json_delta pieces', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        messageStart({ input_tokens: 5 }),
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'workspace_search' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"query":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"kanban"}' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ])
    );

    const result = await chatAnthropic(agent, [{ role: 'user', content: 'hi' }]);

    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'workspace_search', input: { query: 'kanban' } },
    ]);
    expect(result.reply).toBe('');
    expect(result.stopReason).toBe('tool_use');
  });

  test('routes thinking deltas to onThinkingChunk and thinkingContent, not reply', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        messageStart({ input_tokens: 5 }),
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'hmm ' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'ok' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        textDelta('answer'),
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ])
    );

    const thinking: string[] = [];
    const result = await chatAnthropic(agent, [{ role: 'user', content: 'hi' }], undefined, {
      onThinkingChunk: (t) => thinking.push(t),
    });

    expect(thinking).toEqual(['hmm ', 'ok']);
    expect(result.thinkingContent).toBe('hmm ok');
    expect(result.reply).toBe('answer');
  });

  test('rolls cache read/creation tokens into inputTokens', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        messageStart({
          input_tokens: 100,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
        }),
        textDelta('x'),
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ])
    );

    const result = await chatAnthropic(agent, [{ role: 'user', content: 'hi' }]);

    expect(result.usage).toMatchObject({
      inputTokens: 1050,
      cacheReadTokens: 900,
      cacheCreationTokens: 50,
    });
  });

  test('ignores malformed JSON data lines and keeps parsing later events', async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {not json}\n\n'));
        controller.enqueue(enc.encode(`data: ${JSON.stringify(textDelta('still works'))}\n\n`));
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`
          )
        );
        controller.close();
      },
    });
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));

    const result = await chatAnthropic(agent, [{ role: 'user', content: 'hi' }]);

    expect(result.reply).toBe('still works');
    expect(result.stopReason).toBe('end_turn');
  });

  test('retries a pre-content overloaded_error stream error, then succeeds', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        sseResponse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
      )
      .mockResolvedValueOnce(
        sseResponse([
          messageStart({ input_tokens: 5 }),
          textDelta('recovered'),
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ])
      );

    const result = await chatAnthropic(agent, [{ role: 'user', content: 'hi' }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe('recovered');
  });

  test('does not retry a stream error after content already streamed', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        sseResponse([
          messageStart({ input_tokens: 5 }),
          textDelta('partial'),
          { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
        ])
      );

    await expect(chatAnthropic(agent, [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /overloaded_error/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Post-content the error is a plain Error, not the retry-handled marker…
    // and only one attempt was made.
  });

  test('non-retryable stream error types surface immediately as plain errors', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        sseResponse([
          { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } },
        ])
      );

    const err = await chatAnthropic(agent, [{ role: 'user', content: 'hi' }]).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProviderRetryHandledError);
    expect(String(err.message)).toContain('invalid_request_error');
  });
});
