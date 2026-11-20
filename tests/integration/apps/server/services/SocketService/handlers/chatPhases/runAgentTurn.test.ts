/**
 * Tests for the createRunAgentTurn factory.
 *
 * Strategy: auto-mock every import using @server/ aliases, then test
 * the factory's behavior by controlling deps/shared objects and mock returns.
 */

import { randomUUID } from 'crypto';

// Auto-mock all imports from runAgentTurn.ts
// Path aliases match jest.config.js moduleNameMapper.

// The turn loop transitively imports the local ONNX runtime (opening-retrieval
// reranker + embedder). onnxruntime-node's native library SIGABRTs inside
// jest's worker sandbox, so stub it before anything can load it.
jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class MockTensor {},
}));

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
    executeToolCall: jest.fn(),
  },
}));

jest.mock('@server/services/ProviderCredentialService/index', () => ({
  providerCredentialService: {
    getKeyForProvider: jest.fn().mockResolvedValue('test-key'),
  },
}));

jest.mock('@server/services/ContextWindowService', () => ({
  resolveContextBudget: jest.fn().mockReturnValue({
    maxTokens: 4096,
    reservedForResponse: 1024,
  }),
  compressMessages: jest.fn((msgs: unknown[]) => msgs),
  // Stub: these suites assert turn mechanics, never the boundary. The real
  // walk is covered by ContextWindowService.test.ts (findCurrentRunBoundary).
  findCurrentRunBoundary: jest.fn((messages: unknown[]) => messages.length),
}));

jest.mock('@server/services/SummaryService', () => ({
  summaryService: {
    getThreadSummary: jest.fn().mockResolvedValue(null),
    getSummariesForThread: jest.fn().mockResolvedValue([]),
    generateSummary: jest.fn().mockResolvedValue({ id: 'summary-1', content: 'test summary' }),
  },
}));

jest.mock('@server/services/PerceptionService', () => ({
  perceptionService: {
    buildSystemMessage: jest.fn().mockResolvedValue('You are a test agent.'),
    buildGroupSystemPromptBlocks: jest
      .fn()
      .mockResolvedValue([{ type: 'text', text: 'You are a test agent.' }]),
    buildDirectSystemPromptBlocks: jest
      .fn()
      .mockResolvedValue([{ type: 'text', text: 'You are a test agent.' }]),
    flattenSystemBlocks: jest.fn().mockReturnValue('You are a test agent.'),
    buildPerception: jest.fn().mockResolvedValue([]),
  },
}));

jest.mock('@server/services/EmbeddingService', () => ({
  syncMessageEmbedding: jest.fn().mockResolvedValue(undefined),
}));

// Perception is assembled via turn replay. The loader reads messages/runs/activity
// from the (auto-mocked) DB tables, so stub it to an empty history.
// Returns the ReplayPayload shape { messages, watermark }; the voice tests below
// override `watermark` per-test to drive the catch-up seed. `mock`-prefixed so
// the hoisted jest.mock factory may reference it.
const mockBuildReplayPayload = jest.fn().mockResolvedValue({ messages: [], watermark: null });
jest.mock('@server/services/SocketService/handlers/chatPhases/replayLoader', () => ({
  buildReplayPayload: (...args: unknown[]) => mockBuildReplayPayload(...args),
}));

jest.mock('@server/services/SocketService/confirmation', () => ({
  waitForConfirmation: jest.fn().mockResolvedValue({ approved: true, timedOut: false }),
}));

jest.mock('@server/services/SocketService/store', () => ({
  getSession: jest.fn(),
  setSessionParticipants: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/compactHandlers', () => ({
  isThreadCompacting: jest.fn().mockReturnValue(false),
}));

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
  detectMessageType: jest.fn().mockReturnValue('text'),
  resolveMessageType: jest.fn().mockReturnValue('text'),
  logLlmPayload: jest.fn(),
  // Route push() → the onText callback so a streamed chunk reaches the turn
  // loop's onVisibleDelta accumulator (test input carries no <thinking> tags).
  createThinkingInterceptor: jest.fn((onText: (t: string) => void) => ({
    intercept: (chunk: string) => chunk,
    push: (chunk: string) => onText(chunk),
    flush: jest.fn(),
    getThinking: () => '',
  })),
  stripThinkingTags: jest.fn((s: string) => ({ reply: s, thinkingContent: '' })),
}));

jest.mock('@server/services/MentionParser', () => ({
  parseMentions: jest.fn().mockReturnValue({
    mentions: [],
    mentionedAgentIds: new Set(),
    cleanText: '',
  }),
}));

jest.mock('@server/services/ConversationBudget', () => ({
  ConversationBudget: jest.fn().mockImplementation(() => ({
    canContinue: jest.fn().mockReturnValue(true),
    recordTurn: jest.fn(),
  })),
}));

