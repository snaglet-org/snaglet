/**
 * The Anthropic request and response around thinking models (Claude Fable
 * 5.2, Opus 5.5, Sonnet 5.5 think on every request):
 *   - `max_tokens` is the output limit the caller passes (the model's catalog
 *     limit), so thinking cannot use up a small default before the answer;
 *   - a reply that stops at `max_tokens` after thinking only comes back as an
 *     empty reply with `stopReason: 'max_tokens'` for the turn loop to handle;
 *   - a tool turn comes back with its blocks in order, thinking signatures
 *     included, and only the newest such turn's thinking is sent back;
 *   - when the API refuses a replayed thinking block, the request is sent
 *     once more without thinking blocks;
 *   - a saved `[1m]` id runs on the base id, with no 1M beta header.
 */

jest.mock('@server/services/ProviderChatService/shared', () => {
  const actual = jest.requireActual('@server/services/ProviderChatService/shared');
  return {
    ...actual,
    pickSecret: jest.fn(async () => 'sk-ant-test-key'),
    logProviderPayload: jest.fn(),
  };
});

jest.mock('@server/services/ToolService', () => ({
  toAnthropicTools: jest.fn(() => []),
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { SnagletAgent } from '@server/services/AgentService';
import { chatAnthropic } from '@server/services/ProviderChatService/providers/anthropic';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';

const agent = (modelId: string) =>
  ({
    id: 'agent-1',
    name: 'Patty',
    provider: 'anthropic',
    modelId,
    systemPrompt: 'be helpful',
  }) as unknown as SnagletAgent;

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A thinking block with `display: "omitted"`: empty text, a streamed signature. */
const thinkingBlock = (index: number, signature: string) => [
  {
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  },
  { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } },
  { type: 'content_block_stop', index },
];

const finish = (stopReason: string, outputTokens: number) => [
  {
    type: 'message_delta',
    delta: { stop_reason: stopReason },
    usage: { output_tokens: outputTokens },
  },
  { type: 'message_stop' },
];

const sentBody = (fetchSpy: jest.SpyInstance, call = 0) =>
  JSON.parse(String((fetchSpy.mock.calls[call]?.[1] as RequestInit).body)) as {
    model: string;
    max_tokens: number;
    messages: Array<{ role: string; content: unknown }>;
  };

const sentHeaders = (fetchSpy: jest.SpyInstance, call = 0) =>
  (fetchSpy.mock.calls[call]?.[1] as RequestInit).headers as Record<string, string>;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('chatAnthropic on a thinking model', () => {
  test('asks for the output limit the caller passes as max_tokens', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(sseResponse([...thinkingBlock(0, 'sig'), ...finish('end_turn', 10)]));

    await chatAnthropic(agent('claude-fable-5-2'), [{ role: 'user', content: 'hi' }], undefined, {
      maxOutputTokens: 128_000,
    });

    expect(sentBody(fetchSpy).max_tokens).toBe(128_000);
  });

  test('returns an empty reply stopped at max_tokens when thinking used the whole budget', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(sseResponse([...thinkingBlock(0, 'sig'), ...finish('max_tokens', 8192)]));

    const result = await chatAnthropic(
      agent('claude-fable-5-2'),
      [{ role: 'user', content: 'search my docs' }],
      undefined,
      { maxOutputTokens: 8192 }
    );

    expect(result.reply).toBe('');
    expect(result.stopReason).toBe('max_tokens');
    expect(result.toolCalls).toBeUndefined();
    // The signed thinking goes back when the loop asks the model to continue.
    expect(result.assistantContent).toEqual([{ type: 'thinking', thinking: '', signature: 'sig' }]);
  });

  test('leaves a thinking block the cut left unsigned, and any tool call, out of the cut-off turn', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        ...thinkingBlock(0, 'sig-done'),
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"q":"pla' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
        ...finish('max_tokens', 128_000),
      ])
    );

    const result = await chatAnthropic(agent('claude-fable-5-2'), [
      { role: 'user', content: 'hi' },
    ]);

    expect(result.stopReason).toBe('max_tokens');
    expect(result.assistantContent).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-done' },
    ]);
  });

  test('asks for the model generation’s cap when the caller passes no limit', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(sseResponse([...finish('end_turn', 1)]));

    await chatAnthropic(agent('claude-fable-5-2'), [{ role: 'user', content: 'hi' }]);

    expect(sentBody(fetchSpy).max_tokens).toBe(128_000);
  });

  test('returns a tool turn with its blocks in order, the thinking signature intact', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        ...thinkingBlock(0, 'sig-abc'),
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Searching.' },
        },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'search' },
        },
        {
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"q":"plan"}' },
        },
        { type: 'content_block_stop', index: 2 },
        ...finish('tool_use', 40),
      ])
    );

    const result = await chatAnthropic(agent('claude-fable-5-2'), [
      { role: 'user', content: 'hi' },
    ]);

    expect(result.assistantContent).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'text', text: 'Searching.' },
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'plan' } },
    ]);
  });

  test('sends back only the newest tool turn’s thinking, unchanged', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        sseResponse([{ type: 'content_block_stop', index: 0 }, ...finish('end_turn', 1)])
      );
    const older = { type: 'thinking' as const, thinking: '', signature: 'sig-old' };
    const newer = { type: 'thinking' as const, thinking: '', signature: 'sig-new' };
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'find the plan' },
      {
        role: 'assistant',
        content: [older, { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'none' }] },
      {
        role: 'assistant',
        content: [newer, { type: 'tool_use', id: 't2', name: 'search', input: { q: 'b' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'found' }] },
    ];

    await chatAnthropic(agent('claude-fable-5-2'), messages);

    const sent = sentBody(fetchSpy).messages;
    expect(sent[1]?.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } },
    ]);
    expect(sent[3]?.content).toEqual([
      newer,
      { type: 'tool_use', id: 't2', name: 'search', input: { q: 'b' } },
    ]);
  });

  test('resends without thinking blocks when the API refuses a replayed one', async () => {
    const refusal = new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } }
    );
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(refusal)
      .mockResolvedValueOnce(
        sseResponse([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
          { type: 'content_block_stop', index: 0 },
          ...finish('end_turn', 3),
        ])
      );
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'find the plan' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: 'sig-stale' },
          { type: 'tool_use', id: 't1', name: 'search', input: {} },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    ];

    const result = await chatAnthropic(agent('claude-fable-5-2'), messages);

    expect(result.reply).toBe('Done.');
    // The loop is told, so the run stops replaying thinking.
    expect(result.thinkingDropped).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sentBody(fetchSpy, 1).messages[1]?.content).toEqual([
      { type: 'tool_use', id: 't1', name: 'search', input: {} },
    ]);
  });

  test('runs a saved [1m] id on the base id with no 1M beta header', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(sseResponse([...finish('end_turn', 1)]));

    await chatAnthropic(agent('claude-opus-4-7[1m]'), [{ role: 'user', content: 'hi' }]);

    expect(sentBody(fetchSpy).model).toBe('claude-opus-4-7');
    expect(sentHeaders(fetchSpy)['anthropic-beta']).not.toMatch(/context-1m/);
  });
});
