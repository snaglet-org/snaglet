import { ActiveRunTracker, activeRunTracker } from '@server/services/ActiveRunTracker';

describe('ActiveRunTracker — shutdown admission gate', () => {
  it('rejects a session that arrives after shutdown closes admission', () => {
    const tracker = new ActiveRunTracker();
    expect(tracker.startSession('session-before-shutdown', 'thread-before-shutdown')).toBe(true);
    tracker.stopAcceptingSessions();
    expect(tracker.startSession('session-after-shutdown', 'thread-after-shutdown')).toBe(false);
    tracker.finishSession('session-before-shutdown');
  });
});

describe('ActiveRunTracker — destructive thread purge reservations', () => {
  const threadIds = ['thread-purge-1', 'thread-purge-2', 'thread-purge-3'];
  const sessionIds = ['session-purge-1', 'session-purge-2', 'session-purge-3'];

  afterEach(() => {
    for (const sessionId of sessionIds) activeRunTracker.finishSession(sessionId);
    for (const threadId of threadIds) {
      activeRunTracker.releaseThreadPurge(threadId);
      activeRunTracker.clearHandoff(threadId);
    }
  });

  it('reserves an idle thread and blocks new sessions until release', () => {
    expect(activeRunTracker.reserveThreadPurge('thread-purge-1')).toBe(true);
    expect(activeRunTracker.isThreadPurgeReserved('thread-purge-1')).toBe(true);
    expect(activeRunTracker.startSession('session-purge-1', 'thread-purge-1')).toBe(false);

    activeRunTracker.releaseThreadPurge('thread-purge-1');
    expect(activeRunTracker.isThreadPurgeReserved('thread-purge-1')).toBe(false);
    expect(activeRunTracker.startSession('session-purge-1', 'thread-purge-1')).toBe(true);
  });

  it('refuses a purge reservation while a run is active', () => {
    expect(activeRunTracker.startSession('session-purge-2', 'thread-purge-2')).toBe(true);
    expect(activeRunTracker.reserveThreadPurge('thread-purge-2')).toBe(false);
    expect(activeRunTracker.isThreadPurgeReserved('thread-purge-2')).toBe(false);
  });

  it('refuses a purge reservation during a handoff or concurrent purge', () => {
    activeRunTracker.reserveHandoff('thread-purge-3');
    expect(activeRunTracker.reserveThreadPurge('thread-purge-3')).toBe(false);

    activeRunTracker.clearHandoff('thread-purge-3');
    expect(activeRunTracker.reserveThreadPurge('thread-purge-3')).toBe(true);
    expect(activeRunTracker.reserveThreadPurge('thread-purge-3')).toBe(false);
  });
});

describe('ActiveRunTracker — purge reservation reason (fork vs clear)', () => {
  it('defaults to clear and records the reason given', () => {
    const tracker = new ActiveRunTracker();
    // No reason → 'clear' (the purge service default).
    expect(tracker.reserveThreadPurge('t-reason-default')).toBe(true);
    expect(tracker.threadPurgeReason('t-reason-default')).toBe('clear');

    expect(tracker.reserveThreadPurge('t-reason-fork', 'fork')).toBe(true);
    expect(tracker.threadPurgeReason('t-reason-fork')).toBe('fork');

    // Unreserved threads report no reason.
    expect(tracker.threadPurgeReason('t-reason-none')).toBeUndefined();

    // Reason clears on release.
    tracker.releaseThreadPurge('t-reason-fork');
    expect(tracker.threadPurgeReason('t-reason-fork')).toBeUndefined();
  });
});

