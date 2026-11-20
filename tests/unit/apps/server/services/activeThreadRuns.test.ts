/**
 * Active-thread run markers: a thread with a live agent run gets a
 * `▶ running (<agent>)` marker; an idle thread — or one whose run has gone
 * stale/dead (past the reaper's zombie window) — gets none. Liveness reuses the
 * in-memory ActiveRunTracker signal, so a stale DB `runs.status='running'` row
 * is never reported as active.
 */

const getRunningAgentNamesByThread = jest.fn();
jest.mock('@snaglet/db/tables/runs', () => ({
  Runs: {
    getRunningAgentNamesByThread: (...args: unknown[]) => getRunningAgentNamesByThread(...args),
  },
}));

import { activeRunTracker } from '@server/services/ActiveRunTracker';
import { REAPER_STALL_DEFAULT_MS } from '@server/services/RunReaperService';
import { activeRunMarker, getThreadActivity } from '@server/services/activeThreadRuns';

const LIVE_THREAD = 'thread-live-marker';
const LIVE_SESSION = 'session-live-marker';
const LIVE_RUN = 'run-live-marker';
const STALE_RUN = 'run-stale-sibling';
const IDLE_THREAD = 'thread-idle-marker';
const STALE_THREAD = 'thread-stale-marker';
const STALE_SESSION = 'session-stale-marker';

describe('activeRunMarker', () => {
  it('names the running agent(s)', () => {
    expect(activeRunMarker({ agentNames: ['Clio'] })).toBe('▶ running (Clio)');
    expect(activeRunMarker({ agentNames: ['Clio', 'Venus'] })).toBe('▶ running (Clio, Venus)');
  });

  it('falls back to a bare marker when no agent can be named', () => {
    expect(activeRunMarker({ agentNames: [] })).toBe('▶ running');
  });

  it('is empty for an idle (absent) thread', () => {
    expect(activeRunMarker(undefined)).toBe('');
  });
});

describe('getThreadActivity — liveness gated by ActiveRunTracker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    getRunningAgentNamesByThread.mockResolvedValue([
      { runId: LIVE_RUN, threadId: LIVE_THREAD, agentName: 'Clio' },
    ]);
  });

  afterEach(() => {
    activeRunTracker.finish(LIVE_RUN);
    activeRunTracker.finish(STALE_RUN);
    activeRunTracker.finishSession(LIVE_SESSION);
    activeRunTracker.finishSession(STALE_SESSION);
    jest.useRealTimers();
  });

  it('marks a thread with a live run and names its agent', async () => {
    activeRunTracker.startSession(LIVE_SESSION, LIVE_THREAD);
    activeRunTracker.start(LIVE_RUN); // the in-flight run the marker names

    const activity = await getThreadActivity([LIVE_THREAD, IDLE_THREAD]);

    expect(activity.get(LIVE_THREAD)).toEqual({ agentNames: ['Clio'] });
    expect(activeRunMarker(activity.get(LIVE_THREAD))).toBe('▶ running (Clio)');
    // Idle thread has no live session — absent, no marker.
    expect(activity.has(IDLE_THREAD)).toBe(false);
    // Exactly one batched lookup, scoped to the live thread only (no N+1).
    expect(getRunningAgentNamesByThread).toHaveBeenCalledTimes(1);
    expect(getRunningAgentNamesByThread).toHaveBeenCalledWith([LIVE_THREAD]);
  });

  it('names only the actually-live run, not a stale sibling running row', async () => {
    // The tracker allows one live session per thread, but the DB can hold a
    // second `status='running'` row for a crashed/reaped prior agent that never
    // flipped status. Only the live run id (LIVE_RUN) is in-flight; the stale
    // sibling (STALE_RUN → Venus) must not leak into the marker.
    getRunningAgentNamesByThread.mockResolvedValueOnce([
      { runId: LIVE_RUN, threadId: LIVE_THREAD, agentName: 'Clio' },
      { runId: STALE_RUN, threadId: LIVE_THREAD, agentName: 'Venus' },
    ]);
    activeRunTracker.startSession(LIVE_SESSION, LIVE_THREAD);
    activeRunTracker.start(LIVE_RUN); // STALE_RUN is intentionally not started

    const activity = await getThreadActivity([LIVE_THREAD]);

    expect(activity.get(LIVE_THREAD)).toEqual({ agentNames: ['Clio'] });
    expect(activeRunMarker(activity.get(LIVE_THREAD))).toBe('▶ running (Clio)');
  });

  it('falls back to a bare marker when the live thread has no in-flight run row', async () => {
    // Session holds the thread lock but no run is currently executing (the brief
    // between-runs window). Liveness still shows the marker; the name is dropped
    // rather than mis-attributed to a stale running row.
    activeRunTracker.startSession(LIVE_SESSION, LIVE_THREAD); // no start(LIVE_RUN)

    const activity = await getThreadActivity([LIVE_THREAD]);

    expect(activity.get(LIVE_THREAD)).toEqual({ agentNames: [] });
    expect(activeRunMarker(activity.get(LIVE_THREAD))).toBe('▶ running');
  });

  it('does not mark a stale/dead run (stalled past the reaper window)', async () => {
    activeRunTracker.startSession(STALE_SESSION, STALE_THREAD);
    // No progress for the whole zombie window: the reaper would force-release
    // this run, so it must read as not running.
    jest.advanceTimersByTime(REAPER_STALL_DEFAULT_MS + 1_000);

    const activity = await getThreadActivity([STALE_THREAD]);

    expect(activity.has(STALE_THREAD)).toBe(false);
    expect(activeRunMarker(activity.get(STALE_THREAD))).toBe('');
    // Nothing live → zero DB round-trips.
    expect(getRunningAgentNamesByThread).not.toHaveBeenCalled();
  });

  it('still marks a live thread with no name when the agent lookup returns nothing', async () => {
    getRunningAgentNamesByThread.mockResolvedValueOnce([]);
    activeRunTracker.startSession(LIVE_SESSION, LIVE_THREAD);

    const activity = await getThreadActivity([LIVE_THREAD]);

    expect(activity.get(LIVE_THREAD)).toEqual({ agentNames: [] });
    expect(activeRunMarker(activity.get(LIVE_THREAD))).toBe('▶ running');
  });
});
