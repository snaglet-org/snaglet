/**
 * turnLoop — in-run compaction end to end. A mocked provider keeps calling
 * tools until the run's own exchanges pass a small budget; the real prompt
 * builder, condenser, history compression and run compactor must fold the
 * run's oldest exchanges, keep going, and finish.
 *
 * Collaborators outside the context path are stubbed as in turnLoop.error.test.
 */

const wsBroadcast = jest.fn();
const wsSend = jest.fn();
const runsCreate = jest.fn();
const runsMarkFailed = jest.fn();
const streamModelCallMock = jest.fn();
const assembleCtxMock = jest.fn();
const prepareCtxMock = jest.fn();
const dispatchToolCallsMock = jest.fn();
const handleFinalReplyMock = jest.fn();
const logActivityMock = jest.fn();
const resolveUtilityModelMock = jest.fn();
const generateUtilityTextMock = jest.fn();
const logsWarn = jest.fn();
const loggerInfo = jest.fn();

jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...a: unknown[]) => wsBroadcast(...a),
    sendToClient: (...a: unknown[]) => wsSend(...a),
  },
}));

jest.mock('@snaglet/db/tables/runs', () => ({
  Runs: {
    create: (...a: unknown[]) => runsCreate(...a),
    markFailed: (...a: unknown[]) => runsMarkFailed(...a),
  },
}));

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: { getLastByThread: jest.fn(), listAfter: jest.fn() },
}));

jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { logActivity: (...a: unknown[]) => logActivityMock(...a) },
}));

jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    start: jest.fn(),
    noteProgress: jest.fn(),
    noteToolCall: jest.fn(),
    takeTurnSummary: jest.fn().mockReturnValue(null),
    finish: jest.fn(),
  },
}));

jest.mock('@server/services/PendingAgentMessageService', () => ({
  pendingAgentMessages: { enqueue: jest.fn(), clearAgent: jest.fn() },
}));

jest.mock('@server/services/LogsService', () => ({
  LogsService: {
    socket: { event: jest.fn(), error: jest.fn() },
    warn: (...a: unknown[]) => logsWarn(...a),
  },
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: (...a: unknown[]) => loggerInfo(...a), warn: jest.fn(), debug: jest.fn() },
}));

// Status/typing emitters stubbed; the real tool-result condenser runs.
jest.mock('@server/services/SocketService/handlers/chatHelpers', () => {
  const actual = jest.requireActual(
    '@server/services/SocketService/handlers/chatHelpers/toolResultCondense'
  );
  return {
    emitAgentStatus: jest.fn(),
    emitAgentTyping: jest.fn(),
    stripThinkingTags: (s: string) => ({ reply: s ?? '', thinking: '' }),
    condenseProcessedToolResults: actual.condenseProcessedToolResults,
    logLlmPayload: jest.fn(),
  };
});

jest.mock('@server/services/settings', () => ({
  settingsService: {
    read: jest.fn(async (def: { key?: string }) =>
      def?.key === 'tool_result_bulk_token_budget' ? 35_000 : 1_500
    ),
  },
}));

jest.mock('@server/services/SocketService/persistRunErrorMessage', () => ({
  persistRunErrorMessage: jest.fn().mockResolvedValue(null),
  classifyRunError: () => 'model_failure',
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/contextAssembly', () => ({
  assembleAgentTurnContext: (...a: unknown[]) => assembleCtxMock(...a),
  prepareModelAttemptContext: (...a: unknown[]) => prepareCtxMock(...a),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/llmStream', () => ({
  streamModelCall: (...a: unknown[]) => streamModelCallMock(...a),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/finalReply', () => ({
  handleFinalReply: (...a: unknown[]) => handleFinalReplyMock(...a),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/midRunMessages', () => ({
  drainToolLoopMidRunMessages: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/toolDispatch', () => ({
  dispatchToolCalls: (...a: unknown[]) => dispatchToolCallsMock(...a),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/cacheFootprintTracker', () => ({
  estimateAbandonedCacheTokens: jest.fn(() => 0),
  recordCacheFootprint: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/utteranceMessages', () => ({
  persistUtterance: jest.fn().mockResolvedValue('message-1'),
  routeSpokenMentions: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/routeAllModeMidRunMessage', () => ({
  routeAllModeMidRunMessage: jest.fn(() => ({})),
  applyAllModeFanoutEffects: jest.fn(),
}));

jest.mock('@server/services/SocketService/outboundMessageLinter', () => ({
  lintWorkspaceReferencesInMessage: jest.fn().mockResolvedValue({ issues: [] }),
}));

jest.mock('@server/services/SocketService/voiceSession/voiceSessionRegistry', () => ({
  isThreadVoiceActive: jest.fn(() => false),
}));

