/**
 * Responses-wire tool plumbing: name sanitization (no-dots grammar) at both
 * outbound sites + inbound resolution, and top-level schema flattening.
 *
 * These guard the codex/copilot Responses path: advertising `name: tool.id` or
 * replaying `name: toolUse.name` raw would 400 on a dotted or `→`-poisoned
 * name, and that backend rejects a top-level `anyOf` (apply_patch) too.
 */

// Keep the server-config-bound imports out; supply a real JSON parser for
// parseToolInputJson so tool inputs still round-trip.
jest.mock('@server/config/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('@server/services/ProviderChatService/shared', () => ({
  logProviderPayload: jest.fn(),
  parseToolInputJson: (raw: string) => {
    try {
      const v = JSON.parse(raw || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  },
}));

import type { ToolRow } from '@snaglet/db/tables/tools';
import {
  toResponsesTools,
  toResponsesInputItems,
  collectResponsesSSE,
  callResponsesEndpoint,
} from '@server/services/ProviderChatService/providers/shared/responses-api';
import { createToolNameSanitizer } from '@server/services/ProviderChatService/providers/shared/toolNameSanitizer';
import {
  isValidToolName,
  NO_DOTS_TOOL_NAME_GRAMMAR,
} from '@server/services/ToolService/lib/toolName';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import type { SnagletAgent } from '@server/services/AgentService';

function makeSanitizer(toolIds: string[]) {
  const s = createToolNameSanitizer(NO_DOTS_TOOL_NAME_GRAMMAR);
  for (const id of toolIds) s.sanitize(id); // seed canonical ids first
  return s;
}

const applyPatchTool = {
  id: 'apply_patch',
  name: 'Apply Patch',
  description: 'patch',
  parametersSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string' },
      input: { type: 'string' },
      workdir: { type: 'string' },
    },
    anyOf: [{ required: ['patch'] }, { required: ['input'] }],
  },
} as unknown as ToolRow;

const dottedTool = {
  id: 'get.time',
  name: 'Get Time',
  description: 'time',
  parametersSchema: { type: 'object', properties: { tz: { type: 'string' } } },
} as unknown as ToolRow;

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

describe('toResponsesTools — advertised names + schema flattening', () => {
  it('sanitizes a dotted id to a legal no-dots wire name', () => {
    const s = makeSanitizer(['get.time']);
    const [tool] = toResponsesTools([dottedTool], s);
    expect(tool.name).toBe('get_time');
    expect(isValidToolName(tool.name, NO_DOTS_TOOL_NAME_GRAMMAR)).toBe(true);
  });

  it('flattens apply_patch top-level anyOf while keeping every property', () => {
    const s = makeSanitizer(['apply_patch']);
    const [tool] = toResponsesTools([applyPatchTool], s);
    expect(tool.parameters).not.toHaveProperty('anyOf');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        patch: { type: 'string' },
        input: { type: 'string' },
        workdir: { type: 'string' },
      },
    });
  });
});

describe('Responses optional tool fields', () => {
  // A tool whose canonical schema carries nested optional arguments (an array
  // of operation objects, each with an optional `changes` map and an `element`
  // whose fields are all optional). Pins that strict-normalization is opted out
  // of without mutating this nested shape.
  const nestedOptionalSchema = {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: { type: 'string' },
      operations: {
        type: 'array',
        items: {
          type: 'object',
          required: ['op'],
          additionalProperties: false,
          properties: {
            op: { type: 'string' },
            changes: { type: 'object', additionalProperties: true },
            element: {
              type: 'object',
              additionalProperties: false,
              properties: {
                src: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
                points: { type: 'array', items: { type: 'number' } },
              },
            },
          },
        },
      },
    },
  } as const;

  const nestedTool = {
    id: 'nested_optional',
    name: 'Nested Optional',
    description: 'nested optional args',
    parametersSchema: nestedOptionalSchema,
  } as unknown as ToolRow;

  it('opts out of implicit strict normalization for nested optional fields', () => {
    const before = JSON.stringify(nestedOptionalSchema);
    const [tool] = toResponsesTools([nestedTool], makeSanitizer([nestedTool.id]));
    expect(tool.strict).toBe(false);
    expect(tool.parameters).toMatchObject({
      required: ['op'],
      properties: {
        operations: {
          items: {
            required: ['op'],
            properties: {
              // Optional nested objects are not forced to require their fields.
              changes: expect.not.objectContaining({ required: expect.anything() }),
              element: expect.not.objectContaining({ required: expect.anything() }),
            },
          },
        },
      },
    });
    // The canonical schema object is not mutated in place.
    expect(JSON.stringify(nestedOptionalSchema)).toBe(before);
  });

  it('sends strict false in the actual HTTP body for nested and ordinary optional-argument tools', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseStream([JSON.stringify({ type: 'response.completed', response: {} })]), {
        status: 200,
      })
    );
    try {
      await callResponsesEndpoint({
        url: 'https://example.invalid/codex/responses',
        headers: {},
        agent: { id: 'test-agent', modelId: 'gpt-5.6-sol', systemPrompt: 'Test' } as SnagletAgent,
        messages: [{ role: 'user', content: 'Update the element' }],
        options: { tools: [nestedTool, dottedTool] },
        providerLabel: 'codex',
      });
      const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body)) as {
        tools: { name: string; strict: boolean; parameters: Record<string, unknown> }[];
      };
      expect(body.tools).toHaveLength(2);
      expect(body.tools.every((tool) => tool.strict === false)).toBe(true);
      expect(body.tools[0].parameters).toMatchObject({ required: ['op'] });
      expect(body.tools[1].parameters).not.toHaveProperty('required');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('toResponsesInputItems — replayed tool_use names', () => {
  it('sanitizes the poison arrow name but correlates by call_id', () => {
    const s = makeSanitizer(['database_query']);
    const message: ProviderMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'working' },
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'action→database_query',
          input: { tool: 'database_query' },
        },
      ],
    };
    const items = toResponsesInputItems(message, s);
    const fnCall = items.find((i) => (i as { type?: string }).type === 'function_call') as {
      call_id: string;
      name: string;
    };
    expect(fnCall.call_id).toBe('call_1'); // correlation preserved
    expect(fnCall.name).toBe('action_database_query'); // arrow + dot-free
    expect(isValidToolName(fnCall.name, NO_DOTS_TOOL_NAME_GRAMMAR)).toBe(true);

    // The following tool_result maps to a function_call_output keyed by call_id.
    const resultMessage: ProviderMessage = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }],
    };
    const outputs = toResponsesInputItems(resultMessage, s);
    const out = outputs.find((i) => (i as { type?: string }).type === 'function_call_output') as {
      call_id: string;
    };
    expect(out.call_id).toBe('call_1');
  });
});

