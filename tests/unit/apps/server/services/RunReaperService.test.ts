/**
 * Zombie-run reaper (guardrail-3 failsafe): a run with zero observable
 * progress for the stall window is force-aborted; if it ignores the abort, its
 * tracker entry is cleared, cancellation is attributed, and undelivered
 * queued messages are re-dispatched so the thread answers them.
 */

const abortAllAgentRuns = jest.fn(async () => ({ abortedCount: 1 }));
jest.mock('@server/services/AbortRunService', () => ({
  AbortRunService: {
    abortAllAgentRuns: (...a: unknown[]) => abortAllAgentRuns(...a),
  },
}));

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    sendToClient: jest.fn(),
  },
}));

const persistLeftoverQueuedMessages = jest.fn(async () => undefined);
jest.mock('@server/services/SocketService/handlers/chatPhases/midRunMessages', () => ({
  persistLeftoverQueuedMessages: (...a: unknown[]) => persistLeftoverQueuedMessages(...a),
}));

const redispatchPersistedMessage = jest.fn(async () => undefined);
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  redispatchPersistedMessage: (...a: unknown[]) => redispatchPersistedMessage(...a),
}));

import { activeRunTracker } from '@server/services/ActiveRunTracker';
import {
  startRunReaper,
  stopRunReaper,
  runReaperSweepOnce,
  REAPER_STALL_DEFAULT_MS,
} from '@server/services/RunReaperService';
import {
  waitForClarification,
  resolveClarification,
  listPendingClarifications,
} from '@server/services/SocketService/clarification';
import {
  listPendingToolConfirmations,
  waitForConfirmation,
} from '@server/services/SocketService/confirmation';
import type { ClarificationRequest } from '@snaglet/shared/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REQUEST = { questions: [] } as unknown as ClarificationRequest;

const THREAD = 'thread-reaper-1';
const SESSION = 'session-reaper-1';

describe('RunReaperService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    startRunReaper({ stallMs: 80, sweepIntervalMs: 60_000, graceMs: 60 });
  });

  afterEach(() => {
    stopRunReaper();
    activeRunTracker.finishSession(SESSION);
  });

  it('leaves a run alone while it keeps making progress', async () => {
    activeRunTracker.startSession(SESSION, THREAD);
    await sleep(100);
    activeRunTracker.noteProgress(SESSION);

    runReaperSweepOnce();

    expect(abortAllAgentRuns).not.toHaveBeenCalled();
    expect(activeRunTracker.hasActiveSession(SESSION)).toBe(true);
  });

  it('force-ends a wedged run through AbortRunService, then clears the tracker', async () => {
    activeRunTracker.startSession(SESSION, THREAD);
    // A guardrail-1 message persisted on receipt sits undelivered in the queue.
    activeRunTracker.enqueueMessageForThread(
      THREAD,
      'msg-stuck-1',
      'still there?',
      undefined,
      true
    );
    await sleep(120);

    runReaperSweepOnce();

    // Cancellation is routed through the one attributed service.
    expect(abortAllAgentRuns).toHaveBeenCalledWith({
      threadId: THREAD,
      abortedBy: { actorKind: 'system', actorId: 'watchdog', actorName: 'watchdog' },
    });

    // The run ignores the abort (truly wedged) — after the grace window the
    // reaper force-releases it.
    await sleep(150);
    expect(activeRunTracker.hasActiveSession(SESSION)).toBe(false);
    expect(activeRunTracker.getActiveSessionForThread(THREAD)).toBeUndefined();

    // The undelivered message was flushed and re-dispatched — "the next wave
    // delivers it".
    expect(persistLeftoverQueuedMessages).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ id: 'msg-stuck-1', persisted: true })]),
      expect.anything()
    );
    expect(redispatchPersistedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD, messageId: 'msg-stuck-1' })
    );
    expect(broadcastToChannel).toHaveBeenCalledWith(
      THREAD,
      expect.objectContaining({
        type: 'socket:chat:aborted',
        payload: expect.objectContaining({
          sessionId: SESSION,
          threadId: THREAD,
          reaped: true,
        }),
      })
    );
  });

  it('skips the force-release when the abort unwound the run cleanly', async () => {
    activeRunTracker.startSession(SESSION, THREAD);
    await sleep(120);

    runReaperSweepOnce();
    expect(abortAllAgentRuns).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD }));
    // The run's own dispatch finally releases the session inside the grace window.
    activeRunTracker.finishSession(SESSION);

    await sleep(150);
    // No force-release: no socket:chat:aborted broadcast (workspace lifecycle
    // frames from start/finishSession are fine) and no re-dispatch.
    const abortedFrames = broadcastToChannel.mock.calls
      .map((c) => c[1] as { type: string })
      .filter((m) => m.type === 'socket:chat:aborted');
    expect(abortedFrames).toHaveLength(0);
    expect(redispatchPersistedMessage).not.toHaveBeenCalled();
  });
});

