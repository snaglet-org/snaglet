const releaseTurnFramesMock = jest.fn();
const markAccessSeenMock = jest.fn();
jest.mock('@server/services/vision/VisionThreadService', () => ({
  visionThreadService: {
    releaseTurnFrames: (...args: unknown[]) => releaseTurnFramesMock(...args),
    markAccessSeen: (...args: unknown[]) => markAccessSeenMock(...args),
  },
}));
const clearAgentMock = jest.fn();
jest.mock('@server/services/PendingAgentMessageService', () => ({
  pendingAgentMessages: { clearAgent: (...args: unknown[]) => clearAgentMock(...args) },
}));
const releaseGenerationFloorMock = jest.fn();
jest.mock('@server/services/SocketService/voiceSession/floorArbiter', () => ({
  releaseGenerationFloor: (...args: unknown[]) => releaseGenerationFloorMock(...args),
}));
const takeTurnSummaryMock = jest.fn();
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: { takeTurnSummary: (...args: unknown[]) => takeTurnSummaryMock(...args) },
}));
const emitAgentRunEndedMock = jest.fn();
jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitAgentRunEndedEvent: (...args: unknown[]) => emitAgentRunEndedMock(...args),
}));

import { releaseTurnResources } from '@server/services/SocketService/handlers/chatPhases/agentTurnTeardown';

beforeEach(() => {
  takeTurnSummaryMock.mockReset().mockReturnValue(null);
  emitAgentRunEndedMock.mockReset().mockResolvedValue(undefined);
});

it('awaits deletion of unpromoted vision frames on every agent-turn exit', async () => {
  releaseTurnFramesMock.mockResolvedValue(undefined);
  const runningAgents = new Set(['agent-1']);
  const queues = new Map([['agent-1', ['message']]]);

  await releaseTurnResources({
    usedFloor: false,
    threadId: 'thread-1',
    replyAgentId: 'agent-1',
    triggerMessageId: 'message-1',
    runningAgents,
    agentMentionQueues: queues,
  });

  expect(releaseTurnFramesMock).toHaveBeenCalledWith('thread-1', 'agent-1', 'message-1');
  expect(runningAgents).not.toContain('agent-1');
  expect(queues.has('agent-1')).toBe(false);
});

it('acknowledges vision access exactly once per logical turn, even when the turn had no frames', async () => {
  releaseTurnFramesMock.mockResolvedValue(undefined);
  markAccessSeenMock.mockClear();

  // No triggerMessageId: an exit path that skips frame cleanup entirely. The
  // access acknowledgment must still happen, or an agent that was shown a
  // transition on a turn that died early would be shown it again forever.
  await releaseTurnResources({
    usedFloor: false,
    threadId: 'thread-1',
    replyAgentId: 'agent-1',
    runningAgents: new Set(['agent-1']),
    agentMentionQueues: new Map(),
  });

  expect(markAccessSeenMock).toHaveBeenCalledTimes(1);
  expect(markAccessSeenMock).toHaveBeenCalledWith('thread-1', 'agent-1');
});

describe('run-ended narration', () => {
  it('narrates the turn summary once, from the guaranteed teardown seam', async () => {
    releaseTurnFramesMock.mockResolvedValue(undefined);
    takeTurnSummaryMock.mockReturnValue({ agentName: 'Nova', durationMs: 72_000, toolCalls: 7 });

    await releaseTurnResources({
      usedFloor: false,
      threadId: 'thread-1',
      replyAgentId: 'agent-1',
      runningAgents: new Set(['agent-1']),
      agentMentionQueues: new Map(),
    });

    expect(takeTurnSummaryMock).toHaveBeenCalledWith('thread-1', 'agent-1');
    expect(emitAgentRunEndedMock).toHaveBeenCalledTimes(1);
    expect(emitAgentRunEndedMock).toHaveBeenCalledWith('thread-1', {
      agentName: 'Nova',
      durationMs: 72_000,
      toolCalls: 7,
    });
  });

  it('stays silent when the turn never opened a run — nothing to report', async () => {
    releaseTurnFramesMock.mockResolvedValue(undefined);
    takeTurnSummaryMock.mockReturnValue(null);

    await releaseTurnResources({
      usedFloor: false,
      threadId: 'thread-1',
      replyAgentId: 'agent-1',
      runningAgents: new Set(['agent-1']),
      agentMentionQueues: new Map(),
    });

    expect(emitAgentRunEndedMock).not.toHaveBeenCalled();
  });

  it('completes teardown even when the narration write rejects', async () => {
    releaseTurnFramesMock.mockResolvedValue(undefined);
    takeTurnSummaryMock.mockReturnValue({ agentName: 'Nova', durationMs: 10, toolCalls: 0 });
    emitAgentRunEndedMock.mockRejectedValue(new Error('db down'));
    const runningAgents = new Set(['agent-1']);

    await expect(
      releaseTurnResources({
        usedFloor: false,
        threadId: 'thread-1',
        replyAgentId: 'agent-1',
        runningAgents,
        agentMentionQueues: new Map(),
      })
    ).resolves.toBeUndefined();

    expect(runningAgents.has('agent-1')).toBe(false);
  });
});

