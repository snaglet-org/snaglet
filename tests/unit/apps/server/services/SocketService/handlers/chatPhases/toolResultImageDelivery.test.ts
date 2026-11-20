/**
 * Model-visible pixels for `rawContent.ephemeralInlineImages` on the native
 * (non-MCP) agent path. The chain is real end to end (capture_user_screen →
 * toolExecutor → dispatchToolCalls → buildPromptMessagesForIteration →
 * provider adapter); only leaves such as DB rows and `fetch` are mocked.
 *
 * One assertion per adapter, on the bytes the wire request would carry:
 * anthropic puts an `image` block inside the tool_result; chat-completions
 * sends `role: tool` text plus a following user `image_url` message; responses
 * sends `function_call_output` text plus a user `input_image`; gemini sends
 * `functionResponse` text plus a user `inline_data` part; apple-on-device
 * flattens the image to a marker (it has no vision channel).
 */

jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { logActivity: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock('@server/services/ToolService/lib/resolveAgentCwd', () => ({
  resolveAgentCwd: jest.fn().mockResolvedValue('/tmp/agent-cwd'),
}));

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecretById: jest.fn().mockResolvedValue(null) },
}));

jest.mock('@server/services/SocketService/confirmation', () => ({
  waitForConfirmation: jest.fn().mockResolvedValue({ approved: true }),
}));

jest.mock('@server/services/SocketService/clarification', () => ({
  waitForClarification: jest.fn(),
}));

// The real executor (rich-result promotion is the seam under test); the tool
// serializers the provider adapters import from the same barrel are inert.
jest.mock('@server/services/ToolService', () => {
  const { toolExecutor } = jest.requireActual('@server/services/ToolService/ToolExecutor');
  return {
    toolExecutor,
    toAnthropicTools: jest.fn(() => []),
    toOpenAITools: jest.fn(() => []),
    toGeminiTools: jest.fn(() => ({ functionDeclarations: [] })),
  };
});

const registryGetHandler = jest.fn();
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    size: 1,
    load: jest.fn().mockResolvedValue(undefined),
    getHandler: (toolId: string) => registryGetHandler(toolId),
    getDefinition: jest.fn(() => ({})),
    getAllDefinitions: jest.fn(() => []),
    getToolIds: jest.fn(() => ['capture_user_screen']),
  },
}));

const broadcastMock = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => broadcastMock(...args) },
}));

const createImageMock = jest.fn();
jest.mock('@snaglet/db/tables/images', () => ({
  Images: {
    createImage: (...args: unknown[]) => createImageMock(...args),
    findImageById: jest.fn(),
  },
}));

const messagesCreateMock = jest.fn();
const messagesFindByIdMock = jest.fn();
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    create: (...args: unknown[]) => messagesCreateMock(...args),
    findById: (...args: unknown[]) => messagesFindByIdMock(...args),
  },
}));

// capture_user_screen gates on the active model's vision support.
const modelsFindMock = jest.fn();
jest.mock('@snaglet/db/tables/models', () => ({
  Models: { findByProviderAndModelId: (...args: unknown[]) => modelsFindMock(...args) },
}));

const settingsValues: Record<string, unknown> = {
  maxResultChars: 100_000,
  condenseMinChars: 300,
  activityLogMaxOutputChars: 200_000,
  toolBulkTokenBudget: 50_000,
};
// Tool settings are keyed by the stubbed string ids below; any other setting
// definition falls back to its own `default`, exactly as the real service does
// when the row is unset.
jest.mock('@server/services/settings', () => ({
  settingsService: {
    read: jest.fn(async (def: string | { default?: unknown }) =>
      typeof def === 'string' ? settingsValues[def] : def.default
    ),
  },
}));
jest.mock('@server/services/settings/categories/tool', () => ({
  toolSettings: {
    maxResultChars: 'maxResultChars',
    condenseMinChars: 'condenseMinChars',
    activityLogMaxOutputChars: 'activityLogMaxOutputChars',
    toolBulkTokenBudget: 'toolBulkTokenBudget',
  },
}));

jest.mock('@server/services/LogsService', () => ({
  LogsService: {
    tool: { start: jest.fn(), end: jest.fn() },
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    socket: { event: jest.fn() },
    llm: { payload: jest.fn() },
  },
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/peerInjection', () => ({
  drainInjectablePeerMessages: jest.fn().mockReturnValue([]),
}));