describe('RunReaperService — reused session ids', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    startRunReaper({ stallMs: 80, sweepIntervalMs: 60_000, graceMs: 60 });
  });

  afterEach(() => {
    stopRunReaper();
    activeRunTracker.finishSession(SESSION);
  });

  it('does not force-release a new run that reused the session id during the grace window', async () => {
    activeRunTracker.startSession(SESSION, THREAD);
    await sleep(120);

    runReaperSweepOnce();
    // The wedged run unwinds via the abort, and the user's next send starts a
    // fresh run on the same (reused) socket session id before grace expires.
    activeRunTracker.finishSession(SESSION);
    expect(activeRunTracker.startSession(SESSION, THREAD)).toBe(true);
    activeRunTracker.enqueueMessageForThread(THREAD, 'msg-new-run', 'hi', undefined, true);

    await sleep(150);

    expect(activeRunTracker.getActiveSessionForThread(THREAD)).toBe(SESSION);
    expect(activeRunTracker.drainMessages(SESSION).map((m) => m.id)).toEqual(['msg-new-run']);
    const abortedFrames = broadcastToChannel.mock.calls
      .map((c) => c[1] as { type: string })
      .filter((m) => m.type === 'socket:chat:aborted');
    expect(abortedFrames).toHaveLength(0);
  });
});

