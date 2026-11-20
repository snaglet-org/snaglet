import {
  resolveAllModeMidRunTargets,
  routeAllModeMidRunMessage,
} from '@server/services/SocketService/handlers/chatPhases/routeAllModeMidRunMessage';

describe('routeAllModeMidRunMessage', () => {
  it('keeps open-floor messages routed to every participant', () => {
    expect(
      resolveAllModeMidRunTargets({
        content: 'anyone can answer',
        replyAgentId: 'agent-a',
        participantAgentIds: ['agent-a', 'agent-b'],
        agentNameMap: new Map([
          ['agent-a', 'Clio'],
          ['agent-b', 'Venus'],
        ]),
      })
    ).toEqual({
      targetAgentIds: ['agent-a', 'agent-b'],
      targetsCurrentAgent: true,
      unresolvedMentionIds: [],
    });
  });

  it('routes explicit mentions only to the mentioned participants', () => {
    expect(
      resolveAllModeMidRunTargets({
        content: '@venus send a fruit emoji',
        replyAgentId: 'agent-a',
        participantAgentIds: ['agent-a', 'agent-b'],
        agentNameMap: new Map([
          ['agent-a', 'Clio'],
          ['agent-b', 'Venus'],
        ]),
      })
    ).toEqual({
      targetAgentIds: ['agent-b'],
      targetsCurrentAgent: false,
      unresolvedMentionIds: [],
    });
  });

  it('does not fan unresolved explicit mentions out to every participant', () => {
    expect(
      resolveAllModeMidRunTargets({
        content: '@missing send a fruit emoji',
        replyAgentId: 'agent-a',
        participantAgentIds: ['agent-a', 'agent-b'],
        agentNameMap: new Map([
          ['agent-a', 'Clio'],
          ['agent-b', 'Venus'],
        ]),
      })
    ).toEqual({
      targetAgentIds: [],
      targetsCurrentAgent: false,
      unresolvedMentionIds: [],
    });
  });

  it('injects into running peers and wakes non-running peers', () => {
    const startAgent = jest.fn();
    const queuePendingMessage = jest.fn();
    const runningAgents = new Set(['agent-a', 'agent-b']);
    const dispatchSet = new Set(['agent-a']);
    const passedAgents = new Set(['agent-c']);
    const wokenByMention = new Set<string>();

    const result = routeAllModeMidRunMessage({
      replyAgentId: 'agent-a',
      participantAgentIds: ['agent-a', 'agent-b', 'agent-c'],
      runningAgents,
      agentDispatchCount: new Map([['agent-c', 1]]),
      dispatchSet,
      passedAgents,
      wokenByMention,
      hardDispatchCeiling: 3,
      effectiveParallelDispatch: true,
      content: 'new user message',
      startAgent,
      queuePendingMessage,
    });

    expect(result).toEqual({
      queuedAgentIds: ['agent-b'],
      wokenAgentIds: ['agent-c'],
      limitedAgentIds: [],
    });
    expect(queuePendingMessage).toHaveBeenCalledWith('agent-b');
    expect(dispatchSet.has('agent-c')).toBe(true);
    expect(passedAgents.has('agent-c')).toBe(false);
    expect(wokenByMention.has('agent-c')).toBe(true);
    expect(startAgent).toHaveBeenCalledWith('agent-c');
  });

  it('limits fan-out to the resolved targets when mentions are present', () => {
    const startAgent = jest.fn();
    const queuePendingMessage = jest.fn();
    const runningAgents = new Set(['agent-a', 'agent-b']);

    const result = routeAllModeMidRunMessage({
      replyAgentId: 'agent-a',
      participantAgentIds: ['agent-a', 'agent-b', 'agent-c'],
      targetAgentIds: ['agent-b'],
      runningAgents,
      agentDispatchCount: new Map(),
      dispatchSet: new Set(),
      passedAgents: new Set(),
      wokenByMention: new Set(),
      hardDispatchCeiling: 3,
      effectiveParallelDispatch: true,
      content: '@venus send a fruit emoji',
      startAgent,
      queuePendingMessage,
    });

    expect(result).toEqual({
      queuedAgentIds: ['agent-b'],
      wokenAgentIds: [],
      limitedAgentIds: [],
    });
    expect(queuePendingMessage).toHaveBeenCalledWith('agent-b');
    expect(queuePendingMessage).not.toHaveBeenCalledWith('agent-c');
    expect(startAgent).not.toHaveBeenCalled();
  });

  it('does not wake peers at the hard dispatch ceiling', () => {
    const startAgent = jest.fn();
    const result = routeAllModeMidRunMessage({
      replyAgentId: 'agent-a',
      participantAgentIds: ['agent-a', 'agent-b'],
      runningAgents: new Set(['agent-a']),
      agentDispatchCount: new Map([['agent-b', 3]]),
      dispatchSet: new Set(),
      passedAgents: new Set(['agent-b']),
      wokenByMention: new Set(),
      hardDispatchCeiling: 3,
      effectiveParallelDispatch: true,
      content: 'new user message',
      startAgent,
    });

    expect(result).toEqual({
      queuedAgentIds: [],
      wokenAgentIds: [],
      limitedAgentIds: ['agent-b'],
    });
    expect(startAgent).not.toHaveBeenCalled();
  });
});
