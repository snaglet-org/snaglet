/**
 * get_clarification's parked wait: Stop (the turn's abort signal) cancels it
 * and clears the UI form, and its reaper keep-alive is bounded — it only ever
 * stamps the run that asked, stops when that run lets go of the thread, and
 * never outlives the keep-alive lifetime cap.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a) },
}));
const settleAsk = jest.fn(async () => undefined);
const notifyClarificationAsk = jest.fn((_input: unknown) => ({
  notificationId: Promise.resolve('notif-ask-test-1'),
  settle: settleAsk,
}));
jest.mock('@server/services/askNotifications', () => ({
  notifyClarificationAsk: (input: unknown) => notifyClarificationAsk(input),
}));

import { activeRunTracker } from '@server/services/ActiveRunTracker';
import {
  cancelClarificationsForThread,
  listPendingClarifications,
  resolveClarification,
  waitForClarification,
} from '@server/services/SocketService/clarification';
import type { ClarificationRequest } from '@snaglet/shared/types';

const THREAD = 'thread-1111111111111-aaaaaaaaa';
const SESSION = 'session-test-a';
const NEXT_SESSION = 'session-test-b';
const REQUEST = { questions: [] } as unknown as ClarificationRequest;

/** Frames sent to the thread's own channel (the global `asks` mirror is covered by askFeed.test.ts). */
function broadcastTypes(): string[] {
  return broadcastToChannel.mock.calls
    .filter((c) => c[0] !== 'asks')
    .map((c) => (c[1] as { type: string }).type);
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  cancelClarificationsForThread(THREAD);
  activeRunTracker.finishSession(SESSION);
  activeRunTracker.finishSession(NEXT_SESSION);
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('clarification cancellation', () => {
  it('cancels a parked clarification when the turn is aborted', async () => {
    const controller = new AbortController();
    const parked = waitForClarification(
      THREAD,
      'call-1',
      'test-agent-a',
      'run-1',
      REQUEST,
      60_000,
      60_000,
      controller.signal
    );
    expect(listPendingClarifications(THREAD)).toHaveLength(1);

    controller.abort();

    await expect(parked).resolves.toEqual({ status: 'dismissed', answers: {} });
    expect(listPendingClarifications(THREAD)).toHaveLength(0);
    expect(broadcastTypes()).toEqual([
      'socket:clarification:request',
      'socket:clarification:timeout',
    ]);
  });

  it('never shows a question whose turn was already stopped', async () => {
    const controller = new AbortController();
    controller.abort();

    const parked = waitForClarification(
      THREAD,
      'call-1',
      'test-agent-a',
      'run-1',
      REQUEST,
      60_000,
      60_000,
      controller.signal
    );

    await expect(parked).resolves.toEqual({ status: 'dismissed', answers: {} });
    expect(listPendingClarifications(THREAD)).toHaveLength(0);
    // Never shown, so nothing on any channel — including the global mirror.
    expect(broadcastToChannel).not.toHaveBeenCalled();
  });

  it('an answer after the abort is a no-op', async () => {
    const controller = new AbortController();
    const parked = waitForClarification(
      THREAD,
      'call-1',
      'test-agent-a',
      'run-1',
      REQUEST,
      60_000,
      60_000,
      controller.signal
    );
    controller.abort();
    resolveClarification(THREAD, 'call-1', { status: 'answered', answers: {} });

    await expect(parked).resolves.toEqual({ status: 'dismissed', answers: {} });
  });

  it("a targeted cancel leaves other agents' questions parked", async () => {
    const mine = waitForClarification(THREAD, 'call-1', 'test-agent-a', 'run-1', REQUEST);
    void waitForClarification(THREAD, 'call-2', 'test-agent-b', 'run-2', REQUEST);

    expect(cancelClarificationsForThread(THREAD, 'test-agent-a')).toBe(1);

    await expect(mine).resolves.toEqual({ status: 'timed_out', answers: {} });
    expect(listPendingClarifications(THREAD).map((p) => p.callId)).toEqual(['call-2']);
  });
});

describe('clarification keep-alive', () => {
  it('stops stamping once the asking run no longer holds the thread', () => {
    jest.useFakeTimers();
    activeRunTracker.startSession(SESSION, THREAD);
    const noteProgress = jest.spyOn(activeRunTracker, 'noteProgress');

    void waitForClarification(THREAD, 'call-1', 'test-agent-a', 'run-1', REQUEST, 60_000, 1_000);
    jest.advanceTimersByTime(3_000);
    expect(noteProgress).toHaveBeenCalledWith(SESSION);

    // The asking run is torn down and a newer run takes the thread.
    activeRunTracker.finishSession(SESSION);
    activeRunTracker.startSession(NEXT_SESSION, THREAD);
    noteProgress.mockClear();
    jest.advanceTimersByTime(5_000);

    expect(noteProgress).not.toHaveBeenCalled();
    expect(listPendingClarifications(THREAD)).toHaveLength(1);
  });

  it('never outlives the keep-alive lifetime cap, even with a longer timeout', () => {
    jest.useFakeTimers();
    activeRunTracker.startSession(SESSION, THREAD);
    const noteProgress = jest.spyOn(activeRunTracker, 'noteProgress');

    void waitForClarification(
      THREAD,
      'call-1',
      'test-agent-a',
      'run-1',
      REQUEST,
      60 * 60_000,
      60_000
    );
    noteProgress.mockClear(); // the issue-time stamp
    jest.advanceTimersByTime(9 * 60_000);
    expect(noteProgress).toHaveBeenCalledTimes(9);

    noteProgress.mockClear();
    jest.advanceTimersByTime(20 * 60_000);

    expect(noteProgress).not.toHaveBeenCalled();
    expect(listPendingClarifications(THREAD)).toHaveLength(1);
  });
});

describe("the question's notification", () => {
  it('is raised with the question and cleared once it is answered', async () => {
    const parked = waitForClarification(THREAD, 'call-1', 'test-agent-a', 'run-1', REQUEST);

    expect(notifyClarificationAsk).toHaveBeenCalledTimes(1);
    expect(notifyClarificationAsk).toHaveBeenCalledWith({
      threadId: THREAD,
      callId: 'call-1',
      agentId: 'test-agent-a',
      runId: 'run-1',
      request: REQUEST,
    });
    expect(settleAsk).not.toHaveBeenCalled();

    resolveClarification(THREAD, 'call-1', { status: 'answered', answers: {} });
    await expect(parked).resolves.toEqual({ status: 'answered', answers: {} });
    expect(listPendingClarifications(THREAD)).toHaveLength(0);
    expect(settleAsk).toHaveBeenCalledTimes(1);
    expect(
      broadcastToChannel.mock.calls.some(
        ([channel, frame]) =>
          channel === 'asks' &&
          (frame as { type?: string }).type === 'asks:settled' &&
          (frame as { payload?: { callId?: string } }).payload?.callId === 'call-1'
      )
    ).toBe(true);
  });

  it('every settlement path broadcasts a timeout frame carrying the matching callId', async () => {
    jest.useFakeTimers();
    const frames = () =>
      broadcastToChannel.mock.calls
        .filter((c) => c[0] === THREAD)
        .map((c) => c[1] as { type: string; payload: { callId?: string } })
        .filter((f) => f.type === 'socket:clarification:timeout')
        .map((f) => f.payload.callId);
    // timeout
    const t = waitForClarification(
      THREAD,
      'call-t',
      'test-agent-a',
      'run-1',
      REQUEST,
      5_000,
      60_000
    );
    jest.advanceTimersByTime(5_000);
    await t;
    // thread cancel
    const c = waitForClarification(THREAD, 'call-c', 'test-agent-a', 'run-1', REQUEST);
    cancelClarificationsForThread(THREAD);
    await c;
    // abort signal
    const ctl = new AbortController();
    const ab = waitForClarification(
      THREAD,
      'call-a',
      'test-agent-a',
      'run-1',
      REQUEST,
      60_000,
      60_000,
      ctl.signal
    );
    ctl.abort();
    await ab;
    expect(frames()).toEqual(['call-t', 'call-c', 'call-a']);
  });

  it('is cleared by the timeout', async () => {
    jest.useFakeTimers();
    const parked = waitForClarification(
      THREAD,
      'call-1',
      'test-agent-a',
      'run-1',
      REQUEST,
      5_000,
      60_000
    );
    jest.advanceTimersByTime(5_000);
    await expect(parked).resolves.toEqual({ status: 'timed_out', answers: {} });
    expect(settleAsk).toHaveBeenCalledTimes(1);
  });

  it("is cleared when the turn's abort signal fires", async () => {
    const controller = new AbortController();
    const parked = waitForClarification(
      THREAD,
      'call-1',
      'test-agent-a',
      'run-1',
      REQUEST,
      60_000,
      60_000,
      controller.signal
    );
    controller.abort();
    await expect(parked).resolves.toEqual({ status: 'dismissed', answers: {} });
    expect(settleAsk).toHaveBeenCalledTimes(1);
  });

  it("is cleared when the thread's questions are canceled", async () => {
    const parked = waitForClarification(THREAD, 'call-1', 'test-agent-a', 'run-1', REQUEST);
    expect(cancelClarificationsForThread(THREAD)).toBe(1);
    await expect(parked).resolves.toEqual({ status: 'timed_out', answers: {} });
    expect(settleAsk).toHaveBeenCalledTimes(1);
  });

  it('is never raised for a question whose turn was already stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    await waitForClarification(
      THREAD,
      'call-1',
      'test-agent-a',
      'run-1',
      REQUEST,
      60_000,
      60_000,
      controller.signal
    );
    expect(notifyClarificationAsk).not.toHaveBeenCalled();
  });
});