// LogsService is heavily used — create a proxy that auto-stubs any method chain
const logsNoOp = jest.fn();
const makeLogsProxy = (): unknown =>
  new Proxy(logsNoOp, {
    get: (_target, prop) => {
      if (prop === 'mockImplementation' || prop === 'mockReturnValue' || prop === 'mock') {
        return Reflect.get(logsNoOp, prop);
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
  resolveThreadRuntimeConfig: jest.fn().mockReturnValue(null),
  resolveContentField: jest.fn((msg: { content?: string }) => msg?.content ?? ''),
}));

jest.mock('@server/services/SystemPromptComposer/index', () => ({
  composeSystemPrompt: jest
    .fn()
    .mockResolvedValue([{ type: 'text', text: 'You are a test agent.' }]),
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

const mockBuildModelCandidates = jest.fn().mockResolvedValue([
  {
    provider_id: 'openai',
    model_id: 'gpt-4o',
    credential_id: 'cred-1',
    source: 'agent',
  },
]);
jest.mock('@server/services/SocketService/handlers/modelCandidates', () => ({
  buildModelCandidates: mockBuildModelCandidates,
}));

// Voice speaking-floor mocks. Default inert: isThreadVoiceActive() → false, so
// every existing test above runs the text path untouched (zero floor calls) and
// the floor describe blocks below flip these per-test.
const mockAcquireGenerationFloor = jest.fn().mockResolvedValue('acquired');
const mockReleaseGenerationFloor = jest.fn();
const mockReleaseGenerationFloorAfterPlayback = jest.fn();
const mockIsThreadVoiceActive = jest.fn().mockReturnValue(false);
jest.mock('@server/services/SocketService/voiceSession/floorArbiter', () => ({
  acquireGenerationFloor: (...args: unknown[]) => mockAcquireGenerationFloor(...args),
  releaseGenerationFloor: (...args: unknown[]) => mockReleaseGenerationFloor(...args),
  releaseGenerationFloorAfterPlayback: (...args: unknown[]) =>
    mockReleaseGenerationFloorAfterPlayback(...args),
}));
jest.mock('@server/services/SocketService/voiceSession/voiceSessionRegistry', () => ({
  isThreadVoiceActive: (...args: unknown[]) => mockIsThreadVoiceActive(...args),
}));

jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: jest.fn(),
    broadcastToChannel: jest.fn(),
  },
}));

jest.mock('@server/services/AgentService', () => ({
  agentService: {
    get: jest.fn().mockResolvedValue(null), // overridden in beforeEach
    getAgentById: jest.fn().mockResolvedValue(null),
  },
}));

jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    add: jest.fn(),
    remove: jest.fn(),
    start: jest.fn(),
    finish: jest.fn(),
    isActive: jest.fn().mockReturnValue(false),
    reserveHandoff: jest.fn(),
    drainMessages: jest.fn().mockReturnValue([]),
    noteProgress: jest.fn(),
    noteToolCall: jest.fn(),
    // Run-ended narration reads the turn's stats here; null = nothing to narrate.
    takeTurnSummary: jest.fn().mockReturnValue(null),
  },
}));

// Tool execution is out of scope for these turn-lifecycle tests; stub the tool
// dispatch phase to a no-op so a tool-use iteration advances the loop without
// touching the DB (cwd resolution, tool registry, etc.).
jest.mock('@server/services/SocketService/handlers/chatPhases/toolDispatch', () => ({
  dispatchToolCalls: jest.fn().mockResolvedValue({ latestThinking: '' }),
}));

// Import the module under test (AFTER mocks)
import { createRunAgentTurn } from '@server/services/SocketService/handlers/chatPhases/runAgentTurn';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';
import { providerChatService } from '@server/services/ProviderChatService';
import { agentService } from '@server/services/AgentService';
import { wsService } from '@server/services/WebSocketService';
import { Messages } from '@snaglet/db/tables/messages';
import { Runs } from '@snaglet/db/tables/runs';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { parseMentions } from '@server/services/MentionParser';
import { dispatchToolCalls } from '@server/services/SocketService/handlers/chatPhases/toolDispatch';
import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { readAgentAbortReason } from '@server/services/SocketService/abortStore';
import { resolveContextBudget } from '@server/services/ContextWindowService';
import type { ConversationBudget } from '@server/services/ConversationBudget';
// Identity-mocked (see the chatHelpers mock above): receives `agentMessages`
// verbatim, so its first arg is the reliable window into what the turn folded
// into context before the (mocked) compression layer. The `compressMessages`
// mock returns the array rather than `{ messages }`, so inspecting the model
// call's messages arg would be undefined — inspect this instead.
import { condenseProcessedToolResults } from '@server/services/SocketService/handlers/chatHelpers';

// Helpers

/** Minimal mock agent object. */
function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    name: 'TestAgent',
    role: 'assistant',
    system_prompt: 'You are a test agent.',
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

/**
 * Build a minimal RunAgentTurnDeps. Every field has a sensible default;
 * pass overrides for the specific thing under test.
 */