jest.mock('@server/services/SocketService/voiceSession/voiceStreamEvents', () => ({
  emitVoiceDelta: jest.fn(),
}));

jest.mock('@server/services/SocketService/voiceSession/floorArbiter', () => ({
  acquireGenerationFloor: jest.fn().mockResolvedValue('acquired'),
  releaseGenerationFloor: jest.fn(),
  releaseGenerationFloorAfterPlayback: jest.fn(),
}));

jest.mock('@server/services/summary/UtilityModelResolver', () => ({
  resolveUtilityModel: (...a: unknown[]) => resolveUtilityModelMock(...a),
}));

jest.mock('@server/services/summary/generateUtilityText', () => ({
  generateUtilityText: (...a: unknown[]) => generateUtilityTextMock(...a),
}));

import type { ContextBudget } from '@server/services/ContextWindowService';
import type { ProviderMessage } from '@server/services/ProviderChatService/types';
import { estimateSessionTokens } from '@server/services/TokenEstimator';
import { runAgentTurnLoop } from '@server/services/SocketService/handlers/chatPhases/turnLoop';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const THREAD_ID = 'thread-1111111111111-aaaaaaaa';
const AGENT_ID = 'test-agent-a';
const SUMMARY_HEADER = '[Earlier in this run, summarized]';
const BRIEF = 'Brief: split the parser into tokenize() and parse(), then run its tests.';
const SUMMARY =
  'Goal: split the parser.\nNext step: write the next file.\nFiles: src/file-0.ts — written.\n' +
  'Commands and results: None.\nDecisions: None.\nOpen errors: None.\nInstructions received: None.';
const TOOL_ITERATIONS = 24;

const budget: ContextBudget = {
  provider: 'test-provider',
  modelId: 'test-model',
  contextWindowTokens: 16_000,
  effectiveContextWindowTokens: 16_000,
  safetyMarginPct: 0,
  maxOutputTokens: 2_000,
  systemPromptTokens: 0,
  toolCatalogTokens: 0,
  overheadTokens: 0,
  overheadFloored: false,
  usableBudget: 10_000,
  tokenThreshold: 7_500,
  minMessagesBeforeCompression: 6,
  maxSummaryChars: 3_500,
  cacheTtl: '1h',
};

function makeDeps(abortController = new AbortController()): RunAgentTurnDeps {
  return {
    session: { threadId: THREAD_ID },
    sessionId: 'session-1',
    threadId: THREAD_ID,
    threadName: 'Test Thread',
    clientId: 'client-1',
    meta: { clientId: 'client-1' },
    isGroup: false,
    participantAgentIds: [AGENT_ID],
    activeRunIds: new Set<string>(),
    previewMessage: (v: string) => v,
    toToolText: (v: unknown) => String(v),
    triggerMessageId: undefined,
    wokenByMention: new Set<string>(),
    startAgent: () => {},
    HARD_DISPATCH_CEILING: 10,
    dispatchSet: new Set<string>([AGENT_ID]),
    abortController,
    agentNameMap: new Map<string, string>([[AGENT_ID, 'Test Agent']]),
    effectiveParallelDispatch: false,
    dispatchMode: 'all',
    threadRuntimeConfig: null,
    softDispatchThreshold: 5,
    hardDispatchCeiling: 10,
    agentTimeoutMs: 120000,
    wsService: { broadcastToChannel: wsBroadcast, sendToClient: wsSend },
  } as unknown as RunAgentTurnDeps;
}

function makeShared(): RunAgentTurnSharedState {
  return {
    runningAgents: new Set<string>(),
    agentMentionQueues: new Map<string, string[]>(),
    agentDispatchCount: new Map<string, number>(),
    agentSoftThresholdNotified: new Set<string>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    recentRepliesByAgent: new Map<string, string[]>(),
    stagnationStrikes: new Map<string, number>(),
    currentWaveResults: [],
    tokenTotals: { input: 0, output: 0 },
    conversationRound: 0,
  } as unknown as RunAgentTurnSharedState;
}

const READY_CTX = () => ({
  status: 'ready' as const,
  agent: { id: AGENT_ID, name: 'Test Agent', systemPrompt: '', disableModelFallback: false },
  agentTools: [],
  toolAccess: { mode: 'all', allowList: [], denyList: [] },
  modelCandidates: [
    {
      provider_id: 'test-provider',
      model_id: 'test-model',
      credential_id: null,
      source: 'agent_default',
    },
  ],
  runtimeAgentTemplate: {
    id: AGENT_ID,
    name: 'Test Agent',
    provider: 'test-provider',
    modelId: 'test-model',
    credentialId: null,
    systemPrompt: '',
    disableModelFallback: false,
  },
  systemBlocks: [],
  turnContextData: '',
  startedAt: Date.now(),
});

