/**
 * turnLoop — Stop while a tool call waits on its Approve/Deny confirmation.
 *
 * Drives one run through the real turn loop, tool dispatch and confirmation
 * module (only their leaf collaborators are stubbed): the model asks for a
 * guarded tool, the confirmation is parked, then the run's signal is aborted
 * the way AbortRunService does on Stop. Pins that the pane is told the prompt
 * closed (once), the call ends with a canceled result instead of no result,
 * the tool never runs, and the run itself still ends as a stopped run.
 */

// — Assertable handles (referenced inside jest.mock factories via wrappers) —
const wsBroadcast = jest.fn();
const wsSend = jest.fn();
const runsCreate = jest.fn();
const runsMarkFailed = jest.fn();
const trackerFinish = jest.fn();
const streamModelCallMock = jest.fn();
const assembleCtxMock = jest.fn();
const prepareCtxMock = jest.fn();
const logActivityMock = jest.fn();
const executeMock = jest.fn();
const emitAgentStatusMock = jest.fn();
const settleAskMock = jest.fn(async () => undefined);

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
    noteProgressForThread: jest.fn(),
    noteToolCall: jest.fn(),
    takeTurnSummary: jest.fn().mockReturnValue(null),
    finish: (...a: unknown[]) => trackerFinish(...a),
  },
}));

jest.mock('@server/services/PendingAgentMessageService', () => ({
  pendingAgentMessages: { enqueue: jest.fn(), clearAgent: jest.fn() },
}));

jest.mock('@server/services/LogsService', () => ({
  LogsService: {
    socket: { event: jest.fn(), error: jest.fn() },
    tool: { start: jest.fn(), end: jest.fn() },
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

jest.mock('@server/services/askNotifications', () => ({
  notifyToolApprovalAsk: jest.fn(() => ({
    notificationId: Promise.resolve('notification-1111111111111-aaaaaaaaa'),
    settle: settleAskMock,
  })),
  notifyClarificationAsk: jest.fn(),
}));

jest.mock('@server/services/ToolService/lib/resolveAgentCwd', () => ({
  resolveAgentCwd: jest.fn().mockResolvedValue('/tmp/agent-cwd'),
}));

jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSecretById: jest.fn().mockResolvedValue(null) },
}));

jest.mock('@server/services/ToolService', () => ({
  toolExecutor: { execute: (...a: unknown[]) => executeMock(...a) },
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/peerInjection', () => ({
  drainInjectablePeerMessages: jest.fn().mockReturnValue([]),
}));

jest.mock('@server/services/SocketService/handlers/chatHelpers', () => ({
  emitAgentStatus: (...a: unknown[]) => emitAgentStatusMock(...a),
  emitAgentTyping: jest.fn(),
  stripThinkingTags: (s: string) => ({ reply: s ?? '', thinking: '' }),
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
  handleFinalReply: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/midRunMessages', () => ({
  drainToolLoopMidRunMessages: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/promptBuilder', () => ({
  buildAssistantContentBlocks: jest.fn(() => []),
  buildPromptMessagesForIteration: jest.fn().mockResolvedValue([]),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/cacheFootprintTracker', () => ({
  estimateAbandonedCacheTokens: jest.fn(() => 0),
  recordCacheFootprint: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/utteranceMessages', () => ({
  persistUtterance: jest.fn().mockResolvedValue(undefined),
  routeSpokenMentions: jest.fn(),
}));

jest.mock('@server/services/SocketService/handlers/chatPhases/routeAllModeMidRunMessage', () => ({
  routeAllModeMidRunMessage: jest.fn(() => ({})),
  applyAllModeFanoutEffects: jest.fn(),
}));

jest.mock('@server/services/SocketService/voiceSession/voiceSessionRegistry', () => ({
  isThreadVoiceActive: jest.fn(() => false),
}));

jest.mock('@server/services/SocketService/voiceSession/voiceStreamEvents', () => ({
  emitVoiceDelta: jest.fn(),
}));

jest.mock('@server/services/subagents/turnGate', () => ({
  helperTurnHeld: jest.fn().mockResolvedValue(false),
}));

import { runAgentTurnLoop } from '@server/services/SocketService/handlers/chatPhases/turnLoop';
import { listPendingToolConfirmations } from '@server/services/SocketService/confirmation';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const THREAD_ID = 'thread-1';
const AGENT_ID = 'test-agent-a';
const CALL_ID = 'call-guarded-1';

type WsFrame = { type: string; payload: Record<string, unknown> };
type WsCall = [string, WsFrame];

function makeDeps(abortController: AbortController): RunAgentTurnDeps {
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

const AGENT = {
  id: AGENT_ID,
  name: 'Test Agent',
  provider: 'openai',
  modelId: 'test-model-a',
  credentialId: null,
  systemPrompt: '',
  disableModelFallback: false,
};

function guardedTool(): ResolvedAgentTool {
  return {
    agentId: AGENT_ID,
    tool: {
      id: 'guarded_tool',
      name: 'guarded_tool',
      description: '',
      type: 'builtin',
      parametersSchema: {},
      keywords: [],
      aliases: [],
    } as unknown as ResolvedAgentTool['tool'],
    settings: {},
    requiresConfirmation: true,
  };
}

function framesOfType(type: string): WsCall[] {
  return (wsBroadcast.mock.calls as WsCall[]).filter(
    ([channel, msg]) => channel === THREAD_ID && msg?.type === type
  );
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!predicate()) throw new Error('condition never became true');
}

