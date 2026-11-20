/**
 * mentionRouter policy tests — one per branch, covering the drift cases:
 *  - ceiling-dropped mentions must resolve the client's pending bubble
 *  - non-participant mentions must broadcast chat:mention-skipped
 *    (including all-mode)
 *  - mention-woken agents must receive the soft-threshold marking
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  RunAgentTurnDeps,
  RunAgentTurnSharedState,
} from '@server/services/SocketService/handlers/chatPhases/types';

const mockParseMentions =
  jest.fn<() => { mentionedAgentIds: string[]; hasMentions: boolean; rawMentions: string[] }>();
const mockReserveHandoff = jest.fn();

jest.mock('@server/services/MentionParser', () => ({
  parseMentions: (...args: unknown[]) => mockParseMentions(...(args as [])),
}));
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    reserveHandoff: (...args: unknown[]) => mockReserveHandoff(...(args as [])),
  },
}));

import {
  resolveAllModeTargets,
  routeMentions,
} from '@server/services/SocketService/handlers/chatPhases/mentionRouter';
import { pendingAgentMessages } from '@server/services/PendingAgentMessageService';

const PARTICIPANTS = ['agent-nova', 'agent-max', 'agent-self'];

function makeDeps(overrides: Record<string, unknown> = {}): RunAgentTurnDeps {
  return {
    session: { threadId: 'thread-1' },
    sessionId: 'session-1',
    threadName: 'Test thread',
    participantAgentIds: PARTICIPANTS,
    agentNameMap: new Map([
      ['agent-nova', 'Nova'],
      ['agent-max', 'Max'],
      ['agent-self', 'Self'],
    ]),
    resolveParticipantId: (id: string) => (PARTICIPANTS.includes(id) ? id : undefined),
    isParticipantMention: (id: string) => PARTICIPANTS.includes(id),
    startAgent: jest.fn(),
    HARD_DISPATCH_CEILING: 10,
    softDispatchThreshold: 5,
    dispatchSet: new Set<string>(),
    wokenByMention: new Set<string>(),
    effectiveParallelDispatch: true,
    dispatchMode: 'mentioned',
    wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
    ...overrides,
  } as unknown as RunAgentTurnDeps;
}

function makeShared(overrides: Record<string, unknown> = {}): RunAgentTurnSharedState {
  return {
    runningAgents: new Set<string>(),
    agentDispatchCount: new Map<string, number>(),
    passedAgents: new Set<string>(),
    passKinds: new Map(),
    recentRepliesByAgent: new Map(),
    stagnationStrikes: new Map(),
    agentSoftThresholdNotified: new Set<string>(),
    ...overrides,
  } as unknown as RunAgentTurnSharedState;
}

const SENDER = { agentId: 'agent-self', name: 'Self', modelId: 'test-model' };

function route(deps: RunAgentTurnDeps, shared: RunAgentTurnSharedState) {
  return routeMentions({
    deps,
    shared,
    content: 'hello @Nova',
    replyAgentId: 'agent-self',
    sender: SENDER,
    queueReason: 'mentioned',
    logContext: 'test',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  pendingAgentMessages.resetForTests();
});

describe('routeMentions', () => {
  it('wakes an idle under-cap participant into the wave', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps();
    const shared = makeShared({ passedAgents: new Set(['agent-nova']) });

    const outcome = route(deps, shared);

    expect(outcome.woke).toEqual(['agent-nova']);
    expect(deps.dispatchSet.has('agent-nova')).toBe(true);
    expect(deps.wokenByMention.has('agent-nova')).toBe(true);
    expect(shared.passedAgents.has('agent-nova')).toBe(false);
    expect(deps.startAgent).toHaveBeenCalledWith('agent-nova');
    expect(mockReserveHandoff).toHaveBeenCalledWith('thread-1', 'mention-handoff');
  });

  it('marks a mention-woken agent past the soft threshold for discernment guidance', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps();
    const shared = makeShared({ agentDispatchCount: new Map([['agent-nova', 6]]) });

    const outcome = route(deps, shared);

    expect(outcome.woke).toEqual(['agent-nova']);
    expect(shared.agentSoftThresholdNotified.has('agent-nova')).toBe(true);
  });

  it('queues into a running agent instead of waking it', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps();
    const shared = makeShared({ runningAgents: new Set(['agent-nova']) });

    const outcome = route(deps, shared);

    expect(outcome.queued).toEqual(['agent-nova']);
    const queued = pendingAgentMessages.listUnread('thread-1', 'agent-nova');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      senderAgentId: 'agent-self',
      senderName: 'Self',
      reason: 'mentioned',
      content: 'hello @Nova',
    });
    expect(deps.dispatchSet.has('agent-nova')).toBe(false);
  });

  it('resolves the pending bubble when a mention is dropped at the ceiling', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova'],
      hasMentions: true,
      rawMentions: ['@Nova'],
    });
    const deps = makeDeps();
    const shared = makeShared({ agentDispatchCount: new Map([['agent-nova', 10]]) });

    const outcome = route(deps, shared);

    expect(outcome.limited).toEqual(['agent-nova']);
    expect(deps.wsService.broadcastToChannel).toHaveBeenCalledWith('thread-1', {
      type: 'socket:done',
      payload: {
        sessionId: 'session-1',
        reply: '',
        durationMs: 0,
        agentId: 'agent-nova',
        passed: true,
      },
    });
    expect(deps.dispatchSet.has('agent-nova')).toBe(false);
  });

  it('broadcasts chat:mention-skipped for a non-participant', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-ghost'],
      hasMentions: true,
      rawMentions: ['@Ghost'],
    });
    const deps = makeDeps();

    const outcome = route(deps, makeShared());

    expect(outcome.skipped).toEqual(['agent-ghost']);
    expect(deps.wsService.broadcastToChannel).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        type: 'chat:mention-skipped',
        payload: expect.objectContaining({
          mentionedAgentId: 'agent-ghost',
          mentionerAgentId: 'agent-self',
          reason: 'not-participant',
        }),
      })
    );
  });

  it('reports a self-mention without routing it', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-self'],
      hasMentions: true,
      rawMentions: ['@Self'],
    });
    const deps = makeDeps();

    const outcome = route(deps, makeShared());

    expect(outcome.targetedSelf).toBe(true);
    expect(outcome.woke).toEqual([]);
    expect(deps.wsService.broadcastToChannel).not.toHaveBeenCalled();
  });

  it('no-ops on content with no mentions', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: [],
      hasMentions: false,
      rawMentions: [],
    });
    const deps = makeDeps();

    const outcome = route(deps, makeShared());

    expect(outcome).toEqual({
      woke: [],
      queued: [],
      skipped: [],
      limited: [],
      targetedSelf: false,
    });
    expect(deps.wsService.broadcastToChannel).not.toHaveBeenCalled();
  });
});

describe('resolveAllModeTargets', () => {
  it('narrows to resolved participants and reports unresolved mentions as skipped', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: ['agent-nova', 'agent-ghost'],
      hasMentions: true,
      rawMentions: ['@Nova', '@Ghost'],
    });
    const deps = makeDeps({ dispatchMode: 'all' });

    const route = resolveAllModeTargets({
      deps,
      content: '@Nova @Ghost look at this',
      replyAgentId: 'agent-self',
      sender: SENDER,
    });

    expect(route.targetAgentIds).toEqual(['agent-nova']);
    expect(route.unresolvedMentionIds).toEqual(['agent-ghost']);
    expect(deps.wsService.broadcastToChannel).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ type: 'chat:mention-skipped' })
    );
  });

  it('keeps the open floor when no mentions are present', () => {
    mockParseMentions.mockReturnValue({
      mentionedAgentIds: [],
      hasMentions: false,
      rawMentions: [],
    });
    const deps = makeDeps({ dispatchMode: 'all' });

    const route = resolveAllModeTargets({
      deps,
      content: 'no mentions here',
      replyAgentId: 'agent-self',
      sender: SENDER,
    });

    expect(route.targetAgentIds).toEqual(PARTICIPANTS);
    expect(route.unresolvedMentionIds).toEqual([]);
    expect(deps.wsService.broadcastToChannel).not.toHaveBeenCalled();
  });
});