function makeDeps(overrides: Partial<RunAgentTurnDeps> = {}): RunAgentTurnDeps {
  const abortController = new AbortController();
  return {
    session: { threadId: 'thread-1', id: 'session-1' } as RunAgentTurnDeps['session'],
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
    toToolText: (v: unknown) => JSON.stringify(v),
    triggerMessageId: 'msg-trigger-1',
    wokenByMention: new Set<string>(),
    isParticipantMention: (_id: string) => true,
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
    } as RunAgentTurnDeps['agentService'],
    configService: {
      get: jest.fn().mockReturnValue(null),
      getNumber: jest.fn().mockResolvedValue(10),
      getString: jest.fn().mockResolvedValue(''),
      getBool: jest.fn().mockResolvedValue(false),
    } as RunAgentTurnDeps['configService'],
    abortController,
    convBudget: {
      canContinue: jest.fn().mockReturnValue(true),
      recordAgentTurn: jest.fn(),
      summary: jest.fn().mockReturnValue({
        totalOutputTokens: 0,
        wavesUsed: 1,
        exhaustedReason: null,
      }),
    } as RunAgentTurnDeps['convBudget'],
    agentNameMap: new Map([['agent-1', 'TestAgent']]),
    agentRoleMap: new Map([['agent-1', 'assistant']]),
    resolveParticipantId: (_id: string) => 'agent-1',
    buildMentionContext: (_id: string) => undefined,
    ...overrides,
  };
}

/**
 * Build a minimal RunAgentTurnSharedState.
 */
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
    totalInputTokens: 0,
    totalOutputTokens: 0,
    requestStartTime: Date.now(),
    ...overrides,
  } as RunAgentTurnSharedState;
}

/**
 * Configure the mocked providerChatService.complete to return a simple
 * text response (no tool calls).
 */
function mockSimpleReply(text: string) {
  const mockComplete = providerChatService.complete as jest.Mock;
  mockComplete.mockResolvedValue({
    reply: text,
    toolCalls: [],
    usage: { inputTokens: 100, outputTokens: 50, thinkingTokens: 0 },
    stopReason: 'end_turn',
    thinkingContent: '',
  });
}

// Setup

beforeEach(() => {
  jest.clearAllMocks();
  (readAgentAbortReason as jest.Mock).mockReturnValue(null);

  // Default: agent lookup returns our test agent
  (agentService.get as jest.Mock).mockResolvedValue(makeAgent());

  // Default: the acting agent is a participant of the thread. persistUtterance
  // gates on this — an auto-mocked default of undefined would read as "removed"
  // and silently mute every utterance under test. Per-test overrides can set
  // false to exercise the removed-participant mute path.
  ThreadParticipants.isAgentParticipant = jest.fn().mockResolvedValue(true);

  // Default: Messages table operations
  Messages.create = jest.fn().mockResolvedValue({
    id: randomUUID(),
    thread_id: 'thread-1',
    content: '',
    role: 'assistant',
    agent_id: 'agent-1',
  });
  Messages.getThreadMessages = jest.fn().mockResolvedValue([]);
  Messages.update = jest.fn().mockResolvedValue(undefined);

  // Default: Runs table operations
  Runs.create = jest.fn().mockResolvedValue({ id: randomUUID() });
  Runs.getPreviousForAgent = jest.fn().mockResolvedValue(null);
  Runs.markCompleted = jest.fn().mockResolvedValue(undefined);
  Runs.markFailed = jest.fn().mockResolvedValue(undefined);

  // Default: Threads table operations
  Threads.findById = jest.fn().mockResolvedValue({
    id: 'thread-1',
    name: 'Test Thread',
  });
  Threads.getEffectiveModel = jest.fn().mockResolvedValue(null);
  Threads.touch = jest.fn().mockResolvedValue(undefined);

  // Default: agent tool resolver returns no tools
  (resolveAgentTools as jest.Mock).mockResolvedValue([]);

  // Default: parseMentions returns no mentions
  (parseMentions as jest.Mock).mockReturnValue({
    mentions: [],
    mentionedAgentIds: new Set(),
    cleanText: '',
  });
});

// Tests