describe('ActiveRunTracker — messages deferred during a fork reservation', () => {
  it('records a message only while the thread is fork-reserved', () => {
    const tracker = new ActiveRunTracker();
    // Not reserved yet: nothing to defer, the caller handles it normally.
    expect(tracker.deferMessageDuringPurge('t-defer', 'message-1')).toBe(false);

    expect(tracker.reserveThreadPurge('t-defer', 'fork')).toBe(true);
    expect(tracker.deferMessageDuringPurge('t-defer', 'message-1')).toBe(true);
    // Deduped: a repeat defer of the same id is still one entry.
    expect(tracker.deferMessageDuringPurge('t-defer', 'message-1')).toBe(true);
    expect(tracker.deferMessageDuringPurge('t-defer', 'message-2')).toBe(true);
  });

  it('hands the deferred ids back once, for the fork owner to re-dispatch', () => {
    const tracker = new ActiveRunTracker();
    tracker.reserveThreadPurge('t-drain', 'fork');
    tracker.deferMessageDuringPurge('t-drain', 'message-a');
    tracker.deferMessageDuringPurge('t-drain', 'message-b');

    const drained = tracker.takeDeferredPurgeMessages('t-drain');
    expect(drained.sort()).toEqual(['message-a', 'message-b']);
    // Drained exactly once: a second take is empty.
    expect(tracker.takeDeferredPurgeMessages('t-drain')).toEqual([]);
    tracker.releaseThreadPurge('t-drain');
  });

  it('a clear reservation never defers — a wake landing mid-clear is dropped', () => {
    const tracker = new ActiveRunTracker();
    // Clear (the default reason) is about to wipe the thread: deferring would
    // promise a re-dispatch no one makes, so it declines and the caller drops.
    expect(tracker.reserveThreadPurge('t-clear-drop', 'clear')).toBe(true);
    expect(tracker.deferMessageDuringPurge('t-clear-drop', 'message-x')).toBe(false);
    expect(tracker.takeDeferredPurgeMessages('t-clear-drop')).toEqual([]);
    tracker.releaseThreadPurge('t-clear-drop');
  });

  it('release clears any deferred record (no leak)', () => {
    const tracker = new ActiveRunTracker();
    tracker.reserveThreadPurge('t-clear', 'fork');
    tracker.deferMessageDuringPurge('t-clear', 'message-x');
    tracker.releaseThreadPurge('t-clear');
    expect(tracker.takeDeferredPurgeMessages('t-clear')).toEqual([]);
  });
});

describe('ActiveRunTracker — handoff reservations', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    activeRunTracker.clearHandoff('thread-reserve-1');
    activeRunTracker.clearHandoff('thread-reserve-2');
    activeRunTracker.clearHandoff('thread-reserve-3');
  });

  it('hasActiveThread returns true during the reservation window', () => {
    activeRunTracker.reserveHandoff('thread-reserve-1');
    expect(activeRunTracker.hasActiveThread('thread-reserve-1')).toBe(true);
  });

  it('reservation expires after the 15s TTL', () => {
    activeRunTracker.reserveHandoff('thread-reserve-2');
    jest.advanceTimersByTime(16_000);
    expect(activeRunTracker.hasActiveThread('thread-reserve-2')).toBe(false);
  });

  it('active session keeps the thread active even after reservation expires', () => {
    activeRunTracker.startSession('session-reserve-3', 'thread-reserve-3');
    activeRunTracker.reserveHandoff('thread-reserve-3');
    jest.advanceTimersByTime(16_000);
    expect(activeRunTracker.hasActiveThread('thread-reserve-3')).toBe(true);
    activeRunTracker.finishSession('session-reserve-3');
  });

  it('clearHandoff removes the reservation immediately', () => {
    activeRunTracker.reserveHandoff('thread-reserve-1');
    activeRunTracker.clearHandoff('thread-reserve-1');
    expect(activeRunTracker.hasActiveThread('thread-reserve-1')).toBe(false);
  });
});

describe('ActiveRunTracker — finishSession drain-then-delete (drop-race close)', () => {
  it('returns messages that raced into the queue after the flush drain', () => {
    const sessionId = 'session-race-1';
    const threadId = 'thread-race-1';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);

    // Simulate the run-end flush: a first message is queued, then drained
    // (flushAbandonedSessionMessages persists it).
    expect(activeRunTracker.enqueueMessageForThread(threadId, 'm1', 'first')).toBe(true);
    expect(activeRunTracker.drainMessages(sessionId)).toEqual([{ id: 'm1', content: 'first' }]);

    // A send races in during the flush's DB awaits — after the drain, before
    // release. It must be handed back by finishSession, not acked "queued" and
    // then dropped with the queue.
    expect(activeRunTracker.enqueueMessageForThread(threadId, 'm2', 'raced')).toBe(true);

    const straggling = activeRunTracker.finishSession(sessionId);
    expect(straggling).toEqual([{ id: 'm2', content: 'raced' }]);
  });

  it('releases the thread atomically — a later send finds no queue (starts fresh)', () => {
    const sessionId = 'session-race-2';
    const threadId = 'thread-race-2';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);

    expect(activeRunTracker.finishSession(sessionId)).toEqual([]);
    // Session + thread mapping gone: a subsequent send can't enqueue (it would
    // start a fresh run instead of being dropped into a dead queue).
    expect(activeRunTracker.getActiveSessionForThread(threadId)).toBeUndefined();
    expect(activeRunTracker.enqueueMessageForThread(threadId, 'm3', 'after')).toBe(false);
  });
});

