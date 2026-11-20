import type { SnagletAgent } from '@server/services/AgentService';
import type { ToolRow } from '@snaglet/db/tables/tools';
import {
  isValidToolName,
  NO_DOTS_TOOL_NAME_GRAMMAR,
} from '@server/services/ToolService/lib/toolName';
import {
  buildOpenAICompatibleChatCompletionBody,
  collectOpenAICompatibleChatCompletionSSE,
} from '@server/services/ProviderChatService/providers/shared/chat-completions';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';

const agent = {
  systemPrompt: 'You are a test agent.',
  modelId: 'gpt-4o',
} as unknown as SnagletAgent;

// One MCP-style id with a colon, one agent-derived id with spaces, one clean
// gateway id. The colon and spaces both violate the OpenAI function-name grammar.
const tools = [
  {
    id: 'mcp__notion__search:pages',
    name: 'Notion Search',
    description: 'search notion',
    parametersSchema: { type: 'object' },
  },
  {
    id: 'Send Message To My Agent',
    name: 'Send Message',
    description: 'delegate to a named agent',
    parametersSchema: { type: 'object' },
  },
  {
    id: 'action',
    name: 'Action Gateway',
    description: 'gateway',
    parametersSchema: { type: 'object' },
  },
] as unknown as ToolRow[];

// A replayed assistant turn whose tool_use names are the persisted historical
// values — including the poison `action→…` (U+2192) from the action gateway log
// and the raw MCP/agent ids — followed by their tool_results (correlated by id).
const messages: ProviderMessage[] = [
  { role: 'user', content: 'hello' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'working' },
      { type: 'tool_use', id: 'call_1', name: 'mcp__notion__search:pages', input: { q: 'x' } },
      { type: 'tool_use', id: 'call_2', name: 'Send Message To My Agent', input: {} },
      {
        type: 'tool_use',
        id: 'call_3',
        name: 'action→database_query',
        input: { tool: 'database_query' },
      },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'ok1' },
      { type: 'tool_result', tool_use_id: 'call_2', content: 'ok2' },
      { type: 'tool_result', tool_use_id: 'call_3', content: 'ok3' },
    ],
  },
];

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

describe('buildOpenAICompatibleChatCompletionBody — function-name grammar', () => {
  it('emits only legal advertised tool names', () => {
    const { body } = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages,
      options: { tools },
    });
    const advertised = body.tools as Array<{ function: { name: string } }>;
    expect(advertised).toHaveLength(3);
    for (const tool of advertised) {
      expect(isValidToolName(tool.function.name)).toBe(true);
    }
  });

  it('sanitizes every replayed tool_use name — the poison arrow never reaches the wire', () => {
    const { body } = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages,
      options: { tools },
    });
    const msgs = body.messages as Array<Record<string, unknown>>;
    const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)) as {
      tool_calls: Array<{ id: string; function: { name: string } }>;
    };

    for (const call of assistant.tool_calls) {
      expect(isValidToolName(call.function.name)).toBe(true);
    }
    const poisoned = assistant.tool_calls.find((c) => c.id === 'call_3');
    expect(poisoned?.function.name).toBe('action_database_query');

    // The whole serialized request is free of the illegal characters.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('→');
    expect(serialized).not.toContain('search:pages');
    expect(serialized).not.toContain('Send Message To My Agent');
  });

  it('preserves tool_result correlation by tool_call_id (not by name)', () => {
    const { body } = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages,
      options: { tools },
    });
    const msgs = body.messages as Array<Record<string, unknown>>;
    const toolMessages = msgs.filter((m) => m.role === 'tool') as Array<{ tool_call_id: string }>;
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(['call_1', 'call_2', 'call_3']);
  });

  it('replayed history and advertised defs share one wire name per tool', () => {
    const { body, sanitizer } = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages,
      options: { tools },
    });
    const msgs = body.messages as Array<Record<string, unknown>>;
    const assistant = msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)) as {
      tool_calls: Array<{ id: string; function: { name: string } }>;
    };

    const mcpWire = sanitizer.sanitize('mcp__notion__search:pages');
    const call1 = assistant.tool_calls.find((c) => c.id === 'call_1');
    expect(call1?.function.name).toBe(mcpWire);

    const advertised = body.tools as Array<{ function: { name: string } }>;
    const mcpDef = advertised.find(
      (t) => sanitizer.resolve(t.function.name) === 'mcp__notion__search:pages'
    );
    expect(mcpDef?.function.name).toBe(mcpWire);
  });

  it('coerces a dotted tool id to a no-dots wire name under the no-dots grammar (Copilot)', () => {
    // Copilot's chat-completions surface 400s on a dotted function name — verified
    // live. The default (dotted) grammar leaves the dot; the no-dots grammar strips it.
    const dotted = [
      {
        id: 'get.time',
        name: 'Get Time',
        description: 'time',
        parametersSchema: { type: 'object' },
      },
    ] as unknown as ToolRow[];

    const dottedDefault = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages: [],
      options: { tools: dotted },
    });
    const nameDefault = (dottedDefault.body.tools as Array<{ function: { name: string } }>)[0]
      .function.name;
    expect(nameDefault).toBe('get.time'); // dots kept on the default wire

    const noDots = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages: [],
      options: { tools: dotted },
      toolNameGrammar: NO_DOTS_TOOL_NAME_GRAMMAR,
    });
    const nameNoDots = (noDots.body.tools as Array<{ function: { name: string } }>)[0].function
      .name;
    expect(nameNoDots).toBe('get_time');
    expect(isValidToolName(nameNoDots, NO_DOTS_TOOL_NAME_GRAMMAR)).toBe(true);
    expect(noDots.sanitizer.resolve('get_time')).toBe('get.time');
  });

  it('reverse-maps each advertised wire name back to the original id (response direction)', () => {
    const { sanitizer } = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages,
      options: { tools },
    });
    for (const tool of tools) {
      const wire = sanitizer.sanitize(tool.id);
      expect(isValidToolName(wire)).toBe(true);
      expect(sanitizer.resolve(wire)).toBe(tool.id);
    }
  });
});