beforeEach(() => {
  jest.clearAllMocks();
  runsCreate.mockResolvedValue(undefined);
  runsMarkFailed.mockResolvedValue(undefined);
  logActivityMock.mockResolvedValue(undefined);
  assembleCtxMock.mockResolvedValue({
    status: 'ready',
    agent: AGENT,
    agentTools: [],
    executionTools: [],
    advertisedTools: [],
    threadBlockedTools: [],
    toolAccess: { mode: 'all', allowList: [], denyList: [] },
    modelCandidates: [
      {
        provider_id: 'openai',
        model_id: 'test-model-a',
        credential_id: null,
        source: 'agent_default',
      },
    ],
    runtimeAgentTemplate: { ...AGENT, trustedToolCalls: false },
    systemBlocks: [],
    turnContextData: '',
    startedAt: Date.now(),
  });
  const tool = guardedTool();
  prepareCtxMock.mockResolvedValue({
    toolRows: [{ id: 'guarded_tool' }],
    threadBlockedToolMap: new Map(),
    toolMap: new Map([['guarded_tool', tool]]),
    visibleToolIds: new Set(['guarded_tool']),
    budget: { maxOutputTokens: 128, cacheTtl: '1h' },
    agentMessages: [],
    threadSummaryText: null,
    maxToolIterations: 4,
    shouldStreamThinking: false,
    compactionCarryForward: '',
    contextWatermark: null,
    currentRunBoundary: 0,
    visionAccessCandidate: null,
    historyFold: { removedMessages: 0, replacement: null },
  });
  streamModelCallMock.mockResolvedValue({
    result: {
      reply: '',
      toolCalls: [{ id: CALL_ID, name: 'guarded_tool', input: { target: 'a' } }],
      stopReason: 'tool_use',
    },
    emittedTyping: false,
    latestThinking: '',
  });
});

describe('turnLoop — Stop while a tool call waits on its confirmation', () => {
  it('closes the panel once, ends the call as canceled, and ends the run as stopped', async () => {
    const abortController = new AbortController();
    const turn = runAgentTurnLoop(makeDeps(abortController), makeShared(), AGENT_ID);

    await until(() => framesOfType('socket:tool:confirmation_request').length === 1);
    expect(listPendingToolConfirmations(THREAD_ID)).toHaveLength(1);

    // What AbortRunService.abortAgentRun hands the run's controller on Stop.
    abortController.abort({
      kind: 'agent_run_abort',
      targetAgentId: AGENT_ID,
      abortedBy: { actorKind: 'user', actorId: 'user-1', actorName: 'Test User' },
    });
    await turn;

    // The pane is told the prompt is gone, exactly once.
    expect(framesOfType('socket:tool:confirmation_timeout')).toEqual([
      [
        THREAD_ID,
        {
          type: 'socket:tool:confirmation_timeout',
          payload: { threadId: THREAD_ID, callId: CALL_ID, toolName: 'guarded_tool' },
        },
      ],
    ]);
    expect(listPendingToolConfirmations(THREAD_ID)).toEqual([]);
    expect(settleAskMock).toHaveBeenCalledTimes(1);

    // The call ends with a canceled result (live frame + activity row) and
    // never runs.
    const canceled =
      "Tool 'guarded_tool' was canceled — the run was stopped before it was confirmed.";
    const results = framesOfType('socket:tool:result');
    expect(results).toHaveLength(1);
    expect(results[0]![1].payload).toMatchObject({
      callId: CALL_ID,
      agentId: AGENT_ID,
      success: false,
      error: canceled,
    });
    const runId = results[0]![1].payload.runId;
    expect(typeof runId).toBe('string');
    expect(logActivityMock).toHaveBeenCalledTimes(1);
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT_ID,
        runId,
        actionType: 'tool_call',
        tool: 'guarded_tool',
        toolOutput: { error: canceled },
      })
    );
    expect(executeMock).not.toHaveBeenCalled();

    // The run ends the way any stopped run does: one model call, marked
    // aborted by the person who pressed Stop, released, back to idle, and no
    // error surfaced.
    expect(streamModelCallMock).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed).toHaveBeenCalledTimes(1);
    expect(runsMarkFailed.mock.calls[0]![0]).toBe(runId);
    expect(runsMarkFailed.mock.calls[0]![1]).toBe('Aborted by Test User');
    expect(trackerFinish).toHaveBeenCalledWith(runId);
    expect(framesOfType('socket:error')).toHaveLength(0);
    expect(emitAgentStatusMock).toHaveBeenLastCalledWith(
      'client-1',
      'session-1',
      AGENT_ID,
      'idle',
      expect.anything()
    );
  });
});