/** The run's starting payload: the brief and the ephemeral turn-context tail. */
const ATTEMPT_CTX = () => ({
  toolRows: [],
  toolMap: new Map(),
  threadBlockedToolMap: new Map(),
  visibleToolIds: new Set<string>(),
  budget,
  agentMessages: [
    { role: 'user', content: BRIEF },
    { role: 'user', content: '[turn context] coordinates', ephemeral: true },
  ] as ProviderMessage[],
  threadSummaryText: null,
  maxToolIterations: 40,
  shouldStreamThinking: false,
  compactionCarryForward: '',
  contextWatermark: null,
  currentRunBoundary: 0,
  visionAccessCandidate: null,
});

/** Payload snapshots, one per model call (the array itself is reused across calls). */
let payloads: ProviderMessage[][] = [];

function toolCallResult(n: number) {
  return {
    result: {
      reply: '',
      toolCalls: [
        {
          id: `call-${n}`,
          name: 'action',
          input: {
            tool: 'file_write',
            params: { path: `src/file-${n}.ts`, content: 'z'.repeat(1_200) },
          },
        },
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 1_000, outputTokens: 50 },
    },
    emittedTyping: false,
    latestThinking: '',
  };
}

function finalResult() {
  return {
    result: {
      reply: 'Done.',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1_000, outputTokens: 5 },
    },
    emittedTyping: false,
    latestThinking: '',
  };
}

function toolUseIds(messages: readonly ProviderMessage[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) if (block.type === 'tool_use') ids.push(block.id);
  }
  return ids;
}

function orphanToolResults(messages: readonly ProviderMessage[]): string[] {
  const seen = new Set(toolUseIds(messages));
  const orphans: string[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === 'tool_result' && !seen.has(block.tool_use_id))
        orphans.push(block.tool_use_id);
    }
  }
  return orphans;
}

function summaryMessages(messages: readonly ProviderMessage[]): ProviderMessage[] {
  return messages.filter(
    (m) => typeof m.content === 'string' && m.content.startsWith(SUMMARY_HEADER)
  );
}

beforeEach(() => {
  delete process.env.COMPACT_CONVERSATIONS;
  payloads = [];
  wsBroadcast.mockReset();
  wsSend.mockReset();
  runsCreate.mockReset().mockResolvedValue(undefined);
  runsMarkFailed.mockReset().mockResolvedValue(undefined);
  assembleCtxMock.mockReset().mockResolvedValue(READY_CTX());
  prepareCtxMock.mockReset().mockResolvedValue(ATTEMPT_CTX());
  handleFinalReplyMock.mockReset().mockResolvedValue(undefined);
  logActivityMock.mockReset().mockResolvedValue({});
  logsWarn.mockReset();
  loggerInfo.mockReset();
  resolveUtilityModelMock.mockReset().mockResolvedValue({
    ok: true,
    model: {
      providerId: 'test-provider',
      modelId: 'test-summary-model',
      credentialId: null,
      isLocal: false,
      maxInputChars: 60_000,
      timeoutMs: 60_000,
      source: 'own-model',
    },
  });
  generateUtilityTextMock.mockReset().mockResolvedValue(SUMMARY);
  let calls = 0;
  streamModelCallMock
    .mockReset()
    .mockImplementation(async ({ messagesForAgent }: { messagesForAgent: ProviderMessage[] }) => {
      payloads.push([...messagesForAgent]);
      calls++;
      return calls <= TOOL_ITERATIONS ? toolCallResult(calls) : finalResult();
    });
  dispatchToolCallsMock
    .mockReset()
    .mockImplementation(
      async (input: {
        result: { toolCalls: Array<{ id: string }> };
        agentMessages: ProviderMessage[];
      }) => {
        input.agentMessages.push({
          role: 'user',
          content: input.result.toolCalls.map((tc) => ({
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: `wrote ${tc.id} ${'o'.repeat(2_000)}`,
          })),
        });
        return { latestThinking: '' };
      }
    );
});

afterAll(() => {
  delete process.env.COMPACT_CONVERSATIONS;
});

function compactionRecords() {
  return logActivityMock.mock.calls
    .map((call) => call[0] as { tool?: string; toolOutput?: Record<string, unknown> })
    .filter((row) => row.tool === 'run_compaction');
}