describe('ActiveRunTracker — thread released listeners', () => {
  it('tells each listener once the thread is released, never for a stale release', () => {
    const tracker = new ActiveRunTracker();
    const released: string[] = [];
    const off = tracker.onThreadReleased((threadId) => released.push(threadId));
    tracker.onThreadReleased(() => {
      throw new Error('a broken listener');
    });

    expect(tracker.startSession('session-release-1', 'thread-release-1')).toBe(true);
    expect(released).toEqual([]);
    // A broken listener neither breaks the release nor the other listeners.
    tracker.finishSession('session-release-1');
    expect(released).toEqual(['thread-release-1']);
    expect(tracker.hasActiveThread('thread-release-1')).toBe(false);

    // Releasing again (an owner that already lost the lock) tells no one.
    tracker.finishSession('session-release-1');
    expect(released).toEqual(['thread-release-1']);

    off();
    expect(tracker.startSession('session-release-2', 'thread-release-2')).toBe(true);
    tracker.finishSession('session-release-2');
    expect(released).toEqual(['thread-release-1']);
  });
});

describe('ActiveRunTracker — skipped-seed re-dispatch (end-of-run wake loss)', () => {
  it('records a skipped seed against the live session and hands it back on finish', () => {
    const sessionId = 'session-seed-1';
    const threadId = 'thread-seed-1';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);

    // A tool dispatch lands while the run holds the lock. The seed is already
    // persisted in the thread, so it is recorded (not enqueued) for re-dispatch.
    expect(activeRunTracker.recordSkippedSeed(threadId, 'seed-msg-1')).toBe(true);

    // The dispatch finally takes the skipped seeds before finishSession.
    expect(activeRunTracker.takeSkippedSeeds(sessionId)).toEqual(['seed-msg-1']);
    expect(activeRunTracker.finishSession(sessionId)).toEqual([]);
  });

  it('dedupes repeat skips of the same message id to a single re-dispatch', () => {
    const sessionId = 'session-seed-2';
    const threadId = 'thread-seed-2';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);

    // Same message id skipped several times (multiple iterations still busy) →
    // one recorded seed, so exactly one post-run re-dispatch.
    activeRunTracker.recordSkippedSeed(threadId, 'seed-dup');
    activeRunTracker.recordSkippedSeed(threadId, 'seed-dup');
    activeRunTracker.recordSkippedSeed(threadId, 'seed-dup');

    expect(activeRunTracker.takeSkippedSeeds(sessionId)).toEqual(['seed-dup']);
    activeRunTracker.finishSession(sessionId);
  });

  it('collects multiple distinct skipped seeds in arrival order', () => {
    const sessionId = 'session-seed-3';
    const threadId = 'thread-seed-3';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);

    activeRunTracker.recordSkippedSeed(threadId, 'seed-a');
    activeRunTracker.recordSkippedSeed(threadId, 'seed-b');

    expect(activeRunTracker.takeSkippedSeeds(sessionId)).toEqual(['seed-a', 'seed-b']);
    activeRunTracker.finishSession(sessionId);
  });

  it('takeSkippedSeeds drains once — a second take returns empty', () => {
    const sessionId = 'session-seed-4';
    const threadId = 'thread-seed-4';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);
    activeRunTracker.recordSkippedSeed(threadId, 'seed-once');

    expect(activeRunTracker.takeSkippedSeeds(sessionId)).toEqual(['seed-once']);
    // Drained: the seed cannot be re-dispatched twice.
    expect(activeRunTracker.takeSkippedSeeds(sessionId)).toEqual([]);
    activeRunTracker.finishSession(sessionId);
  });

  it('refuses to record when no session is active for the thread (caller starts fresh)', () => {
    // No startSession — the thread is idle, so a tool dispatch would not be
    // skipped; recordSkippedSeed returns false so the caller keeps no_dispatch.
    expect(activeRunTracker.recordSkippedSeed('thread-idle', 'seed-x')).toBe(false);
  });

  it('finishSession clears skipped seeds as a safety net if take was missed', () => {
    const sessionId = 'session-seed-5';
    const threadId = 'thread-seed-5';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);
    activeRunTracker.recordSkippedSeed(threadId, 'seed-leak');

    // finishSession without a preceding take() must still drop the record so it
    // cannot leak into a later session on the same id.
    activeRunTracker.finishSession(sessionId);
    // New run on the same thread starts with an empty skipped-seed set.
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);
    expect(activeRunTracker.takeSkippedSeeds(sessionId)).toEqual([]);
    activeRunTracker.finishSession(sessionId);
  });
});

