const broadcastToChannel = jest.fn();
const settle = jest.fn(async () => undefined);

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel },
}));
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    noteProgressForThread: jest.fn(),
    getActiveSessionForThread: jest.fn(),
    noteProgress: jest.fn(),
  },
}));
jest.mock('@server/config/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@snaglet/db', () => ({
  Agents: { appendToolAccessAllowList: jest.fn() },
  ThreadParticipants: { grantToolAccess: jest.fn() },
}));
jest.mock('@server/services/askNotifications', () => ({
  notifyClarificationAsk: () => ({ notificationId: Promise.resolve('n'), settle }),
  notifyToolApprovalAsk: () => ({ notificationId: Promise.resolve('n'), settle }),
}));

import { ASK_EVENT_CHANNEL, ASK_SETTLED } from '@snaglet/shared/types';
import {
  listAllPendingClarifications,
  resolveClarification,
  waitForClarification,
} from '@server/services/SocketService/clarification';
import {
  listAllPendingToolConfirmations,
  resolveToolConfirmation,
  waitForConfirmation,
} from '@server/services/SocketService/confirmation';

const request = { questions: [{ id: 'q1', prompt: 'Send?', type: 'text' }] } as never;

describe('global ask feed', () => {
  beforeEach(() => jest.clearAllMocks());

  it('mirrors a clarification and its settlement onto the asks channel', async () => {
    const pending = waitForClarification(
      'thread-a',
      'call-1',
      'agent-1',
      undefined,
      request,
      60_000
    );

    const channels = broadcastToChannel.mock.calls.map((c) => c[0]);
    expect(channels).toEqual(expect.arrayContaining(['thread-a', ASK_EVENT_CHANNEL]));
    const mirrored = broadcastToChannel.mock.calls.find((c) => c[0] === ASK_EVENT_CHANNEL)?.[1];
    expect(mirrored.type).toBe('socket:clarification:request');
    expect(mirrored.payload).toMatchObject({ threadId: 'thread-a', callId: 'call-1' });
    expect(listAllPendingClarifications().map((c) => c.callId)).toContain('call-1');

    resolveClarification('thread-a', 'call-1', { status: 'answered', answers: {} });
    await expect(pending).resolves.toMatchObject({ status: 'answered' });
    expect(broadcastToChannel).toHaveBeenCalledWith(ASK_EVENT_CHANNEL, {
      type: ASK_SETTLED,
      payload: { callId: 'call-1' },
    });
    expect(listAllPendingClarifications().map((c) => c.callId)).not.toContain('call-1');
  });

  it('mirrors a tool confirmation and its settlement', async () => {
    const pending = waitForConfirmation({
      threadId: 'thread-b',
      sessionId: 'session-b',
      callId: 'call-2',
      agentId: 'agent-1',
      toolName: 'shell_exec',
      toolInput: { command: 'ls' },
    });

    const mirrored = broadcastToChannel.mock.calls.find((c) => c[0] === ASK_EVENT_CHANNEL)?.[1];
    expect(mirrored.type).toBe('socket:tool:confirmation_request');
    expect(listAllPendingToolConfirmations().map((c) => c.callId)).toContain('call-2');

    await resolveToolConfirmation('thread-b', 'call-2', 'deny');
    await pending;
    expect(broadcastToChannel).toHaveBeenCalledWith(ASK_EVENT_CHANNEL, {
      type: ASK_SETTLED,
      payload: { callId: 'call-2' },
    });
    expect(listAllPendingToolConfirmations().map((c) => c.callId)).not.toContain('call-2');
  });
});