describe('stale (superseded) turn teardown', () => {
  it('leaves every per-agent slot untouched when a newer turn owns the agent', async () => {
    releaseTurnFramesMock.mockClear();
    markAccessSeenMock.mockClear();
    clearAgentMock.mockClear();
    releaseGenerationFloorMock.mockClear();
    const runningAgents = new Set(['agent-1']);
    const queues = new Map([['agent-1', ['newer turn mention']]]);

    await releaseTurnResources({
      usedFloor: true,
      threadId: 'thread-1',
      replyAgentId: 'agent-1',
      triggerMessageId: 'message-1',
      runningAgents,
      agentMentionQueues: queues,
      isSuperseded: () => true,
    });

    expect(runningAgents.has('agent-1')).toBe(true);
    expect(queues.get('agent-1')).toEqual(['newer turn mention']);
    expect(clearAgentMock).not.toHaveBeenCalled();
    expect(releaseGenerationFloorMock).not.toHaveBeenCalled();
    expect(takeTurnSummaryMock).not.toHaveBeenCalled();
    expect(markAccessSeenMock).not.toHaveBeenCalled();
    // Its own frames are keyed by its trigger message — released regardless.
    expect(releaseTurnFramesMock).toHaveBeenCalledWith('thread-1', 'agent-1', 'message-1');
  });

  it('re-checks ownership after the frame release: a newer turn taking the slot mid-await is left alone', async () => {
    markAccessSeenMock.mockClear();
    clearAgentMock.mockClear();
    releaseGenerationFloorMock.mockClear();
    let superseded = false;
    releaseTurnFramesMock.mockImplementation(async () => {
      // The newer turn takes over while this turn's frame release is in flight.
      superseded = true;
    });
    const runningAgents = new Set(['agent-1']);
    const queues = new Map([['agent-1', ['newer turn mention']]]);

    await releaseTurnResources({
      usedFloor: true,
      threadId: 'thread-1',
      replyAgentId: 'agent-1',
      triggerMessageId: 'message-1',
      runningAgents,
      agentMentionQueues: queues,
      isSuperseded: () => superseded,
    });

    expect(releaseTurnFramesMock).toHaveBeenCalledWith('thread-1', 'agent-1', 'message-1');
    expect(runningAgents.has('agent-1')).toBe(true);
    expect(queues.get('agent-1')).toEqual(['newer turn mention']);
    expect(clearAgentMock).not.toHaveBeenCalled();
    expect(releaseGenerationFloorMock).not.toHaveBeenCalled();
    expect(takeTurnSummaryMock).not.toHaveBeenCalled();
    expect(markAccessSeenMock).not.toHaveBeenCalled();
    releaseTurnFramesMock.mockReset();
  });

  it('still tears down normally when it owns the slot', async () => {
    clearAgentMock.mockClear();
    releaseTurnFramesMock.mockResolvedValue(undefined);
    const runningAgents = new Set(['agent-1']);

    await releaseTurnResources({
      usedFloor: false,
      threadId: 'thread-1',
      replyAgentId: 'agent-1',
      runningAgents,
      agentMentionQueues: new Map(),
      isSuperseded: () => false,
    });

    expect(runningAgents.has('agent-1')).toBe(false);
    expect(clearAgentMock).toHaveBeenCalledWith('thread-1', 'agent-1');
  });
});
