/**
 * floorArbiter — one speaker at a time, FIFO, freed on playback (not
 * generation), heartbeat auto-advance, user barge-in preemption + flush.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  openFloor,
  enqueueUtterance,
  notePlaybackDone,
  clearFloorForBargeIn,
  __floorSnapshot,
  __resetFloors,
  type FloorJob,
} from '@server/services/SocketService/voiceSession/floorArbiter';
import { FLOOR_HEARTBEAT_TIMEOUT_MS } from '@server/services/SocketService/voiceSession/constants';

const THREAD = 'thread-1';

const tick = () => new Promise((r) => setImmediate(r));

function makeSink() {
  const holders: (string | null)[] = [];
  return { sink: { emitFloor: (h: string | null) => holders.push(h) }, holders };
}

/** A job whose play() resolves immediately and records that it started. */
function job(id: string, agentId: string, runId: string, started: string[]): FloorJob {
  return {
    utteranceId: id,
    agentId,
    runId,
    play: async () => {
      started.push(id);
    },
  };
}

afterEach(() => __resetFloors());

describe('floorArbiter FIFO + playback:done', () => {
  it('plays one utterance at a time and advances only on playback:done', async () => {
    const { sink, holders } = makeSink();
    const started: string[] = [];
    openFloor(THREAD, sink);

    enqueueUtterance(THREAD, job('u1', 'A', 'run1', started));
    enqueueUtterance(THREAD, job('u2', 'B', 'run2', started));
    await tick();

    // Only the head is speaking; the second waits behind it.
    expect(started).toEqual(['u1']);
    expect(__floorSnapshot(THREAD)).toEqual({ holder: 'A', queued: 1 });

    notePlaybackDone(THREAD, 'u1');
    await tick();
    expect(started).toEqual(['u1', 'u2']);
    expect(__floorSnapshot(THREAD)).toEqual({ holder: 'B', queued: 0 });

    notePlaybackDone(THREAD, 'u2');
    await tick();
    // Floor drains → holder null broadcast at the end.
    expect(holders[holders.length - 1]).toBeNull();
  });

  it('ignores a stale/duplicate playback:done for a non-holder', async () => {
    const { sink } = makeSink();
    const started: string[] = [];
    openFloor(THREAD, sink);
    enqueueUtterance(THREAD, job('u1', 'A', 'run1', started));
    enqueueUtterance(THREAD, job('u2', 'B', 'run2', started));
    await tick();

    notePlaybackDone(THREAD, 'u2'); // not the current holder
    await tick();
    expect(__floorSnapshot(THREAD)).toEqual({ holder: 'A', queued: 1 });
  });
});

describe('floorArbiter heartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('auto-advances when playback:done never arrives', async () => {
    const { sink } = makeSink();
    const started: string[] = [];
    openFloor(THREAD, sink);
    enqueueUtterance(THREAD, job('u1', 'A', 'run1', started));
    enqueueUtterance(THREAD, job('u2', 'B', 'run2', started));
    await Promise.resolve();

    expect(__floorSnapshot(THREAD)?.holder).toBe('A');
    // No playback:done → heartbeat fires → next speaker starts.
    await jest.advanceTimersByTimeAsync(FLOOR_HEARTBEAT_TIMEOUT_MS + 1);
    expect(started).toEqual(['u1', 'u2']);
    expect(__floorSnapshot(THREAD)?.holder).toBe('B');
  });
});

describe('floorArbiter barge-in', () => {
  it('clears the floor and flushes pending audio for the interrupted run', async () => {
    const { sink } = makeSink();
    const started: string[] = [];
    openFloor(THREAD, sink);
    // Two utterances from the same run — barge-in must flush the queued one.
    enqueueUtterance(THREAD, job('u1', 'A', 'run1', started));
    enqueueUtterance(THREAD, job('u2', 'A', 'run1', started));
    await tick();

    const interrupted = clearFloorForBargeIn(THREAD);
    await tick();
    expect(interrupted).toBe('A');
    // u2 (same run) was flushed; nothing else spoke; floor is free.
    expect(started).toEqual(['u1']);
    expect(__floorSnapshot(THREAD)).toEqual({ holder: null, queued: 0 });
  });

  it('keeps queued audio from other runs after a barge-in', async () => {
    const { sink } = makeSink();
    const started: string[] = [];
    openFloor(THREAD, sink);
    enqueueUtterance(THREAD, job('u1', 'A', 'run1', started));
    enqueueUtterance(THREAD, job('u2', 'B', 'run2', started));
    await tick();

    const interrupted = clearFloorForBargeIn(THREAD);
    await tick();
    expect(interrupted).toBe('A');
    // run2's utterance survives and takes the floor.
    expect(started).toEqual(['u1', 'u2']);
    expect(__floorSnapshot(THREAD)?.holder).toBe('B');
  });

  it('returns null when nothing is speaking', () => {
    const { sink } = makeSink();
    openFloor(THREAD, sink);
    expect(clearFloorForBargeIn(THREAD)).toBeNull();
  });
});