jest.mock('@server/services/SocketService/voiceSession/voiceSessionRegistry', () => ({
  isThreadVoiceActive: jest.fn().mockReturnValue(false),
}));

// capture_user_screen's leaf: the vision capture itself (the browser frame).
const captureOnDemandMock = jest.fn();
jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: { captureOnDemand: (...args: unknown[]) => captureOnDemandMock(...args) },
}));

// Provider adapters: secret lookup + payload logging are the only non-network
// side effects; everything else in `shared` runs for real.
jest.mock('@server/services/ProviderChatService/shared', () => {
  const actual = jest.requireActual('@server/services/ProviderChatService/shared');
  return {
    ...actual,
    pickSecret: jest.fn(async () => 'test-provider-secret'),
    logProviderPayload: jest.fn(),
  };
});

import type { SnagletAgent } from '@snaglet/shared/types';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type { ContextBudget } from '@server/services/ContextWindowService';
import type { ProviderMessage, ToolResultBlock } from '@server/services/ProviderChatService/types';
import { chatAnthropic } from '@server/services/ProviderChatService/providers/anthropic';
import { renderApplePrompt } from '@server/services/ProviderChatService/providers/apple-on-device';
import { chatGemini } from '@server/services/ProviderChatService/providers/gemini';
import { buildOpenAICompatibleChatCompletionBody } from '@server/services/ProviderChatService/providers/shared/chat-completions';
import { toResponsesInputItems } from '@server/services/ProviderChatService/providers/shared/responses-api';
import { createToolNameSanitizer } from '@server/services/ProviderChatService/providers/shared/toolNameSanitizer';
import { buildPromptMessagesForIteration } from '@server/services/SocketService/handlers/chatPhases/promptBuilder';
import {
  dispatchToolCalls,
  type DispatchToolCallsInput,
} from '@server/services/SocketService/handlers/chatPhases/toolDispatch';
import type { Message } from '@server/services/SocketService/types';
import { NO_DOTS_TOOL_NAME_GRAMMAR } from '@server/services/ToolService/lib/toolName';
import captureUserScreenHandler from '@server/services/ToolService/tools/media/capture-user-screen/tool';

// 1x1 transparent PNG — the bytes that must reach the wire verbatim.
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const TOOL_USE_ID = 'toolu_screen_capture_1';
const TRIGGER_MESSAGE_ID = 'message-trigger-1';
const FRAME_ID = 'frame-test-frame-1';

function makeTool(id: string): ResolvedAgentTool {
  return {
    agentId: 'agent-1',
    tool: {
      id,
      name: id,
      description: '',
      type: 'builtin',
      parametersSchema: {},
      keywords: [],
      aliases: [],
      source: null,
      configJson: {},
      enabled: true,
      tier: 'standard',
      categoryPath: 'test',
      providerId: null,
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
    } as unknown as ResolvedAgentTool['tool'],
    settings: {},
    requiresConfirmation: false,
  };
}