describe('ActiveRunTracker — progress tracking (zombie-reaper feed)', () => {
  it('a fresh session is not stalled; it stalls once its progress timestamp ages', async () => {
    const sessionId = 'session-progress-1';
    const threadId = 'thread-progress-1';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);

    expect(activeRunTracker.listStalledSessions(50)).toEqual([]);
    await new Promise((r) => setTimeout(r, 80));

    const stalled = activeRunTracker.listStalledSessions(50);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toMatchObject({ sessionId, threadId });
    expect(stalled[0]!.stalledMs).toBeGreaterThanOrEqual(50);
    activeRunTracker.finishSession(sessionId);
  });

  it('noteProgress resets the stall clock', async () => {
    const sessionId = 'session-progress-2';
    const threadId = 'thread-progress-2';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);

    await new Promise((r) => setTimeout(r, 80));
    activeRunTracker.noteProgress(sessionId);

    expect(activeRunTracker.listStalledSessions(50)).toEqual([]);
    activeRunTracker.finishSession(sessionId);
  });

  it('finishSession clears the progress record; noteProgress on a dead session is a no-op', () => {
    const sessionId = 'session-progress-3';
    const threadId = 'thread-progress-3';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);
    activeRunTracker.finishSession(sessionId);

    activeRunTracker.noteProgress(sessionId);
    expect(activeRunTracker.listStalledSessions(0)).toEqual([]);
  });

  it('queued messages keep their persisted flag through drain and finish', () => {
    const sessionId = 'session-progress-4';
    const threadId = 'thread-progress-4';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);

    expect(
      activeRunTracker.enqueueMessageForThread(threadId, 'm-p1', 'persisted first', undefined, true)
    ).toBe(true);
    expect(activeRunTracker.enqueueMessageForThread(threadId, 'm-p2', 'legacy memory-only')).toBe(
      true
    );

    const drained = activeRunTracker.finishSession(sessionId);
    expect(drained).toEqual([
      { id: 'm-p1', content: 'persisted first', persisted: true },
      { id: 'm-p2', content: 'legacy memory-only' },
    ]);
  });
});