describe('turnLoop — in-run compaction', () => {
  it('a run that outgrows the budget compacts itself, keeps going and finishes', async () => {
    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    // The run finished normally, after every tool iteration.
    expect(streamModelCallMock).toHaveBeenCalledTimes(TOOL_ITERATIONS + 1);
    expect(runsMarkFailed).not.toHaveBeenCalled();
    expect(handleFinalReplyMock).toHaveBeenCalledTimes(1);
    const finalInput = handleFinalReplyMock.mock.calls[0]![0] as { runCompactions: number };
    // 24 cycles against a 7.5k trigger: the run compacts more than once.
    expect(finalInput.runCompactions).toBeGreaterThanOrEqual(2);

    // Compaction happened, with the summary model, and was saved on the run.
    expect(generateUtilityTextMock).toHaveBeenCalledTimes(finalInput.runCompactions);
    const records = compactionRecords();
    expect(records).toHaveLength(finalInput.runCompactions);
    expect(records[0]!.toolOutput).toMatchObject({ output: SUMMARY, source: 'model' });
    expect(
      loggerInfo.mock.calls.filter((c) => String(c[0]).includes('[context] run compacted'))
    ).toHaveLength(finalInput.runCompactions);

    // Every payload: brief verbatim at the top, no orphaned tool cycle, never
    // more than one in-run summary.
    for (const payload of payloads) {
      expect(payload[0]).toEqual({ role: 'user', content: BRIEF });
      expect(orphanToolResults(payload)).toEqual([]);
      expect(summaryMessages(payload).length).toBeLessThanOrEqual(1);
    }

    // The first compacted payload: the oldest calls are gone, the newest kept.
    const firstCompacted = payloads.findIndex((p) => summaryMessages(p).length === 1);
    expect(firstCompacted).toBeGreaterThan(0);
    const after = payloads[firstCompacted]!;
    // Calls 1..firstCompacted were issued before this payload was built.
    const issued = Array.from({ length: firstCompacted }, (_, i) => `call-${i + 1}`);
    const kept = toolUseIds(after);
    expect(kept).not.toContain('call-1');
    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.length).toBeLessThanOrEqual(4);
    expect(issued.slice(-kept.length)).toEqual(kept);
    expect(estimateSessionTokens(after, '', 'test-provider')).toBeLessThan(budget.tokenThreshold);

    // The next iteration builds from the compacted array — same summary
    // message, no folded call back, no second summary call for it.
    const next = payloads[firstCompacted + 1]!;
    expect(summaryMessages(next)[0]).toBe(summaryMessages(after)[0]);
    expect(toolUseIds(next)).not.toContain('call-1');
    // No payload the model was sent is over the trigger.
    for (const payload of payloads) {
      expect(estimateSessionTokens(payload, '', 'test-provider')).toBeLessThanOrEqual(
        budget.tokenThreshold
      );
    }
  });

  it('keeps the run going on a digest when the summary model throws', async () => {
    generateUtilityTextMock.mockRejectedValue(new Error('summary model unavailable'));

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(handleFinalReplyMock).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed).not.toHaveBeenCalled();
    expect(logsWarn).toHaveBeenCalledWith(
      'run compaction fell back to a digest',
      expect.objectContaining({ reason: expect.stringContaining('summary model unavailable') })
    );
    const compacted = payloads.find((p) => summaryMessages(p).length === 1)!;
    expect(String(summaryMessages(compacted)[0]!.content)).toContain('Machine digest');
    expect(compactionRecords()[0]!.toolOutput).toMatchObject({ source: 'digest' });
  });

  it('a Stop during compaction ends the run through the abort path', async () => {
    const abortController = new AbortController();
    generateUtilityTextMock.mockImplementation(() => {
      abortController.abort();
      return new Promise(() => {});
    });

    await runAgentTurnLoop(makeDeps(abortController), makeShared(), AGENT_ID);

    expect(handleFinalReplyMock).not.toHaveBeenCalled();
    expect(runsMarkFailed).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed.mock.calls[0]![1]).toBe('Aborted by user');
    const aborted = (wsBroadcast.mock.calls as Array<[string, { type: string }]>).filter(
      ([, m]) => m.type === 'socket:chat:aborted'
    );
    expect(aborted).toHaveLength(1);
    expect(compactionRecords()).toHaveLength(0);
  });

  it('a run that stays under the threshold never compacts', async () => {
    let calls = 0;
    streamModelCallMock.mockImplementation(
      async ({ messagesForAgent }: { messagesForAgent: ProviderMessage[] }) => {
        payloads.push([...messagesForAgent]);
        calls++;
        return calls <= 3 ? toolCallResult(calls) : finalResult();
      }
    );

    await runAgentTurnLoop(makeDeps(), makeShared(), AGENT_ID);

    expect(resolveUtilityModelMock).not.toHaveBeenCalled();
    expect(compactionRecords()).toHaveLength(0);
    const finalInput = handleFinalReplyMock.mock.calls[0]![0] as { runCompactions: number };
    expect(finalInput.runCompactions).toBe(0);
    // Each payload is the plain run so far: brief, tail, then every exchange.
    expect(payloads[3]).toHaveLength(2 + 3 * 2);
  });
});