function makeAgent(overrides: Partial<SnagletAgent> = {}): SnagletAgent {
  return {
    id: 'agent-1',
    name: 'TestAgent',
    provider: 'anthropic',
    systemPrompt: 'be helpful',
    rawSystemPrompt: null,
    modelId: 'claude-sonnet-4-6',
    credentialId: null,
    toolAccessMode: 'all',
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    mcpServers: null,
    toolOverrides: null,
    budgetJson: null,
    fallbacks: null,
    disableModelFallback: false,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as SnagletAgent;
}

const roomyBudget: ContextBudget = {
  contextWindowTokens: 200_000,
  effectiveContextWindowTokens: 180_000,
  safetyMarginPct: 10,
  maxOutputTokens: 4096,
  systemPromptTokens: 50,
  toolCatalogTokens: 0,
  overheadTokens: 50,
  overheadFloored: false,
  usableBudget: 150_000,
  tokenThreshold: 120_000,
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  minMessagesBeforeCompression: 6,
  maxSummaryChars: 4000,
};

/**
 * Run the real chain up to the provider boundary: capture_user_screen →
 * executor → dispatch → prompt builder. Returns the ProviderMessage[] every
 * adapter is handed, i.e. the last thing Snaglet owns before the wire format.
 */
async function providerMessagesAfterScreenCapture(): Promise<ProviderMessage[]> {
  const agent = makeAgent();
  const agentMessages: Message[] = [
    { role: 'user', content: 'Look at my screen.' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'capture_user_screen', input: {} }],
    },
  ];
  const input: DispatchToolCallsInput = {
    result: {
      reply: '',
      toolCalls: [{ id: TOOL_USE_ID, name: 'capture_user_screen', input: {} }],
    },
    agent,
    runtimeAgent: agent,
    agentMessages,
    toolMap: new Map([['capture_user_screen', makeTool('capture_user_screen')]]),
    visibleToolIds: new Set(['capture_user_screen']),
    toolAccess: { mode: 'all', allowList: [], denyList: [] },
    session: {
      threadId: 'thread-1',
      id: 'session-1',
    } as unknown as DispatchToolCallsInput['session'],
    sessionId: 'session-1',
    threadName: 'Test Thread',
    runId: 'run-1',
    triggerMessageId: TRIGGER_MESSAGE_ID,
    latestThinking: '',
    toToolText: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
    dispatchMode: 'all' as DispatchToolCallsInput['dispatchMode'],
  };

  await dispatchToolCalls(input);

  return buildPromptMessagesForIteration({
    agent,
    runtimeAgent: agent,
    agentMessages,
    budget: roomyBudget,
    threadSummaryText: null,
    isGroup: false,
    threadName: 'Test Thread',
    threadId: 'thread-1',
    systemBlocks: [],
    toolRows: [],
    iteration: 1,
    compactionCarryForward: '',
    // The whole array is this run's working state — nothing may fold.
    currentRunBoundary: 0,
  });
}