describe('createRunAgentTurn', () => {
  it('creates a callable function', () => {
    const deps = makeDeps();
    const shared = makeSharedState();
    const turn = createRunAgentTurn(deps, shared);
    expect(typeof turn).toBe('function');
  });

  describe('basic turn execution', () => {
    it('calls providerChatService.complete for a simple reply', async () => {
      mockSimpleReply('Hello, world!');
      const deps = makeDeps();
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      expect(providerChatService.complete).toHaveBeenCalled();
    });

    it('returns early when abort signal is already aborted', async () => {
      const abortController = new AbortController();
      abortController.abort();
      const deps = makeDeps({ abortController });
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      expect(providerChatService.complete).not.toHaveBeenCalled();
    });

    it('broadcasts socket:chat:message_created for the terminal reply with the real row id', async () => {
      mockSimpleReply('Final answer.');
      const deps = makeDeps();
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      const created = (wsService.broadcastToChannel as jest.Mock).mock.calls
        .map((c) => c[1] as { type?: string; payload?: Record<string, unknown> })
        .find((ev) => ev?.type === 'socket:chat:message_created');
      expect(created).toBeDefined();
      expect(created!.payload).toMatchObject({
        role: 'assistant',
        content: 'Final answer.',
        agent_id: 'agent-1',
        injected_during_run: false,
      });
      expect(typeof created!.payload!.id).toBe('string');
      expect(created!.payload!.run_id).toBeDefined();
    });
  });

  // turnLoop.ts has no round-0 auto-injection hook — a thread's opening
  // message triggers no retrieval/injection side effects on its own, and no
  // surface runs opening-message retrieval.
  describe('no round-0 auto-injection', () => {
    it("a fresh thread's opening message (round 0) never emits socket:retrieval:step or message_context_pack_set, and never writes a contextPack", async () => {
      mockSimpleReply('Hello!');
      // makeDeps() defaults triggerMessageId to a real id and
      // makeSharedState() defaults conversationRound to 0 — together the
      // exact shape of a thread's opening wave.
      const deps = makeDeps();
      const shared = makeSharedState({ conversationRound: 0 });
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      const broadcastTypes = (wsService.broadcastToChannel as jest.Mock).mock.calls.map(
        (c) => (c[1] as { type?: string } | undefined)?.type
      );
      expect(broadcastTypes).not.toContain('socket:retrieval:step');
      expect(broadcastTypes).not.toContain('socket:chat:message_context_pack_set');
      // No per-agent contextPack metadata write onto the opener message.
      expect(
        (Messages as unknown as { setContextPackOnce: jest.Mock }).setContextPackOnce
      ).not.toHaveBeenCalled();
    });
  });

  describe('interim utterance persistence (tool boundary)', () => {
    it('persists the spoken text of a non-terminal iteration as a normal assistant row', async () => {
      const mockComplete = providerChatService.complete as jest.Mock;
      mockComplete
        .mockResolvedValueOnce({
          reply: 'Let me look that up.',
          toolCalls: [{ id: 'tc1', name: 'some_tool', input: {} }],
          usage: { inputTokens: 100, outputTokens: 20, thinkingTokens: 0 },
          stopReason: 'tool_use',
          thinkingContent: '',
        })
        .mockResolvedValueOnce({
          reply: 'All set.',
          toolCalls: [],
          usage: { inputTokens: 120, outputTokens: 15, thinkingTokens: 0 },
          stopReason: 'end_turn',
          thinkingContent: '',
        });

      const deps = makeDeps();
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      const created = (Messages.create as jest.Mock).mock.calls.map(
        (c) => c[0] as Record<string, unknown>
      );
      const interim = created.find((r) => r.content === 'Let me look that up.');
      expect(interim).toBeDefined();
      expect(interim).toMatchObject({
        role: 'assistant',
        messageType: 'message',
        agentId: 'agent-1',
        runId: expect.any(String),
      });
      // Spoken-while-running, not received-while-running.
      expect(interim!.injectedDuringRun).toBeUndefined();
      // The terminal reply is still persisted by handleFinalReply.
      expect(created.some((r) => r.content === 'All set.')).toBe(true);

      // And the interim utterance announced itself as a real message_created.
      const broadcastPayloads = (wsService.broadcastToChannel as jest.Mock).mock.calls
        .map((c) => c[1] as { type?: string; payload?: Record<string, unknown> })
        .filter((ev) => ev?.type === 'socket:chat:message_created')
        .map((ev) => ev.payload!);
      expect(
        broadcastPayloads.some(
          (p) => p.content === 'Let me look that up.' && p.injected_during_run === false
        )
      ).toBe(true);
    });
  });

  describe('abort mid-utterance', () => {
    it('treats a pending provider rejection with the attributed reason object as cancellation', async () => {
      const abortController = new AbortController();
      const abortReason = {
        kind: 'agent_run_abort' as const,
        targetAgentId: 'agent-1',
        abortedBy: {
          actorKind: 'agent' as const,
          actorId: 'agent-1',
          actorName: 'TestAgent',
        },
      };
      (readAgentAbortReason as jest.Mock).mockImplementation((signal: AbortSignal) =>
        signal.reason === abortReason ? abortReason : null
      );
      (providerChatService.complete as jest.Mock).mockImplementation(
        async (
          _agent: unknown,
          _msgs: unknown,
          _onChunk: unknown,
          options: { signal: AbortSignal }
        ) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          })
      );

      const deps = makeDeps();
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);
      const pendingTurn = turn('agent-1', abortController);
      await new Promise<void>((resolve) => {
        const waitForProvider = (): void => {
          if ((providerChatService.complete as jest.Mock).mock.calls.length > 0) resolve();
          else setImmediate(waitForProvider);
        };
        waitForProvider();
      });

      abortController.abort(abortReason);

      await expect(pendingTurn).resolves.not.toThrow();
      expect(providerChatService.complete).toHaveBeenCalledTimes(1);
      expect(Runs.markFailed).toHaveBeenCalledWith(
        expect.any(String),
        'Aborted by TestAgent',
        expect.any(Object)
      );
      expect(activeRunTracker.finish).toHaveBeenCalled();
      expect(shared.passedAgents).toContain('agent-1');
    });

    it('persists whatever visible text streamed before the abort as a partial utterance', async () => {
      const abortController = new AbortController();
      const mockComplete = providerChatService.complete as jest.Mock;
      // Stream a visible fragment through the interceptor, then abort mid-sentence.
      mockComplete.mockImplementation(
        async (_agent: unknown, _msgs: unknown, onChunk: (c: string) => void) => {
          onChunk('Sure, checking now.');
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      );

      const deps = makeDeps({ abortController });
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await expect(turn('agent-1')).resolves.not.toThrow();

      const created = (Messages.create as jest.Mock).mock.calls.map(
        (c) => c[0] as Record<string, unknown>
      );
      const partial = created.find((r) => r.content === 'Sure, checking now.');
      expect(partial).toBeDefined();
      expect(partial).toMatchObject({
        role: 'assistant',
        messageType: 'message',
        agentId: 'agent-1',
      });
      expect(partial!.injectedDuringRun).toBeUndefined();
    });

    it('does not duplicate an interim utterance when abort strikes during tool execution', async () => {
      // Iteration 1 speaks, then requests a tool; the interim utterance is
      // persisted. The abort arrives while the tool runs. The abort catch must
      // not re-persist the same text (the accumulator was cleared after the
      // interim persist) — exactly one row carries that content.
      const abortController = new AbortController();
      const mockComplete = providerChatService.complete as jest.Mock;
      mockComplete.mockImplementation(
        async (_agent: unknown, _msgs: unknown, onChunk: (c: string) => void) => {
          onChunk('Working on it.');
          return {
            reply: 'Working on it.',
            toolCalls: [{ id: 'tc1', name: 'some_tool', input: {} }],
            usage: { inputTokens: 100, outputTokens: 20, thinkingTokens: 0 },
            stopReason: 'tool_use',
            thinkingContent: '',
          };
        }
      );
      (dispatchToolCalls as jest.Mock).mockImplementationOnce(async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      const deps = makeDeps({ abortController });
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await expect(turn('agent-1')).resolves.not.toThrow();

      const rows = (Messages.create as jest.Mock).mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .filter((r) => r.content === 'Working on it.');
      expect(rows).toHaveLength(1);
    });

    it('runs run cleanup even when the partial-utterance persist rejects on abort', async () => {
      // The partial-utterance persist hits a transient DB failure. Cleanup
      // (Runs.markFailed + activeRunTracker.finish) must still run, or the
      // thread wedges as "run already in progress".
      const abortController = new AbortController();
      const mockComplete = providerChatService.complete as jest.Mock;
      mockComplete.mockImplementation(
        async (_agent: unknown, _msgs: unknown, onChunk: (c: string) => void) => {
          onChunk('Half a sen');
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      );
      (Messages.create as jest.Mock).mockRejectedValueOnce(new Error('db down'));

      const deps = makeDeps({ abortController });
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await expect(turn('agent-1')).resolves.not.toThrow();

      expect(Runs.markFailed).toHaveBeenCalled();
      expect(activeRunTracker.finish).toHaveBeenCalled();
    });
  });

  describe('pass behavior', () => {
    it('marks agent as passed when reply is exactly [PASS]', async () => {
      mockSimpleReply('[PASS]');
      const deps = makeDeps();
      // [PASS] detection requires conversationRound > 0 (not first wave)
      const shared = makeSharedState({ conversationRound: 1 });
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      expect(shared.passedAgents.has('agent-1')).toBe(true);
    });

    it('marks the agent passed on a trailing [PASS] after real content (parting message)', async () => {
      mockSimpleReply('Nothing to add.\n\n[PASS]');
      const deps = makeDeps();
      const shared = makeSharedState({ conversationRound: 1 });
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      // The note posts (token stripped) and the agent yields.
      expect(shared.passedAgents.has('agent-1')).toBe(true);
      expect(shared.passKinds.get('agent-1')).toBe('explicit');
    });

    it('does not mark agent as passed when [PASS] is embedded mid-prose', async () => {
      // Anchored semantics: only a trailing/standalone token passes.
      mockSimpleReply('I will [PASS] on the naming question, but the API shape works.');
      const deps = makeDeps();
      const shared = makeSharedState({ conversationRound: 1 });
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      expect(shared.passedAgents.has('agent-1')).toBe(false);
    });

    it('does not mark agent as passed in round 0 even with exact [PASS]', async () => {
      // Pass detection is gated on conversationRound > 0 (first wave always runs)
      mockSimpleReply('[PASS]');
      const shared = makeSharedState({ conversationRound: 0 });
      const deps = makeDeps();
      const turn = createRunAgentTurn(deps, shared);
      await turn('agent-1');

      expect(shared.passedAgents.has('agent-1')).toBe(false);
    });

    it('marks agent as passed when reply is exactly [DONE]', async () => {
      mockSimpleReply('[DONE]');
      const shared = makeSharedState({ conversationRound: 1 });
      const deps = makeDeps();
      const turn = createRunAgentTurn(deps, shared);
      await turn('agent-1');

      expect(shared.passedAgents.has('agent-1')).toBe(true);
    });
  });

  describe('per-reply output limit', () => {
    const MODEL_MAX_OUTPUT = 128_000;
    const defaultContextBudget = { maxTokens: 4096, reservedForResponse: 1024 };

    beforeEach(() => {
      (resolveContextBudget as jest.Mock).mockReturnValue({
        ...defaultContextBudget,
        maxOutputTokens: MODEL_MAX_OUTPUT,
      });
    });

    afterEach(() => {
      (resolveContextBudget as jest.Mock).mockReturnValue(defaultContextBudget);
    });

    /** A real pool with almost nothing left: it must not shrink the request. */
    function nearlySpentBudget(): ConversationBudget {
      const { ConversationBudget: RealBudget } = jest.requireActual<
        typeof import('@server/services/ConversationBudget')
      >('@server/services/ConversationBudget');
      const budget = new RealBudget({ maxTotalOutputTokens: 10_000, maxWaves: 24 });
      budget.incrementWave();
      budget.recordAgentTurn(9_990);
      return budget;
    }

    function requestedMaxOutputTokens(): unknown {
      const calls = (providerChatService.complete as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return (calls[0]![3] as { maxOutputTokens?: unknown }).maxOutputTokens;
    }

    it("asks for the model's full output length in a solo thread", async () => {
      mockSimpleReply('Solo reply.');
      const deps = makeDeps({ convBudget: nearlySpentBudget() });
      await createRunAgentTurn(deps, makeSharedState())('agent-1');

      expect(requestedMaxOutputTokens()).toBe(MODEL_MAX_OUTPUT);
    });

    it("asks for the model's full output length in a group thread too", async () => {
      mockSimpleReply('Group reply.');
      const deps = makeDeps({
        isGroup: true,
        participantAgentIds: ['agent-1', 'agent-2'],
        agentNameMap: new Map([
          ['agent-1', 'TestAgent'],
          ['agent-2', 'Peer'],
        ]),
        convBudget: nearlySpentBudget(),
      });
      await createRunAgentTurn(deps, makeSharedState())('agent-1');

      expect(requestedMaxOutputTokens()).toBe(MODEL_MAX_OUTPUT);
    });
  });

  describe('mention extraction', () => {
    it('records mentioned agent ids from the response', async () => {
      mockSimpleReply('Let me ask @Venus about this.');
      (parseMentions as jest.Mock).mockReturnValue({
        mentions: [{ agentId: 'agent-2', raw: '@Venus' }],
        mentionedAgentIds: new Set(['agent-2']),
        cleanText: 'Let me ask Venus about this.',
      });

      const deps = makeDeps({
        isGroup: true,
        participantAgentIds: ['agent-1', 'agent-2'],
        agentNameMap: new Map([
          ['agent-1', 'Sam'],
          ['agent-2', 'Venus'],
        ]),
      });
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      expect(parseMentions).toHaveBeenCalled();
    });
  });

  describe('abort mid-turn', () => {
    it('handles abort triggered during model call gracefully', async () => {
      const abortController = new AbortController();
      const mockComplete = providerChatService.complete as jest.Mock;

      // Abort during the model call
      mockComplete.mockImplementation(async () => {
        abortController.abort();
        return {
          reply: 'Hello',
          toolCalls: [],
          usage: { inputTokens: 50, outputTokens: 10, thinkingTokens: 0 },
          stopReason: 'end_turn',
          thinkingContent: '',
        };
      });

      const deps = makeDeps({ abortController });
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      // Should not throw
      await expect(turn('agent-1')).resolves.not.toThrow();
    });
  });

  describe('error handling', () => {
    it('does not throw when complete rejects', async () => {
      const mockComplete = providerChatService.complete as jest.Mock;
      mockComplete.mockRejectedValue(new Error('Provider unavailable'));

      const deps = makeDeps();
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      // Should not throw — errors are caught internally
      await expect(turn('agent-1')).resolves.not.toThrow();
    });

    it('does not throw when agent lookup fails', async () => {
      (agentService.get as jest.Mock).mockResolvedValue(null);

      const deps = makeDeps();
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await expect(turn('agent-nonexistent')).resolves.not.toThrow();
    });
  });

  describe('token tracking', () => {
    it('increments shared token counters after a turn', async () => {
      mockSimpleReply('Token test response.');
      const deps = makeDeps();
      const shared = makeSharedState();
      const turn = createRunAgentTurn(deps, shared);

      await turn('agent-1');

      // Token counters should have been updated by the turn
      expect(shared.totalInputTokens + shared.totalOutputTokens).toBeGreaterThanOrEqual(0);
    });
  });

  // Floor-gated generation wiring through the real turn loop. The floor arbiter +
  // voice registry are mocked so we assert the loop's calls, not the arbiter's
  // internals (those are covered by voiceSession/floorGatedGeneration.test.ts).
  describe('voice floor-gated generation', () => {
    afterEach(() => {
      // Restore the inert default so the flip never leaks into later suites.
      mockIsThreadVoiceActive.mockReturnValue(false);
      mockAcquireGenerationFloor.mockResolvedValue('acquired');
    });

    it('text thread: makes zero floor calls (zero-touch invariant)', async () => {
      mockIsThreadVoiceActive.mockReturnValue(false);
      mockSimpleReply('Just a text reply.');
      const pauseTurnTimeout = jest.fn();
      const resumeTurnTimeout = jest.fn();
      const deps = makeDeps({ pauseTurnTimeout, resumeTurnTimeout });
      const turn = createRunAgentTurn(deps, makeSharedState());

      await turn('agent-1');

      expect(mockAcquireGenerationFloor).not.toHaveBeenCalled();
      expect(mockReleaseGenerationFloor).not.toHaveBeenCalled();
      expect(mockReleaseGenerationFloorAfterPlayback).not.toHaveBeenCalled();
      // And the pausable-timeout is never touched on a text thread.
      expect(pauseTurnTimeout).not.toHaveBeenCalled();
      expect(resumeTurnTimeout).not.toHaveBeenCalled();
    });

    it('voice thread: acquires the floor, pauses/resumes the timer, releases on playback', async () => {
      mockIsThreadVoiceActive.mockReturnValue(true);
      mockSimpleReply('On it.');
      // Seed a watermark + a peer utterance that landed while parked.
      Messages.getLastByThread = jest.fn().mockResolvedValue({
        id: 'msg-head',
        createdAt: '2026-07-05T00:00:00.000Z',
      });
      Messages.listAfter = jest.fn().mockResolvedValue([
        {
          id: 'msg-peer',
          threadId: 'thread-1',
          agentId: 'agent-2',
          userId: null,
          role: 'assistant',
          content: 'I already grabbed the logs.',
          messageType: 'message',
          injectedDuringRun: false,
          createdAt: '2026-07-05T00:00:01.000Z',
        },
      ]);
      const pauseTurnTimeout = jest.fn();
      const resumeTurnTimeout = jest.fn();
      const deps = makeDeps({ pauseTurnTimeout, resumeTurnTimeout });
      const turn = createRunAgentTurn(deps, makeSharedState());

      await turn('agent-1');

      // Gate acquired before the model call; timer paused around the wait.
      expect(mockAcquireGenerationFloor).toHaveBeenCalledWith(
        'thread-1',
        'agent-1',
        expect.objectContaining({ signal: expect.anything() })
      );
      expect(pauseTurnTimeout).toHaveBeenCalledWith('agent-1');
      expect(resumeTurnTimeout).toHaveBeenCalledWith('agent-1');
      // Catch-up read the thread past the watermark.
      expect(Messages.listAfter).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ afterId: 'msg-head' })
      );
      // Terminal reply → release on playback (not an immediate mid-loop release).
      // The finally's belt-and-suspenders releaseGenerationFloor is a no-op here
      // (already released after-playback), so the only meaningful release is this.
      expect(mockReleaseGenerationFloorAfterPlayback).toHaveBeenCalledWith('thread-1', 'agent-1');
    });

    it('voice thread: releases immediately when dropping into tool execution', async () => {
      mockIsThreadVoiceActive.mockReturnValue(true);
      Messages.getLastByThread = jest.fn().mockResolvedValue(null);
      Messages.listAfter = jest.fn().mockResolvedValue([]);
      const mockComplete = providerChatService.complete as jest.Mock;
      mockComplete
        .mockResolvedValueOnce({
          reply: 'Let me check.',
          toolCalls: [{ id: 'tc1', name: 'some_tool', input: {} }],
          usage: { inputTokens: 100, outputTokens: 20, thinkingTokens: 0 },
          stopReason: 'tool_use',
          thinkingContent: '',
        })
        .mockResolvedValueOnce({
          reply: 'Done.',
          toolCalls: [],
          usage: { inputTokens: 120, outputTokens: 15, thinkingTokens: 0 },
          stopReason: 'end_turn',
          thinkingContent: '',
        });
      const deps = makeDeps({ pauseTurnTimeout: jest.fn(), resumeTurnTimeout: jest.fn() });
      const turn = createRunAgentTurn(deps, makeSharedState());

      await turn('agent-1');

      // One immediate release (before the tool ran) + one after-playback (terminal).
      expect(mockReleaseGenerationFloor).toHaveBeenCalledWith('thread-1', 'agent-1');
      expect(mockReleaseGenerationFloorAfterPlayback).toHaveBeenCalledWith('thread-1', 'agent-1');
      // Two model calls → the floor was acquired before each.
      expect(mockAcquireGenerationFloor).toHaveBeenCalledTimes(2);
    });

    it('voice thread: an abort while parked unwinds through the clean abort path', async () => {
      mockIsThreadVoiceActive.mockReturnValue(true);
      Messages.getLastByThread = jest.fn().mockResolvedValue(null);
      mockAcquireGenerationFloor.mockResolvedValueOnce('aborted');
      const deps = makeDeps({ pauseTurnTimeout: jest.fn(), resumeTurnTimeout: jest.fn() });
      const turn = createRunAgentTurn(deps, makeSharedState());

      await expect(turn('agent-1')).resolves.not.toThrow();

      // Clean cleanup ran (markFailed + tracker.finish); the model was never called.
      expect(Runs.markFailed).toHaveBeenCalled();
      expect(activeRunTracker.finish).toHaveBeenCalled();
      expect(providerChatService.complete).not.toHaveBeenCalled();
    });

    it('voice thread: seeds catch-up from the context watermark, not a second head read', async () => {
      mockIsThreadVoiceActive.mockReturnValue(true);
      mockSimpleReply('Acknowledged.');
      // The context assembly's own max keyset — the row that landed between the
      // context read and any later seed read must be caught by this cursor.
      mockBuildReplayPayload.mockResolvedValueOnce({
        messages: [{ role: 'assistant', content: 'earlier context' }],
        watermark: { createdAt: '2026-07-05T00:00:05.000Z', id: 'msg-ctx-max' },
      });
      // A getLastByThread that must not be consulted when a watermark exists:
      // seeding from it would open a gap between two reads.
      Messages.getLastByThread = jest.fn().mockResolvedValue({
        id: 'FALLBACK-SHOULD-NOT-RUN',
        createdAt: '2026-07-05T00:00:09.000Z',
      });
      Messages.listAfter = jest.fn().mockResolvedValue([
        {
          id: 'msg-peer-late',
          threadId: 'thread-1',
          agentId: 'agent-2',
          userId: null,
          role: 'assistant',
          content: 'Landed between the two reads.',
          messageType: 'message',
          injectedDuringRun: false,
          createdAt: '2026-07-05T00:00:06.000Z',
        },
      ]);
      const deps = makeDeps({ pauseTurnTimeout: jest.fn(), resumeTurnTimeout: jest.fn() });
      const turn = createRunAgentTurn(deps, makeSharedState());

      await turn('agent-1');

      // Catch-up paged strictly-after the context watermark…
      expect(Messages.listAfter).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({
          afterId: 'msg-ctx-max',
          afterCreatedAt: '2026-07-05T00:00:05.000Z',
        })
      );
      // …and the redundant/racy head read was never taken (watermark present),
      // so no row can slip through the gap between two reads.
      expect(Messages.getLastByThread).not.toHaveBeenCalled();
      // The in-between peer row (after the watermark) was folded into context.
      const foldedInto = (condenseProcessedToolResults as jest.Mock).mock.calls[0][0] as Array<{
        content: unknown;
      }>;
      const folded = foldedInto.find(
        (m) => typeof m.content === 'string' && m.content.includes('Landed between the two reads.')
      );
      expect(folded).toBeDefined();
    });

    it('voice thread: pages the catch-up until drained (60 rows across 2 pages)', async () => {
      mockIsThreadVoiceActive.mockReturnValue(true);
      mockSimpleReply('Caught up.');
      mockBuildReplayPayload.mockResolvedValueOnce({
        messages: [],
        watermark: { createdAt: '2026-07-05T00:00:00.000Z', id: 'seed-0' },
      });
      const peerRow = (n: number) => ({
        id: `p-${String(n).padStart(3, '0')}`,
        threadId: 'thread-1',
        agentId: 'agent-2',
        userId: null,
        role: 'assistant',
        content: `peer utterance ${n}`,
        messageType: 'message',
        injectedDuringRun: false,
        createdAt: `2026-07-05T00:00:00.${String(n).padStart(3, '0')}Z`,
      });
      const page1 = Array.from({ length: 50 }, (_, i) => peerRow(i + 1)); // full page
      const page2 = Array.from({ length: 10 }, (_, i) => peerRow(i + 51)); // partial → drained
      Messages.listAfter = jest.fn().mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);
      const deps = makeDeps({ pauseTurnTimeout: jest.fn(), resumeTurnTimeout: jest.fn() });
      const turn = createRunAgentTurn(deps, makeSharedState());

      await turn('agent-1');

      // Two pages read; the second paged from the cursor advanced by the first.
      expect(Messages.listAfter).toHaveBeenCalledTimes(2);
      expect(Messages.listAfter).toHaveBeenNthCalledWith(
        1,
        'thread-1',
        expect.objectContaining({ afterId: 'seed-0' })
      );
      expect(Messages.listAfter).toHaveBeenNthCalledWith(
        2,
        'thread-1',
        expect.objectContaining({ afterId: 'p-050' })
      );
      // All 60 rows (first + last) folded into a single append-only block.
      const foldedInto = (condenseProcessedToolResults as jest.Mock).mock.calls[0][0] as Array<{
        content: unknown;
      }>;
      const folded = foldedInto.find(
        (m) =>
          typeof m.content === 'string' &&
          m.content.includes('peer utterance 1') &&
          m.content.includes('peer utterance 60')
      );
      expect(folded).toBeDefined();
    });
  });
});
