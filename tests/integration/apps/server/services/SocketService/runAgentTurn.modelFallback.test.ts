/**
 * Integration test: model-candidate fallback policy in createRunAgentTurn.
 *
 * Cases:
 *   A. Thread-override candidate fails    → run fails, no fallback, no second
 *      provider call, visible socket:error emitted.
 *   B. Agent-default chain, first fails   → fallback proceeds, second provider
 *      call happens, a socket:agent:model:fallback event is broadcast so the
 *      client can show "Gemma 3 failed: <reason>, retrying with <next>".
 *   C. AbortError on any candidate        → run aborts cleanly with no
 *      fallback attempted.
 *   D. disableModelFallback               → one same-model recovery, then the
 *      run fails without switching provider.
 */

import { randomUUID } from 'crypto';

// Mock every external dependency referenced by runAgentTurn
jest.mock('@snaglet/db/tables/messages');
jest.mock('@snaglet/db/tables/runs');
jest.mock('@snaglet/db/tables/threads');
jest.mock('@snaglet/db/tables/agent_activity_log');
jest.mock('@snaglet/db/tables/thread_participants');
jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAgentTools: jest.fn().mockResolvedValue([]),
  resolveAgentToolsForExecution: jest.fn().mockResolvedValue([]),
  selectAdvertisedAgentTools: jest.fn(
    ({ allowedTools }: { allowedTools: readonly unknown[] }) => allowedTools
  ),
  // contextAssembly resolves all three sets through this one call so the turn
  // path and the usage estimator cannot disagree on the advertised catalog.
  resolveAdvertisedAgentToolSets: jest
    .fn()
    .mockResolvedValue({ allowedTools: [], executionTools: [], advertisedTools: [] }),
}));

jest.mock('@server/services/ProviderChatService/index', () => ({
  providerChatService: {
    complete: jest.fn(),
    streamChat: jest.fn(),
  },
}));

jest.mock('@server/services/ToolService/index', () => ({
  toolExecutor: {
    execute: jest.fn(),
    executeToolCall: jest.fn(),
  },
}));

jest.mock('@server/services/ProviderCredentialService/index', () => ({
  providerCredentialService: {
    getKeyForProvider: jest.fn().mockResolvedValue('test-key'),
    getSecretById: jest.fn().mockResolvedValue('test-key'),
    resolveCredentialIdForModel: jest
      .fn()
      .mockImplementation(async ({ preferredCredentialId }) => preferredCredentialId ?? null),
  },
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/extractToolImages', () => ({
  extractToolImages: jest.fn().mockResolvedValue({ images: [], hasImages: false }),
  buildImageBlocksForIds: jest.fn().mockResolvedValue([]),
}));

jest.mock('@server/services/ContextWindowService', () => ({
  resolveContextBudget: jest.fn().mockResolvedValue({
    maxTokens: 4096,
    maxOutputTokens: 1024,
    reservedForResponse: 1024,
  }),
  compressMessages: jest.fn((msgs: unknown[]) => ({ messages: msgs })),
  // Stub: these suites assert turn/fallback mechanics, never the boundary. The
  // real walk is covered by ContextWindowService.test.ts (findCurrentRunBoundary).
  findCurrentRunBoundary: jest.fn((messages: unknown[]) => messages.length),
}));