describe('collectOpenAICompatibleChatCompletionSSE — inbound name resolution', () => {
  it('maps the sanitized name the model echoes back to the real tool id', async () => {
    const { sanitizer } = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages,
      options: { tools },
    });
    const mcpWire = sanitizer.sanitize('mcp__notion__search:pages');

    const stream = sseStream([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'resp_1', function: { name: mcpWire, arguments: '{"q":"y"}' } },
              ],
            },
          },
        ],
      }),
      JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ]);

    const result = await collectOpenAICompatibleChatCompletionSSE(stream, undefined, sanitizer);
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].id).toBe('resp_1');
    expect(result.toolCalls?.[0].name).toBe('mcp__notion__search:pages');
    expect(result.toolCalls?.[0].input).toEqual({ q: 'y' });
  });

  it('is a no-op without a sanitizer (returns the wire name unchanged)', async () => {
    const stream = sseStream([
      JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'resp_2', function: { name: 'file_read', arguments: '{}' } },
              ],
            },
          },
        ],
      }),
      '[DONE]',
    ]);
    const result = await collectOpenAICompatibleChatCompletionSSE(stream);
    expect(result.toolCalls?.[0].name).toBe('file_read');
  });
});

describe('collectOpenAICompatibleChatCompletionSSE — cache-read usage parsing', () => {
  it('parses OpenAI-style prompt_tokens_details.cached_tokens (subset of prompt_tokens)', async () => {
    const stream = sseStream([
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 800 },
        },
      }),
      '[DONE]',
    ]);
    const result = await collectOpenAICompatibleChatCompletionSSE(stream);
    // prompt_tokens is inclusive of cached reads on this wire format —
    // inputTokens must stay 1000 (no roll-up), cacheReadTokens is the subset.
    expect(result.usage?.inputTokens).toBe(1000);
    expect(result.usage?.outputTokens).toBe(20);
    expect(result.usage?.cacheReadTokens).toBe(800);
  });

  it('parses DeepSeek-style prompt_cache_hit_tokens', async () => {
    const stream = sseStream([
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 10,
          prompt_cache_hit_tokens: 320,
          prompt_cache_miss_tokens: 180,
        },
      }),
      '[DONE]',
    ]);
    const result = await collectOpenAICompatibleChatCompletionSSE(stream);
    expect(result.usage?.inputTokens).toBe(500);
    expect(result.usage?.cacheReadTokens).toBe(320);
  });

  it('prefers prompt_tokens_details.cached_tokens when both conventions appear', async () => {
    const stream = sseStream([
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 60 },
          prompt_cache_hit_tokens: 40,
        },
      }),
      '[DONE]',
    ]);
    const result = await collectOpenAICompatibleChatCompletionSSE(stream);
    expect(result.usage?.cacheReadTokens).toBe(60);
  });

  it('leaves cacheReadTokens undefined when the provider reports no cache fields', async () => {
    const stream = sseStream([
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 300, completion_tokens: 12 },
      }),
      '[DONE]',
    ]);
    const result = await collectOpenAICompatibleChatCompletionSSE(stream);
    // "not reported" must stay undefined — never fabricated as zero.
    expect(result.usage?.inputTokens).toBe(300);
    expect(result.usage?.cacheReadTokens).toBeUndefined();
  });

  it('reports cached_tokens: 0 as undefined (cold cache, indistinguishable from unreported)', async () => {
    const stream = sseStream([
      JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 300,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
      '[DONE]',
    ]);
    const result = await collectOpenAICompatibleChatCompletionSSE(stream);
    expect(result.usage?.cacheReadTokens).toBeUndefined();
  });
});

describe('Chat Completions output limit', () => {
  const messages: ProviderMessage[] = [{ role: 'user', content: 'hi' }];

  it('sends the catalog limit when there is one', () => {
    const { body } = buildOpenAICompatibleChatCompletionBody({
      agent,
      messages,
      options: { maxOutputTokens: 64_000 },
    });
    expect(body.max_tokens).toBe(64_000);
  });

  it('leaves the field out when the catalog does not know the limit, so the provider’s own applies', () => {
    const { body } = buildOpenAICompatibleChatCompletionBody({ agent, messages, options: {} });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('reports a reply cut off at the limit as `length`, its truncated tool call not a tool turn', async () => {
    const enc = new TextEncoder();
    const events = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":"pl' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const ev of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        controller.close();
      },
    });

    const result = await collectOpenAICompatibleChatCompletionSSE(stream);

    expect(result.stopReason).toBe('length');
  });
});