describe('RunReaperService — human-interactive waits are not reaped', () => {
  const CLAR_THREAD = 'thread-reaper-clar';
  const CLAR_SESSION = 'session-reaper-clar';
  const TOOL_THREAD = 'thread-reaper-confirm';
  const TOOL_SESSION = 'session-reaper-confirm';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    stopRunReaper();
    // Drop any parked clarification + release the lock so suites don't leak.
    resolveClarification(CLAR_THREAD, 'call-clar', { status: 'answered', answers: {} });
    activeRunTracker.finishSession(CLAR_SESSION);
    activeRunTracker.finishSession(TOOL_SESSION);
    jest.restoreAllMocks();
  });

  it("the default stall window buffers comfortably above get_clarification's 11-min hard timeout", () => {
    // The reaper is a failsafe for runs that ignore their own timeouts; it must
    // never fire before the longest sanctioned tool wait (get_clarification,
    // 11 min in executionGuards) resolves.
    expect(REAPER_STALL_DEFAULT_MS).toBeGreaterThanOrEqual(15 * 60_000);
    expect(REAPER_STALL_DEFAULT_MS).toBeGreaterThan(11 * 60_000);
  });

  it('stamps run progress at clarification-issue time', () => {
    startRunReaper({ stallMs: 80, sweepIntervalMs: 60_000, graceMs: 60 });
    activeRunTracker.startSession(CLAR_SESSION, CLAR_THREAD);
    const spy = jest.spyOn(activeRunTracker, 'noteProgressForThread');

    // Issue a clarification (keepalive long so only the issue-time stamp fires).
    void waitForClarification(
      CLAR_THREAD,
      'call-clar',
      'agent-1',
      'run-1',
      REQUEST,
      10_000,
      10_000
    );

    expect(spy).toHaveBeenCalledWith(CLAR_THREAD);
  });

  it('does not reap a run parked in a legitimate clarification wait (issue stamp + keepalive)', async () => {
    // stall window 80ms, keepalive 30ms → the parked wait keeps stamping
    // progress, so a sweep well past the raw stall window finds it healthy.
    startRunReaper({ stallMs: 80, sweepIntervalMs: 60_000, graceMs: 60 });
    activeRunTracker.startSession(CLAR_SESSION, CLAR_THREAD);

    void waitForClarification(CLAR_THREAD, 'call-clar', 'agent-1', 'run-1', REQUEST, 5_000, 30);
    // No model/tool call ever completes — only the clarification keepalive runs.
    await sleep(200);

    runReaperSweepOnce();

    expect(abortAllAgentRuns).not.toHaveBeenCalled();
    expect(activeRunTracker.hasActiveSession(CLAR_SESSION)).toBe(true);
  });

  it('reconciles pending clarifications if a reap ever does fire mid-wait (defensive)', async () => {
    startRunReaper({ stallMs: 80, sweepIntervalMs: 60_000, graceMs: 40 });
    activeRunTracker.startSession(CLAR_SESSION, CLAR_THREAD);

    // Force the reap despite the pending clarification by starving the keepalive
    // (keepAliveMs far longer than the test stall window) — simulates the
    // should-never-happen case the reconciliation defends against.
    const parked = waitForClarification(
      CLAR_THREAD,
      'call-clar',
      'agent-1',
      'run-1',
      REQUEST,
      10_000,
      10_000
    );
    expect(listPendingClarifications(CLAR_THREAD)).toHaveLength(1);

    await sleep(140);
    runReaperSweepOnce();
    expect(abortAllAgentRuns).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: CLAR_THREAD })
    );

    // The parked clarification is cleared (not stranded) and its run unblocked
    // with a timed_out outcome — a queued answer can't resolve into a dead run.
    await expect(parked).resolves.toEqual({ status: 'timed_out', answers: {} });
    expect(listPendingClarifications(CLAR_THREAD)).toHaveLength(0);
    const clarTimeout = broadcastToChannel.mock.calls
      .map((c) => c[1] as { type: string; payload: { callId?: string } })
      .find((m) => m.type === 'socket:clarification:timeout');
    expect(clarTimeout?.payload.callId).toBe('call-clar');
  });

  it('reconciles pending tool confirmations when a reap fires', async () => {
    startRunReaper({ stallMs: 80, sweepIntervalMs: 60_000, graceMs: 40 });
    activeRunTracker.startSession(TOOL_SESSION, TOOL_THREAD);

    const parked = waitForConfirmation({
      threadId: TOOL_THREAD,
      sessionId: TOOL_SESSION,
      callId: 'call-confirm',
      agentId: 'agent-1',
      toolName: 'dangerous_tool',
      toolInput: {},
      mode: 'allow_list',
    });
    expect(listPendingToolConfirmations(TOOL_THREAD)).toHaveLength(1);

    await sleep(140);
    runReaperSweepOnce();

    await expect(parked).resolves.toEqual({ approved: false, timedOut: false });
    expect(listPendingToolConfirmations(TOOL_THREAD)).toHaveLength(0);
    // The pane's Approve/Deny panel is closed too.
    const closed = broadcastToChannel.mock.calls
      .map((c) => c[1] as { type: string; payload: { callId?: string } })
      .filter((m) => m.type === 'socket:tool:confirmation_timeout');
    expect(closed.map((m) => m.payload.callId)).toEqual(['call-confirm']);
  });
});