jest.mock('@server/services/SummaryService', () => ({
  summaryService: {
    getThreadSummary: jest.fn().mockResolvedValue(null),
    getSummariesForThread: jest.fn().mockResolvedValue([]),
    generateSummary: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('@server/services/PerceptionService', () => ({
  perceptionService: {
    buildSystemMessage: jest.fn().mockResolvedValue('system'),
    buildGroupSystemPromptBlocks: jest.fn().mockResolvedValue([{ type: 'text', text: 'system' }]),
    buildDirectSystemPromptBlocks: jest.fn().mockResolvedValue([{ type: 'text', text: 'system' }]),
    flattenSystemBlocks: jest.fn().mockReturnValue('system'),
    buildPerception: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: jest.fn().mockResolvedValue(undefined),
}));

// Perception is assembled via turn replay. Its loader reads messages/runs/activity
// from the (auto-mocked) DB tables, so stub it to an empty history.
jest.mock('@server/services/SocketService/handlers/chatPhases/replayLoader', () => ({
  buildReplayPayload: jest.fn().mockResolvedValue({ messages: [], watermark: null }),
}));

jest.mock('@server/services/SocketService/confirmation', () => ({
  waitForConfirmation: jest.fn().mockResolvedValue({ approved: true }),
}));

jest.mock('@server/services/SocketService/store', () => ({
  getSession: jest.fn(),
  setSessionParticipants: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/compactHandlers', () => ({
  isThreadCompacting: jest.fn().mockReturnValue(false),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/providerRetryPolicy', () => {
  const actual = jest.requireActual(
    '@server/services/SocketService/handlers/chatPhases/providerRetryPolicy'
  );
  return {
    ...actual,
    waitForTransientProviderRetry: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock('@server/services/SocketService/abortStore', () => ({
  createAbortController: jest.fn().mockReturnValue({
    signal: new AbortController().signal,
    controller: new AbortController(),
  }),
  clearAbortController: jest.fn(),
  readAgentAbortReason: jest.fn().mockReturnValue(null),
}));

jest.mock('@server/services/SocketService/handlers/chatHelpers', () => ({
  emitAgentTyping: jest.fn(),
  emitAgentStatus: jest.fn(),
  condenseProcessedToolResults: jest.fn((r: unknown) => r),
  detectMessageType: jest.fn().mockReturnValue('message'),
  resolveMessageType: jest.fn().mockReturnValue('message'),
  logLlmPayload: jest.fn(),
  createThinkingInterceptor: jest.fn((onVisibleChunk: (chunk: string) => void) => ({
    push: onVisibleChunk,
    flush: jest.fn(),
    getThinking: () => '',
  })),
  stripThinkingTags: jest.fn((s: string) => ({ reply: s, thinking: '' })),
}));

jest.mock('@server/services/MentionParser', () => ({
  parseMentions: jest.fn().mockReturnValue({
    mentions: [],
    mentionedAgentIds: [],
    hasMentions: false,
    rawMentions: [],
  }),
}));

jest.mock('@server/services/ConversationBudget', () => ({
  ConversationBudget: jest.fn(),
}));

const logsNoOp = jest.fn();
const makeLogsProxy = (): unknown =>
  new Proxy(logsNoOp, {
    get: (_t, prop) => {
      if (prop === 'mockImplementation' || prop === 'mockReturnValue' || prop === 'mock') {
        return (logsNoOp as unknown as Record<string, unknown>)[prop as string];
      }
      return makeLogsProxy();
    },
    apply: () => undefined,
  });
jest.mock('@server/services/LogsService', () => ({
  LogsService: makeLogsProxy(),
}));

jest.mock('@snaglet/shared/types', () => ({
  normalizeToolAccessConfig: jest.fn().mockReturnValue({ mode: 'all' as const, tools: [] }),
}));

jest.mock('@server/services/ConfigResolverService', () => ({
  resolveThreadRuntimeConfig: jest.fn().mockResolvedValue(null),
  resolveContentField: jest.fn(async (msg?: { content?: string }) => msg?.content ?? null),
}));

jest.mock('@server/services/SystemPromptComposer/index', () => ({
  composeSystemPrompt: jest.fn().mockResolvedValue([{ type: 'text', text: 'system' }]),
}));

jest.mock('@server/services/SystemPromptComposer/expandPromptIncludes', () => ({
  expandPromptIncludes: jest.fn(async (content: string) => content),
}));

jest.mock('@server/services/SystemPromptComposer/resolveRunParams', () => ({
  resolveRunParams: jest.fn().mockResolvedValue({}),
}));

jest.mock('@server/services/settings/categories/tool', () => ({
  toolSettings: {
    maxIterations: 'maxIterations',
    condenseMinChars: 'condenseMinChars',
    maxResultChars: 'maxResultChars',
    toolBulkTokenBudget: 'toolBulkTokenBudget',
  },
}));

jest.mock('@server/services/settings/categories/budget', () => ({
  budgetSettings: { group: 'group' },
}));

jest.mock('@server/services/settings/index', () => ({
  settingsService: {
    read: jest.fn(async (setting: string) => {
      if (setting === 'group') return { streamThinking: true };
      if (setting === 'maxResultChars') return 10000;
      if (setting === 'condenseMinChars') return 1000;
      if (setting === 'toolBulkTokenBudget') return 35000;
      return 10;
    }),
  },
}));

// This mock is overridden per-test via mockBuildModelCandidates.
const mockBuildModelCandidates = jest.fn();
jest.mock('@server/services/SocketService/handlers/modelCandidates', () => ({
  buildModelCandidates: mockBuildModelCandidates,
}));

const wsBroadcast = jest.fn();
const wsSendToClient = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: (...args: unknown[]) => wsSendToClient(...args),
    broadcastToChannel: (...args: unknown[]) => wsBroadcast(...args),
  },
}));

jest.mock('@server/services/AgentService', () => ({
  agentService: {
    get: jest.fn(),
    getAgentById: jest.fn(),
  },
}));

jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    add: jest.fn(),
    remove: jest.fn(),
    start: jest.fn(),
    finish: jest.fn(),
    noteProgress: jest.fn(),
    noteToolCall: jest.fn(),
    // Run-ended narration reads the turn's stats here; null = nothing to narrate.
    takeTurnSummary: jest.fn().mockReturnValue(null),
    isActive: jest.fn().mockReturnValue(false),
    reserveHandoff: jest.fn(),
    drainMessages: jest.fn().mockReturnValue([]),
  },
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/buildPriorRunHint', () => ({
  buildPriorRunHint: jest.fn().mockResolvedValue(null),
}));
jest.mock('@server/services/SocketService/handlers/chatPhases/detectPassSignal', () => ({
  detectPassSignal: jest.fn((reply: string) => ({
    trimmedReply: reply,
    isExplicitPass: false,
    isAutoPass: false,
    stagnationSimilarity: 0,
  })),
}));

// Import the module under test (after mocks)
import { createRunAgentTurn } from '@server/services/SocketService/handlers/chatPhases/runAgentTurn';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';
import { providerChatService } from '@server/services/ProviderChatService';
import { agentService } from '@server/services/AgentService';
import { Messages } from '@snaglet/db/tables/messages';
import { Runs } from '@snaglet/db/tables/runs';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
// Per-model-attempt work: prepareModelAttemptContext resolves the budget on
// every candidate. Used below as the witness that a wake assembled twice.
import { resolveContextBudget } from '@server/services/ContextWindowService';

// Helpers

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'TestAgent',
    role: 'assistant',
    systemPrompt: 'You are a test agent.',
    provider: 'openai',
    modelId: 'gpt-4o',
    credentialId: 'cred-1',
    avatar_url: null,
    temperature: null,
    max_tokens: null,
    tool_access_config: null,
    configJson: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<RunAgentTurnDeps> = {}): RunAgentTurnDeps {
  const abortController = new AbortController();
  return {
    session: { threadId: 'thread-1', id: 'session-1' } as never,
    sessionId: 'session-1',
    threadId: 'thread-1',
    threadName: 'Test Thread',
    clientId: 'client-1',
    meta: { clientId: 'client-1', channel: 'chat:thread-1' },
    isGroup: false,
    participantAgentIds: ['agent-1'],
    softDispatchThreshold: 3,
    hardDispatchCeiling: 5,
    agentTimeoutMs: 30000,
    threadRuntimeConfig: null,
    activeRunIds: new Set<string>(),
    previewMessage: (v: string, max?: number) => v.slice(0, max ?? 100),
    toToolText: (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
    triggerMessageId: 'msg-trigger-1',
    wokenByMention: new Set<string>(),
    isParticipantMention: () => true,
    startAgent: jest.fn(),
    HARD_DISPATCH_CEILING: 5,
    dispatchSet: new Set<string>(),
    wsService: {
      sendToClient: jest.fn(),
      broadcastToChannel: jest.fn(),
    },
    agentService: {
      get: jest.fn().mockResolvedValue(makeAgent()),
      getAgentById: jest.fn().mockResolvedValue(makeAgent()),
    } as never,
    configService: {
      get: jest.fn().mockReturnValue(null),
      getNumber: jest.fn().mockResolvedValue(10),
      getString: jest.fn().mockResolvedValue(''),
      getBool: jest.fn().mockResolvedValue(false),
    } as never,
    abortController,
    convBudget: {
      canContinue: jest.fn().mockReturnValue(true),
      recordAgentTurn: jest.fn(),
      summary: jest.fn().mockReturnValue({
        totalOutputTokens: 0,
        wavesUsed: 1,
        exhaustedReason: null,
      }),
    } as never,
    agentNameMap: new Map([['agent-1', 'TestAgent']]),
    agentRoleMap: new Map([['agent-1', 'assistant']]),
    resolveParticipantId: () => 'agent-1',
    buildMentionContext: () => undefined,
    effectiveParallelDispatch: false,
    parallelOnMentionSetting: false,
    ...overrides,
  };
}

function makeSharedState(
  overrides: Partial<RunAgentTurnSharedState> = {}
): RunAgentTurnSharedState {
  return {
    runningAgents: new Set<string>(),
    agentMentionQueues: new Map<string, string[]>(),
    agentDispatchCount: new Map<string, number>(),
    agentSoftThresholdNotified: new Set<string>(),
    recentRepliesByAgent: new Map<string, string[]>(),
    stagnationStrikes: new Map<string, number>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    currentWaveResults: [],
    conversationRound: 0,
    tokenTotals: { input: 0, output: 0 },
    ...overrides,
  } as RunAgentTurnSharedState;
}

beforeEach(() => {
  jest.clearAllMocks();
  wsBroadcast.mockClear();
  wsSendToClient.mockClear();

  (agentService.get as jest.Mock).mockResolvedValue(makeAgent());

  (Messages as unknown as { create: jest.Mock }).create = jest
    .fn()
    .mockResolvedValue({ id: randomUUID() });

  (
    Runs as unknown as { create: jest.Mock; markCompleted: jest.Mock; markFailed: jest.Mock }
  ).create = jest.fn().mockResolvedValue({ id: randomUUID() });
  (Runs as unknown as { markCompleted: jest.Mock }).markCompleted = jest
    .fn()
    .mockResolvedValue(undefined);
  (Runs as unknown as { markFailed: jest.Mock }).markFailed = jest
    .fn()
    .mockResolvedValue(undefined);
  (AgentActivityLog as unknown as { logActivity: jest.Mock }).logActivity = jest
    .fn()
    .mockResolvedValue(undefined);
  (ThreadParticipants as unknown as { isAgentParticipant: jest.Mock }).isAgentParticipant = jest
    .fn()
    .mockResolvedValue(true);

  (
    Threads as unknown as { findById: jest.Mock; getEffectiveModel: jest.Mock; touch: jest.Mock }
  ).findById = jest.fn().mockResolvedValue({ id: 'thread-1', name: 'Test Thread' });
  (Threads as unknown as { getEffectiveModel: jest.Mock }).getEffectiveModel = jest
    .fn()
    .mockResolvedValue(null);
  (Threads as unknown as { touch: jest.Mock }).touch = jest.fn().mockResolvedValue(undefined);

  (resolveAgentTools as jest.Mock).mockResolvedValue([]);
});

// Tests

describe('runAgentTurn — model-candidate fallback policy', () => {
  it('retries one transient stream termination on the same model before succeeding', async () => {
    mockBuildModelCandidates.mockResolvedValue([
      {
        provider_id: 'anthropic',
        model_id: 'claude-opus-4-7',
        credential_id: 'cred-1',
        source: 'agent_default',
      },
    ]);

    const completeMock = providerChatService.complete as jest.Mock;
    completeMock
      .mockImplementationOnce(
        async (
          _agent: unknown,
          _messages: unknown,
          onChunk: (chunk: string) => void,
          options?: { onThinkingChunk?: (chunk: string) => void }
        ) => {
          onChunk('discarded partial');
          options?.onThinkingChunk?.('discarded thought');
          throw new TypeError('terminated');
        }
      )
      .mockImplementationOnce(
        async (
          _agent: unknown,
          _messages: unknown,
          onChunk: (chunk: string) => void,
          options?: { onThinkingChunk?: (chunk: string) => void }
        ) => {
          onChunk('recovered reply');
          options?.onThinkingChunk?.('recovered thought');
          return {
            reply: 'recovered reply',
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 2 },
            stopReason: 'end_turn',
            thinkingContent: 'recovered thought',
          };
        }
      );

    const turn = createRunAgentTurn(makeDeps(), makeSharedState());
    await turn('agent-1');

    expect(completeMock).toHaveBeenCalledTimes(2);
    expect((Runs as unknown as { create: jest.Mock }).create).toHaveBeenCalledTimes(1);
    expect((Runs as unknown as { markFailed: jest.Mock }).markFailed).not.toHaveBeenCalled();

    const retryEvents = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:agent:stream:retry'
    );
    expect(retryEvents).toHaveLength(1);
    expect(
      (retryEvents[0]![1] as { payload: { agentId: string; runId: string } }).payload
    ).toMatchObject({ agentId: 'agent-1' });

    const streamedEvents = wsBroadcast.mock.calls
      .map(([, message]) => message as { type: string; payload?: { text?: string } })
      .filter((message) =>
        ['socket:delta', 'socket:thinking:chunk', 'socket:agent:stream:retry'].includes(
          message.type
        )
      );
    expect(streamedEvents.map((message) => message.type)).toEqual([
      'socket:delta',
      'socket:thinking:chunk',
      'socket:agent:stream:retry',
      'socket:delta',
      'socket:thinking:chunk',
    ]);

    const persistedContent = (Messages.create as jest.Mock).mock.calls.map(
      ([input]) => (input as { content?: string }).content
    );
    expect(persistedContent).toContain('recovered reply');
    expect(persistedContent).not.toContain('discarded partial');

    expect(
      (AgentActivityLog as unknown as { logActivity: jest.Mock }).logActivity
    ).toHaveBeenCalledTimes(1);
    expect(
      (AgentActivityLog as unknown as { logActivity: jest.Mock }).logActivity.mock.calls[0]![0]
    ).toMatchObject({ content: 'recovered thought' });
  });

  it('Case A: thread_override candidate failure — no fallback, surfaces provider error', async () => {
    mockBuildModelCandidates.mockResolvedValue([
      // Pinned via thread participants (or thread config_json.agents).
      {
        provider_id: 'ollama',
        model_id: 'gemma3',
        credential_id: 'cred-local',
        source: 'thread_override',
      },
      // Agent's default — must not be invoked when first is pinned.
      {
        provider_id: 'anthropic',
        model_id: 'claude-opus-4-7',
        credential_id: 'cred-anthropic',
        source: 'agent_default',
      },
    ]);

    const completeMock = providerChatService.complete as jest.Mock;
    completeMock.mockRejectedValueOnce(new Error('Ollama refused: model gemma3 not loaded'));

    const deps = makeDeps();
    const shared = makeSharedState();
    const turn = createRunAgentTurn(deps, shared);

    await turn('agent-1');

    // Only one provider call — fallback never attempted.
    expect(completeMock).toHaveBeenCalledTimes(1);

    // Visible socket:error broadcast to the thread channel, containing the
    // provider error.
    const errorCalls = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:error'
    );
    expect(errorCalls.length).toBeGreaterThanOrEqual(1);
    const errMsg = (errorCalls[0]![1] as { payload: { message: string } }).payload.message;
    expect(errMsg).toContain('Ollama refused');

    // No fallback event was emitted.
    const fallbackEvents = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:agent:model:fallback'
    );
    expect(fallbackEvents).toHaveLength(0);

    // Run was marked failed with the actual provider error.
    expect((Runs as unknown as { markFailed: jest.Mock }).markFailed).toHaveBeenCalled();
    const markFailedArgs = (Runs as unknown as { markFailed: jest.Mock }).markFailed.mock.calls[0]!;
    expect(String(markFailedArgs[1])).toContain('Ollama refused');
  });

  it('Case B: two transient failures consume one same-model retry, then fallback', async () => {
    mockBuildModelCandidates.mockResolvedValue([
      {
        provider_id: 'openai',
        model_id: 'gpt-4o',
        credential_id: 'cred-1',
        source: 'agent_default',
      },
      {
        provider_id: 'anthropic',
        model_id: 'claude-opus-4-7',
        credential_id: 'cred-2',
        source: 'agent_default',
      },
    ]);

    const completeMock = providerChatService.complete as jest.Mock;
    completeMock
      .mockRejectedValueOnce(new Error('OpenAI 503 Service Unavailable'))
      .mockRejectedValueOnce(new Error('ECONNRESET: connection reset by peer'))
      .mockResolvedValueOnce({
        reply: 'fallback reply',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, thinkingTokens: 0 },
        stopReason: 'end_turn',
        thinkingContent: '',
      });

    const deps = makeDeps();
    const shared = makeSharedState();
    const turn = createRunAgentTurn(deps, shared);

    await turn('agent-1');

    // The first candidate gets exactly one recovery, then the fallback runs.
    expect(completeMock).toHaveBeenCalledTimes(3);
    const retryEvents = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:agent:stream:retry'
    );
    expect(retryEvents).toHaveLength(1);

    // A visible "model fallback" event was broadcast to the thread channel.
    const fallbackEvents = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:agent:model:fallback'
    );
    expect(fallbackEvents.length).toBe(1);
    const fbPayload = (
      fallbackEvents[0]![1] as {
        payload: {
          sessionId: string;
          agentId: string;
          fromProviderId: string;
          fromModelId: string;
          toProviderId: string;
          toModelId: string;
          reason: string;
        };
      }
    ).payload;
    expect(fbPayload.fromProviderId).toBe('openai');
    expect(fbPayload.fromModelId).toBe('gpt-4o');
    expect(fbPayload.toProviderId).toBe('anthropic');
    expect(fbPayload.toModelId).toBe('claude-opus-4-7');
    expect(fbPayload.reason).toContain('ECONNRESET');
    // Cache transparency: the payload flags the cache reset.
    const fbCache = (
      fallbackEvents[0]![1] as {
        payload: { cacheReset?: boolean; estWastedCacheTokens?: number };
      }
    ).payload;
    expect(fbCache.cacheReset).toBe(true);
    expect(typeof fbCache.estWastedCacheTokens).toBe('number');
  });

  it('Case D: disableModelFallback still permits one same-model recovery, then fails loudly', async () => {
    (agentService.get as jest.Mock).mockResolvedValue(makeAgent({ disableModelFallback: true }));
    mockBuildModelCandidates.mockResolvedValue([
      {
        provider_id: 'openai',
        model_id: 'gpt-4o',
        credential_id: 'cred-1',
        source: 'agent_default',
      },
      {
        provider_id: 'anthropic',
        model_id: 'claude-opus-4-7',
        credential_id: 'cred-2',
        source: 'agent_default',
      },
    ]);

    const completeMock = providerChatService.complete as jest.Mock;
    completeMock.mockRejectedValue(new Error('OpenAI 503 Service Unavailable'));

    const deps = makeDeps();
    const shared = makeSharedState();
    const turn = createRunAgentTurn(deps, shared);

    await turn('agent-1');

    // Same-model recovery is independent of fallback opt-out, but no provider switch occurs.
    expect(completeMock).toHaveBeenCalledTimes(2);

    const fallbackEvents = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:agent:model:fallback'
    );
    expect(fallbackEvents.length).toBe(0);

    // The surfaced error names the opt-out so the failure isn't mysterious.
    const errorSends = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:error'
    );
    expect(errorSends.length).toBeGreaterThan(0);
    const errMsg = (errorSends[0]![1] as { payload: { message: string } }).payload.message;
    expect(errMsg).toContain('fallback is disabled');
  });

  it('does not same-model retry a non-transient authentication error', async () => {
    mockBuildModelCandidates.mockResolvedValue([
      {
        provider_id: 'openai',
        model_id: 'gpt-4o',
        credential_id: 'cred-1',
        source: 'thread_override',
      },
    ]);
    const completeMock = providerChatService.complete as jest.Mock;
    completeMock.mockRejectedValueOnce(new Error('OpenAI request failed (401): invalid api key'));

    const turn = createRunAgentTurn(makeDeps(), makeSharedState());
    await turn('agent-1');

    expect(completeMock).toHaveBeenCalledTimes(1);
    const retryEvents = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:agent:stream:retry'
    );
    expect(retryEvents).toHaveLength(0);
  });

  it('Case C: AbortError — clean abort, no fallback', async () => {
    mockBuildModelCandidates.mockResolvedValue([
      {
        provider_id: 'openai',
        model_id: 'gpt-4o',
        credential_id: 'cred-1',
        source: 'agent_default',
      },
      {
        provider_id: 'anthropic',
        model_id: 'claude-opus-4-7',
        credential_id: 'cred-2',
        source: 'agent_default',
      },
    ]);

    const completeMock = providerChatService.complete as jest.Mock;
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    completeMock.mockRejectedValueOnce(abortErr);

    const deps = makeDeps();
    const shared = makeSharedState();
    const turn = createRunAgentTurn(deps, shared);

    await turn('agent-1');

    // Only one call — abort breaks the candidate loop.
    expect(completeMock).toHaveBeenCalledTimes(1);

    // No fallback event.
    const fallbackEvents = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:agent:model:fallback'
    );
    expect(fallbackEvents).toHaveLength(0);

    // Abort is reported via socket:chat:aborted.
    const abortedEvents = wsBroadcast.mock.calls.filter(
      ([, msg]) => (msg as { type: string }).type === 'socket:chat:aborted'
    );
    expect(abortedEvents.length).toBe(1);
  });
});