function sseResponse(events: Array<Record<string, unknown>>, withEventLine: boolean): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        const head = withEventLine ? `event: ${String(ev.type)}\n` : '';
        controller.enqueue(enc.encode(`${head}data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function capturedJsonBody(fetchSpy: jest.SpyInstance): Record<string, unknown> {
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const expectedAnthropicImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: TINY_PNG_B64 },
};

beforeEach(() => {
  jest.clearAllMocks();
  registryGetHandler.mockImplementation((toolId: string) =>
    toolId === 'capture_user_screen' ? captureUserScreenHandler : undefined
  );
  modelsFindMock.mockResolvedValue({ supportsVision: true });
  messagesFindByIdMock.mockResolvedValue({
    id: TRIGGER_MESSAGE_ID,
    threadId: 'thread-1',
    userId: 'user-1',
  });
  // The shape `VisionThreadService.captureOnDemand` resolves with
  // (`VisionOnDemandCapture`); the handler forwards `base64` + `mediaType`
  // as the ephemeral inline image.
  captureOnDemandMock.mockResolvedValue({
    frameId: FRAME_ID,
    sessionId: 'vision-session-1',
    source: 'screen',
    capturedAt: '2026-01-01T00:00:00.000Z',
    mediaType: 'image/png',
    byteLength: Buffer.from(TINY_PNG_B64, 'base64').byteLength,
    base64: TINY_PNG_B64,
    reused: false,
    deliveryUrl: `/api/vision/frames/${FRAME_ID}`,
    expiresAt: '2026-01-01T00:05:00.000Z',
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('capture_user_screen pixels — Snaglet-owned path (executor → dispatch → prompt builder)', () => {
  it('lands as a real image block inside the tool_result the adapters receive', async () => {
    const messages = await providerMessagesAfterScreenCapture();

    // Nothing was persisted or posted: ephemeral means ephemeral.
    expect(createImageMock).not.toHaveBeenCalled();
    expect(messagesCreateMock).not.toHaveBeenCalled();

    const toolResultTurn = messages[messages.length - 1];
    expect(toolResultTurn.role).toBe('user');
    const blocks = toolResultTurn.content as ToolResultBlock[];
    expect(blocks).toHaveLength(1);
    const [toolResult] = blocks;
    expect(toolResult.type).toBe('tool_result');
    expect(toolResult.tool_use_id).toBe(TOOL_USE_ID);
    expect(toolResult.is_error).toBe(false);
    expect(Array.isArray(toolResult.content)).toBe(true);
    const parts = toolResult.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({
      type: 'text',
      text: expect.stringContaining(FRAME_ID),
    });
    expect(parts[1]).toEqual(expectedAnthropicImageBlock);
    // The base64 rides only in the image block — never in the text channel.
    expect(String((parts[0] as { text: string }).text)).not.toContain(TINY_PNG_B64);
  });
});

describe('capture_user_screen pixels — provider wire formats', () => {
  it('anthropic: the tool_result carries the image/png block in the request body', async () => {
    const messages = await providerMessagesAfterScreenCapture();
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse(
        [
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          },
          { type: 'message_stop' },
        ],
        true
      )
    );

    await chatAnthropic(makeAgent(), messages);

    const body = capturedJsonBody(fetchSpy);
    const wireMessages = body.messages as Array<{ role: string; content: unknown }>;
    const last = wireMessages[wireMessages.length - 1];
    expect(last.role).toBe('user');
    const wireBlocks = last.content as Array<Record<string, unknown>>;
    const toolResult = wireBlocks.find((b) => b.type === 'tool_result') as {
      tool_use_id: string;
      content: Array<Record<string, unknown>>;
    };
    expect(toolResult.tool_use_id).toBe(TOOL_USE_ID);
    expect(toolResult.content).toEqual([
      { type: 'text', text: expect.stringContaining(FRAME_ID) },
      expectedAnthropicImageBlock,
    ]);
    // The pairing guard saw a valid pair — nothing was flattened to text.
    expect(wireBlocks.some((b) => b.type === 'text')).toBe(false);
  });

  it('chat-completions (openai & compatibles): tool text + a following user image_url data URL', async () => {
    const messages = await providerMessagesAfterScreenCapture();

    const { body } = buildOpenAICompatibleChatCompletionBody({
      agent: makeAgent({ provider: 'openai', modelId: 'gpt-4o' }),
      messages,
    });

    const wire = body.messages as Array<Record<string, unknown>>;
    const toolIdx = wire.findIndex((m) => m.role === 'tool');
    expect(toolIdx).toBeGreaterThan(0);
    expect(wire[toolIdx]).toEqual({
      role: 'tool',
      tool_call_id: TOOL_USE_ID,
      content: expect.stringContaining(FRAME_ID),
    });
    expect(String(wire[toolIdx].content)).not.toContain(TINY_PNG_B64);
    expect(wire[toolIdx + 1]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } }],
    });
  });

  it('responses API (codex OAuth, copilot responses-only): function_call_output + input_image', async () => {
    const messages = await providerMessagesAfterScreenCapture();
    const sanitizer = createToolNameSanitizer(NO_DOTS_TOOL_NAME_GRAMMAR);

    const items = messages.flatMap((m) => toResponsesInputItems(m, sanitizer)) as Array<
      Record<string, unknown>
    >;

    const outputIdx = items.findIndex((i) => i.type === 'function_call_output');
    expect(outputIdx).toBeGreaterThan(0);
    expect(items[outputIdx]).toEqual({
      type: 'function_call_output',
      call_id: TOOL_USE_ID,
      output: expect.stringContaining(FRAME_ID),
    });
    expect(String(items[outputIdx].output)).not.toContain(TINY_PNG_B64);
    expect(items[outputIdx + 1]).toEqual({
      role: 'user',
      content: [{ type: 'input_image', image_url: `data:image/png;base64,${TINY_PNG_B64}` }],
    });
  });

  it('gemini: functionResponse text + a following user inline_data part', async () => {
    const messages = await providerMessagesAfterScreenCapture();
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        sseResponse([{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }], false)
      );

    await chatGemini(makeAgent({ provider: 'google', modelId: 'gemini-2.5-pro' }), messages);

    const body = capturedJsonBody(fetchSpy);
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const responseIdx = contents.findIndex((c) =>
      c.parts.some((p) => p.functionResponse !== undefined)
    );
    expect(responseIdx).toBeGreaterThan(0);
    expect(contents[responseIdx].parts[0]).toEqual({
      functionResponse: {
        name: TOOL_USE_ID,
        response: { content: expect.stringContaining(FRAME_ID) },
      },
    });
    expect(contents[responseIdx + 1]).toEqual({
      role: 'user',
      parts: [{ inline_data: { mime_type: 'image/png', data: TINY_PNG_B64 } }],
    });
  });

  it('apple-on-device: text-only prompt — the image is flattened to a marker (documented drop)', async () => {
    const messages = await providerMessagesAfterScreenCapture();

    const prompt = renderApplePrompt(messages);

    expect(prompt).toContain(FRAME_ID);
    expect(prompt).toContain('[image attached — not visible on this provider]');
    expect(prompt).not.toContain(TINY_PNG_B64);
  });
});