// Per-logical-turn run stats, the feed for the run-ended thread_event. A runId
// is one model attempt, so the thing that must be one-per-turn (not one-per-run)
// is the aggregation itself.
describe('ActiveRunTracker — per-turn run stats (run-ended narration feed)', () => {
  const work = (threadId: string, agentId: string) => ({
    agentId,
    agentName: 'Nova',
    threadId,
    threadTitle: 'Thread',
  });

  it('reports the agent, elapsed time, and tool-call count for a turn', async () => {
    const threadId = 'thread-stats-1';
    activeRunTracker.start('run-stats-1', work(threadId, 'agent-1'));
    activeRunTracker.noteToolCall('run-stats-1');
    activeRunTracker.noteToolCall('run-stats-1');
    await new Promise((r) => setTimeout(r, 20));
    activeRunTracker.finish('run-stats-1');

    const summary = activeRunTracker.takeTurnSummary(threadId, 'agent-1');
    expect(summary).toMatchObject({ agentName: 'Nova', toolCalls: 2 });
    expect(summary!.durationMs).toBeGreaterThanOrEqual(15);
  });

  it('collapses a model fallback into one turn — clock unbroken, tool calls combined', async () => {
    const threadId = 'thread-stats-2';
    // Attempt 1 fails after a tool call; attempt 2 (a different runId, same
    // logical turn) makes two more.
    activeRunTracker.start('run-attempt-1', work(threadId, 'agent-1'));
    activeRunTracker.noteToolCall('run-attempt-1');
    await new Promise((r) => setTimeout(r, 20));
    activeRunTracker.finish('run-attempt-1');

    activeRunTracker.start('run-attempt-2', work(threadId, 'agent-1'));
    activeRunTracker.noteToolCall('run-attempt-2');
    activeRunTracker.noteToolCall('run-attempt-2');
    activeRunTracker.finish('run-attempt-2');

    const summary = activeRunTracker.takeTurnSummary(threadId, 'agent-1');
    expect(summary).toMatchObject({ toolCalls: 3 });
    // The second attempt did not restart the clock.
    expect(summary!.durationMs).toBeGreaterThanOrEqual(15);
  });

  it('is consumed exactly once — a double teardown cannot narrate the same turn twice', () => {
    const threadId = 'thread-stats-3';
    activeRunTracker.start('run-stats-3', work(threadId, 'agent-1'));
    activeRunTracker.finish('run-stats-3');

    expect(activeRunTracker.takeTurnSummary(threadId, 'agent-1')).not.toBeNull();
    expect(activeRunTracker.takeTurnSummary(threadId, 'agent-1')).toBeNull();
  });

  it('returns null for a turn that never opened a run', () => {
    expect(activeRunTracker.takeTurnSummary('thread-stats-4', 'agent-1')).toBeNull();
  });

  it('keeps each agent in a group thread separate', () => {
    const threadId = 'thread-stats-5';
    activeRunTracker.start('run-a', work(threadId, 'agent-a'));
    activeRunTracker.start('run-b', { ...work(threadId, 'agent-b'), agentName: 'Vega' });
    activeRunTracker.noteToolCall('run-a');
    activeRunTracker.noteToolCall('run-b');
    activeRunTracker.noteToolCall('run-b');

    expect(activeRunTracker.takeTurnSummary(threadId, 'agent-a')).toMatchObject({
      agentName: 'Nova',
      toolCalls: 1,
    });
    expect(activeRunTracker.takeTurnSummary(threadId, 'agent-b')).toMatchObject({
      agentName: 'Vega',
      toolCalls: 2,
    });
    activeRunTracker.finish('run-a');
    activeRunTracker.finish('run-b');
  });

  it('ignores a tool call with no run id and one from an unknown run', () => {
    expect(() => {
      activeRunTracker.noteToolCall(null);
      activeRunTracker.noteToolCall(undefined);
      activeRunTracker.noteToolCall('run-never-started');
    }).not.toThrow();
  });

  it('releasing the thread lock sweeps stats an abnormal unwind left behind', () => {
    const sessionId = 'session-stats-6';
    const threadId = 'thread-stats-6';
    expect(activeRunTracker.startSession(sessionId, threadId)).toBe(true);
    activeRunTracker.start('run-stats-6', work(threadId, 'agent-1'));

    activeRunTracker.finishSession(sessionId);

    expect(activeRunTracker.takeTurnSummary(threadId, 'agent-1')).toBeNull();
  });
});

describe('ActiveRunTracker — run tokens on reused session ids', () => {
  it('a stale owner cannot release a newer run that reused the session id', () => {
    const tracker = new ActiveRunTracker();
    expect(tracker.startSession('session-reused', 'thread-reused')).toBe(true);
    const staleToken = tracker.sessionRunToken('session-reused');
    expect(staleToken).toBeDefined();

    // Force-released (reaper), then a new send starts a fresh run.
    tracker.finishSession('session-reused');
    expect(tracker.startSession('session-reused', 'thread-reused')).toBe(true);
    tracker.enqueueMessageForThread('thread-reused', 'msg-new', 'hello', undefined, true);
    tracker.recordSkippedSeed('thread-reused', 'msg-seed');
    expect(tracker.sessionRunToken('session-reused')).not.toBe(staleToken);

    expect(tracker.takeSkippedSeeds('session-reused', staleToken)).toEqual([]);
    expect(tracker.finishSession('session-reused', staleToken)).toEqual([]);
    expect(tracker.getActiveSessionForThread('thread-reused')).toBe('session-reused');

    // The live owner still releases normally.
    const liveToken = tracker.sessionRunToken('session-reused')!;
    expect(tracker.takeSkippedSeeds('session-reused', liveToken)).toEqual(['msg-seed']);
    expect(tracker.finishSession('session-reused', liveToken).map((m) => m.id)).toEqual([
      'msg-new',
    ]);
    expect(tracker.hasActiveThread('thread-reused')).toBe(false);
  });
});
