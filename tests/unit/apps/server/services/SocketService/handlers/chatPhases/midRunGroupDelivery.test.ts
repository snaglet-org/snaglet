/**
 * End-to-end mid-run delivery between two agents in a `mentioned` thread, through
 * the real code on both sides: Ada's spoken text goes through routeSpokenMentions
 * (what holds or queues it for a running teammate) and Bo's tool loop goes
 * through dispatchToolCalls (what appends it to Bo's next request).
 *
 * The scenario: Bo is mid-run, calling tools. Ada talks twice without tagging
 * him, then tags him, then talks once more. Bo must hear nothing until the tag,
 * then get the earlier talk and the tag together in order, and the last remark
 * must wait for his next delivery.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

// EmbeddingService transitively loads the ONNX runtime, which SIGABRTs inside
// jest's worker sandbox — stub it before anything can pull it in.
jest.mock('onnxruntime-node', () => ({
  InferenceSession: { create: jest.fn() },
  Tensor: class MockTensor {},
}));

const mockParseMentions =
  jest.fn<() => { mentionedAgentIds: string[]; hasMentions: boolean; rawMentions: string[] }>();
const mockExecute = jest.fn();

jest.mock('@server/services/MentionParser', () => ({
  parseMentions: (...args: unknown[]) => mockParseMentions(...(args as [])),
}));
jest.mock('@server/services/EmbeddingService', () => ({ syncMessageEmbedding: jest.fn() }));
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));
jest.mock('@snaglet/db/tables/messages', () => ({ Messages: { create: jest.fn() } }));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: { isAgentParticipant: jest.fn(async () => true) },
}));
jest.mock('@server/services/ToolService/lib/resolveAgentCwd', () => ({
  resolveAgentCwd: jest.fn().mockResolvedValue('/tmp'),
}));
jest.mock('@server/services/ToolService', () => ({
  toolExecutor: { execute: (...args: unknown[]) => mockExecute(...args) },
}));
jest.mock('@server/services/SocketService/confirmation', () => ({
  waitForConfirmation: jest.fn(),
}));
jest.mock('@snaglet/db/tables/agent_activity_log', () => ({
  AgentActivityLog: { logActivity: jest.fn().mockResolvedValue({}) },
}));

import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';
import { routeSpokenMentions } from '@server/services/SocketService/handlers/chatPhases/utteranceMessages';
import {
  dispatchToolCalls,
  type DispatchToolCallsInput,
} from '@server/services/SocketService/handlers/chatPhases/toolDispatch';
import type { Message } from '@server/services/SocketService/types';

const THREAD = 'thread-group';
const ADA = { id: 'agent-ada', name: 'Ada' };
const BO = { id: 'agent-bo', name: 'Bo' };
const PARTICIPANTS = [ADA.id, BO.id];

const deps = {
  session: { threadId: THREAD },
  sessionId: 'session-1',
  threadName: 'Billing cleanup',
  isGroup: true,
  dispatchMode: 'mentioned',
  participantAgentIds: PARTICIPANTS,
  agentNameMap: new Map([
    [ADA.id, ADA.name],
    [BO.id, BO.name],
  ]),
  resolveParticipantId: (id: string) => (PARTICIPANTS.includes(id) ? id : undefined),
  isParticipantMention: (id: string) => PARTICIPANTS.includes(id),
  startAgent: jest.fn(),
  HARD_DISPATCH_CEILING: 10,
  softDispatchThreshold: 5,
  dispatchSet: new Set<string>(),
  wokenByMention: new Set<string>(),
  effectiveParallelDispatch: true,
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
} as unknown as RunAgentTurnDeps;

// Both agents are mid-run.
const shared = {
  runningAgents: new Set([ADA.id, BO.id]),
  agentDispatchCount: new Map<string, number>(),
  passedAgents: new Set<string>(),
  passKinds: new Map(),
  recentRepliesByAgent: new Map(),
  stagnationStrikes: new Map(),
  agentSoftThresholdNotified: new Set<string>(),
} as unknown as RunAgentTurnSharedState;

/** Ada says something; `tags` are the agent ids her text mentions. */
function adaSays(content: string, tags: string[] = []) {
  mockParseMentions.mockReturnValue({
    mentionedAgentIds: tags,
    hasMentions: tags.length > 0,
    rawMentions: tags.map((t) => `@${t}`),
  });
  routeSpokenMentions({
    deps,
    shared,
    agent: ADA as never,
    runtimeAgent: { ...ADA, modelId: 'test-model' } as never,
    replyAgentId: ADA.id,
    content,
    fanOutAllModeMidRunMessage: jest.fn(),
    logContext: 'utterance',
  });
}