describe('collectResponsesSSE — inbound name resolution', () => {
  it('maps the sanitized name the model echoes back to the original dotted id', async () => {
    const s = makeSanitizer(['get.time']);
    const wire = s.sanitize('get.time'); // 'get_time'

    const stream = sseStream([
      JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: wire,
          arguments: '{"tz":"UTC"}',
        },
      }),
      JSON.stringify({
        type: 'response.completed',
        response: { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'tool_calls' },
      }),
    ]);

    const result = await collectResponsesSSE(stream, undefined, undefined, s);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0].name).toBe('get.time');
    expect(result.toolCalls?.[0].input).toEqual({ tz: 'UTC' });
  });

  it('returns the wire name unchanged when no sanitizer is passed', async () => {
    const stream = sseStream([
      JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_2',
          name: 'file_read',
          arguments: '{}',
        },
      }),
    ]);
    const result = await collectResponsesSSE(stream);
    expect(result.toolCalls?.[0].name).toBe('file_read');
  });
});

describe('collectResponsesSSE — usage accounting', () => {
  it('reports cached input tokens from the terminal Responses usage details', async () => {
    const onUsage = jest.fn();
    const stream = sseStream([
      JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 12_000,
            input_tokens_details: { cached_tokens: 9_000 },
            output_tokens: 400,
          },
        },
      }),
    ]);

    const result = await collectResponsesSSE(stream, undefined, undefined, undefined, onUsage);

    expect(result).toMatchObject({
      inputTokens: 12_000,
      outputTokens: 400,
      cacheReadTokens: 9_000,
    });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 12_000,
      outputTokens: 400,
      cacheReadTokens: 9_000,
    });
  });

  it('surfaces cached input tokens on the provider result consumed by run accounting', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        sseStream([
          JSON.stringify({
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 25_000,
                input_tokens_details: { cached_tokens: 20_000 },
                output_tokens: 750,
              },
            },
          }),
        ]),
        { status: 200 }
      )
    );

    try {
      const result = await callResponsesEndpoint({
        url: 'https://example.invalid/codex/responses',
        headers: {},
        agent: {
          id: 'codex-agent',
          modelId: 'gpt-5.4',
          systemPrompt: 'Test instructions',
        } as SnagletAgent,
        messages: [{ role: 'user', content: 'Hello' }],
        providerLabel: 'codex',
      });

      expect(result.usage).toEqual({
        inputTokens: 25_000,
        outputTokens: 750,
        cacheReadTokens: 20_000,
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('collectResponsesSSE — a response cut off at the output limit', () => {
  it('reports max_output_tokens and never turns a truncated call into a tool turn', async () => {
    const stream = sseStream([
      JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'search',
          arguments: '{"q":"pl',
        },
      }),
      JSON.stringify({
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 10, output_tokens: 128_000 },
        },
      }),
    ]);

    const result = await collectResponsesSSE(stream);

    expect(result.stopReason).toBe('max_output_tokens');
  });

  it('still treats parsed calls in a finished response as a tool turn', async () => {
    const stream = sseStream([
      JSON.stringify({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'search',
          arguments: '{}',
        },
      }),
      JSON.stringify({ type: 'response.completed', response: { usage: {} } }),
    ]);

    const result = await collectResponsesSSE(stream);

    expect(result.stopReason).toBe('tool_use');
  });
});
