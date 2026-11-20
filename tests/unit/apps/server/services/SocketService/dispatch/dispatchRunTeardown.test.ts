/**
 * finalizeDispatchRun — session ownership across its awaits.
 *
 * Session ids are reused across runs. Every session-keyed step of the
 * teardown (queue flush, skipped seeds, lock release, re-dispatch) must be
 * skipped once this run does not own the session — including when the
 * ownership is lost during one of the teardown's own awaits (the dynamic
 * import right before the queue flush is one such window).
 */

const mockIsSessionRun = jest.fn();
const mockFinishSession = jest.fn(() => []);
const mockTakeSkippedSeeds = jest.fn(() => []);
jest.mock('@server/services/ActiveRunTracker', () => ({
  activeRunTracker: {
    isSessionRun: (...a: unknown[]) => mockIsSessionRun(...a),
    finishSession: (...a: unknown[]) => mockFinishSession(...(a as [])),
    takeSkippedSeeds: (...a: unknown[]) => mockTakeSkippedSeeds(...(a as [])),
    finish: jest.fn(),
    snapshot: () => ({ activeThreadCount: 0, activeRunCount: 0 }),
  },
}));

jest.mock('@server/services/SocketService/abortStore', () => ({
  clearAbortController: jest.fn(),
}));

const makeLogsProxy = (): unknown =>
  new Proxy(jest.fn(), {
    get: () => makeLogsProxy(),
    apply: () => undefined,
  });
jest.mock('@server/services/LogsService', () => ({ LogsService: makeLogsProxy() }));

jest.mock('@server/services/SocketService/threadEvents', () => ({
  emitConversationEndedEvent: jest.fn(async () => undefined),
}));

const mockFlush = jest.fn(async () => [] as Array<{ id: string }>);
const mockPersistStragglers = jest.fn(async () => undefined);
jest.mock('@server/services/SocketService/handlers/chatPhases/midRunMessages', () => ({
  flushAbandonedSessionMessages: (...a: unknown[]) => mockFlush(...(a as [])),
  persistStragglers: (...a: unknown[]) => mockPersistStragglers(...(a as [])),
}));

import { finalizeDispatchRun } from '@server/services/SocketService/dispatch/dispatchRunTeardown';

const RUN_TOKEN = 7;

function params(redispatch = jest.fn(async () => undefined)) {
  return {
    sessionId: 'session-1',
    threadId: 'thread-1',
    threadName: 'Teardown Test Thread',
    isGroup: false,
    activeRunIds: new Set<string>(),
    convBudget: {
      summary: () => ({ totalOutputTokens: 0, waves: 1, exhaustedReason: null }),
      seedSnapshot: () => ({ waves: 1, totalOutputTokens: 0 }),
    } as unknown as Parameters<typeof finalizeDispatchRun>[0]['convBudget'],
    stopReason: 'all-passed' as const,
    passKinds: new Map(),
    wakeCount: 1,
    redispatch,
    runToken: RUN_TOKEN,
  };
}

describe('finalizeDispatchRun — session ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('flushes and releases the session it still owns', async () => {
    mockIsSessionRun.mockReturnValue(true);

    await finalizeDispatchRun(params());

    expect(mockFlush).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }));
    expect(mockFinishSession).toHaveBeenCalledWith('session-1', RUN_TOKEN);
  });

  it('never drains the queue when a newer run takes the session during the pre-flush import', async () => {
    // Owned at the first check, lost by the re-check right before the drain.
    mockIsSessionRun.mockReturnValueOnce(true).mockReturnValue(false);
    const redispatch = jest.fn(async () => undefined);

    await finalizeDispatchRun(params(redispatch));

    expect(mockIsSessionRun).toHaveBeenCalledTimes(2);
    expect(mockFlush).not.toHaveBeenCalled();
    expect(mockTakeSkippedSeeds).not.toHaveBeenCalled();
    expect(mockFinishSession).not.toHaveBeenCalled();
    expect(mockPersistStragglers).not.toHaveBeenCalled();
    expect(redispatch).not.toHaveBeenCalled();
  });

  it('skips every session step when ownership was already lost', async () => {
    mockIsSessionRun.mockReturnValue(false);

    await finalizeDispatchRun(params());

    expect(mockFlush).not.toHaveBeenCalled();
    expect(mockFinishSession).not.toHaveBeenCalled();
  });
});

describe('finalizeDispatchRun — multi-message redispatch keeps every wake', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes every undelivered id, not just the newest, so earlier @mentions still wake', async () => {
    mockIsSessionRun.mockReturnValue(true);
    // Two peer tool-sends were skipped while the run held the lock: the first
    // @mentions Clio, the second @mentions Venus. Seeding on the newest alone
    // would wake only Venus and silently drop Clio's wake.
    mockTakeSkippedSeeds.mockReturnValueOnce(['msg-to-clio', 'msg-to-venus'] as never);
    const redispatch = jest.fn(async () => undefined);

    await finalizeDispatchRun(params(redispatch));
    await new Promise((resolve) => setImmediate(resolve));

    expect(redispatch).toHaveBeenCalledTimes(1);
    expect(redispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-to-venus',
        coveredMessageIds: ['msg-to-clio', 'msg-to-venus'],
        undeliveredCount: 2,
      })
    );
  });
});