/** Bo finishes one tool call; returns the user turn his next request will carry. */
async function boFinishesAToolCall(): Promise<Array<{ type?: string; text?: string }>> {
  mockExecute.mockResolvedValue({ success: true, output: 'done', durationMs: 1 });
  const agentMessages: Message[] = [];
  const resolved = {
    agentId: BO.id,
    tool: { id: 'some_tool', name: 'Some Tool', type: 'builtin' },
    settings: {},
    requiresConfirmation: false,
  };
  await dispatchToolCalls({
    result: {
      reply: '',
      toolCalls: [{ id: 'call-1', name: 'some_tool', input: {} }],
      stopReason: 'tool_use',
    } as DispatchToolCallsInput['result'],
    agent: BO as DispatchToolCallsInput['agent'],
    runtimeAgent: {
      provider: 'anthropic',
      modelId: 'claude',
      credentialId: null,
    } as DispatchToolCallsInput['runtimeAgent'],
    agentMessages,
    toolMap: new Map([['some_tool', resolved]]),
    visibleToolIds: new Set(['some_tool']),
    session: { threadId: THREAD } as DispatchToolCallsInput['session'],
    sessionId: 'session-1',
    threadName: 'Billing cleanup',
    runId: 'run-bo',
    triggerMessageId: undefined,
    latestThinking: '',
    toToolText: (value: unknown) => String(value),
    dispatchMode: 'mentioned',
    toolAccess: { mode: 'all', allowList: [], denyList: [] },
  } as DispatchToolCallsInput);
  return agentMessages[agentMessages.length - 1]!.content as Array<{
    type?: string;
    text?: string;
  }>;
}

const texts = (blocks: Array<{ type?: string; text?: string }>) =>
  blocks.filter((b) => b.type === 'text').map((b) => b.text);

describe('mid-run delivery between two agents (mentioned mode)', () => {
  beforeEach(() => {
    pendingAgentMessages.resetForTests();
    jest.clearAllMocks();
  });

  it('the running agent hears nothing until a teammate tags it; then the earlier talk and the tag arrive together, in order', async () => {
    // 1. Ada talks, not tagging Bo. His next request is a plain tool_result turn.
    adaSays('Starting the audit now.');
    const first = await boFinishesAToolCall();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: 'tool_result' });
    expect(pendingAgentMessages.listUnread(THREAD, BO.id)).toHaveLength(1); // held

    // 2. Ada talks again, then tags Bo.
    adaSays('Found 14 broken links in Invoices.');
    adaSays('@Bo the list is up. Start with section 2.', [BO.id]);
    const second = await boFinishesAToolCall();
    expect(second[0]).toMatchObject({ type: 'tool_result' });
    expect(texts(second)).toEqual([
      '[message from Ada] Starting the audit now.',
      '[message from Ada] Found 14 broken links in Invoices.',
      '[message from Ada] @Bo the list is up. Start with section 2.',
    ]);
    expect(pendingAgentMessages.listUnread(THREAD, BO.id)).toHaveLength(0);

    // 3. A remark after the tag waits for the next delivery.
    adaSays('Side note: Refunds looks fine.');
    const third = await boFinishesAToolCall();
    expect(texts(third)).toEqual([]);
    expect(pendingAgentMessages.listUnread(THREAD, BO.id).map((m) => m.content)).toEqual([
      'Side note: Refunds looks fine.',
    ]);
  });

  it('adds no untrusted-content notice or closing marker to what the running agent reads', async () => {
    adaSays('@Bo ping', [BO.id]);
    const blocks = await boFinishesAToolCall();
    const joined = texts(blocks).join('\n');
    expect(joined).toBe('[message from Ada] @Bo ping');
    expect(joined).not.toMatch(/untrusted|Mid-run|\[\//i);
  });

  it('the speaking agent never receives its own words', async () => {
    adaSays('Talking to myself.');
    expect(pendingAgentMessages.listUnread(THREAD, ADA.id)).toEqual([]);
  });
});
