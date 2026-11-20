/**
 * Floor-gated generation — the generation half of the per-thread speaking
 * floor. One agent generates at a time: before a model call an agent acquires
 * the floor; if a peer holds it the run parks (FIFO, abortable,
 * backstop-bounded); the floor frees for the next generator on playback
 * completion (not generation), except during tool work when it frees at once;
 * session teardown resumes all parked runs immediately.
 */

jest.mock('@server/config/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  openFloor,
  closeFloor,
  enqueueUtterance,
  notePlaybackDone,
  clearFloorForBargeIn,
  acquireGenerationFloor,
  releaseGenerationFloor,
  releaseGenerationFloorAfterPlayback,
  __genFloorSnapshot,
  __resetFloors,
  type FloorJob,
} from '@server/services/SocketService/voiceSession/floorArbiter';
import {
  buildVoiceCatchUpBlocks,
  type VoiceCatchUpCursor,
} from '@server/services/SocketService/handlers/chatPhases/voiceCatchUp';
import type { MessageRow } from '@snaglet/db/tables/messages';

const THREAD = 'thread-1';
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function makeSink() {
  const holders: (string | null)[] = [];
  return { sink: { emitFloor: (h: string | null) => holders.push(h) }, holders };
}

/** An audio job whose play() resolves immediately and records that it started. */
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

describe('acquire / park FIFO', () => {
  it('grants the free floor immediately and parks a second acquirer', async () => {
    openFloor(THREAD, makeSink().sink);

    const a = await acquireGenerationFloor(THREAD, 'A');
    expect(a).toBe('acquired');
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ holder: 'A', waiting: [] });

    // B parks — its promise stays pending while A holds the floor.
    let bOutcome: string | null = null;
    const bPromise = acquireGenerationFloor(THREAD, 'B').then((o) => (bOutcome = o));
    await tick();
    expect(bOutcome).toBeNull();
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ holder: 'A', waiting: ['B'] });

    // A releases → B is granted (FIFO head).
    releaseGenerationFloor(THREAD, 'A');
    await bPromise;
    expect(bOutcome).toBe('acquired');
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ holder: 'B', waiting: [] });
  });

  it('serializes three acquirers strictly in arrival order', async () => {
    openFloor(THREAD, makeSink().sink);
    const order: string[] = [];

    await acquireGenerationFloor(THREAD, 'A');
    order.push('A');
    void acquireGenerationFloor(THREAD, 'B').then(() => order.push('B'));
    void acquireGenerationFloor(THREAD, 'C').then(() => order.push('C'));
    await tick();
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ waiting: ['B', 'C'] });

    releaseGenerationFloor(THREAD, 'A');
    await tick();
    releaseGenerationFloor(THREAD, 'B');
    await tick();
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('returns no-session when the thread has no voice session', async () => {
    expect(await acquireGenerationFloor('unknown-thread', 'A')).toBe('no-session');
  });
});

describe('abort while parked (immediate + clean)', () => {
  it('settles aborted the moment the run signal fires and drops the waiter', async () => {
    openFloor(THREAD, makeSink().sink);
    await acquireGenerationFloor(THREAD, 'A'); // A holds

    const ac = new AbortController();
    let bOutcome: string | null = null;
    const bPromise = acquireGenerationFloor(THREAD, 'B', { signal: ac.signal }).then(
      (o) => (bOutcome = o)
    );
    await tick();
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ waiting: ['B'] });

    ac.abort();
    await bPromise;
    expect(bOutcome).toBe('aborted');
    // Waiter removed — a later A release must not grant an aborted run.
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ waiting: [] });
    releaseGenerationFloor(THREAD, 'A');
    await tick();
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ holder: null, waiting: [] });
  });

  it('resolves aborted synchronously when the signal is already aborted', async () => {
    openFloor(THREAD, makeSink().sink);
    await acquireGenerationFloor(THREAD, 'A');
    const ac = new AbortController();
    ac.abort();
    expect(await acquireGenerationFloor(THREAD, 'B', { signal: ac.signal })).toBe('aborted');
  });
});

describe('release during tool execution', () => {
  it('frees the floor immediately (no playback wait) so a peer generates', async () => {
    openFloor(THREAD, makeSink().sink);
    await acquireGenerationFloor(THREAD, 'A');
    let bGranted = false;
    void acquireGenerationFloor(THREAD, 'B').then(() => (bGranted = true));
    await tick();

    // A drops into silent tool work → immediate release, immediate grant.
    releaseGenerationFloor(THREAD, 'A');
    await tick();
    expect(bGranted).toBe(true);
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ holder: 'B', pendingDrainGrant: false });
  });
});

describe('free on playback completion', () => {
  it('holds the next generator until the speaker audio finishes playing', async () => {
    openFloor(THREAD, makeSink().sink);
    const started: string[] = [];

    // A holds the generation floor and its utterance is on the audio floor.
    await acquireGenerationFloor(THREAD, 'A');
    enqueueUtterance(THREAD, job('uA', 'A', 'runA', started));
    await tick();

    let bGranted = false;
    void acquireGenerationFloor(THREAD, 'B').then(() => (bGranted = true));
    await tick();

    // A's turn ends: release-on-playback. Audio still playing → B stays parked.
    releaseGenerationFloorAfterPlayback(THREAD, 'A');
    await tick();
    expect(bGranted).toBe(false);
    expect(__genFloorSnapshot(THREAD)).toMatchObject({
      holder: null,
      waiting: ['B'],
      pendingDrainGrant: true,
    });

    // Client reports playback done → audio floor drains → B is granted now.
    notePlaybackDone(THREAD, 'uA');
    await tick();
    expect(bGranted).toBe(true);
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ holder: 'B', pendingDrainGrant: false });
  });

  it('grants immediately when no audio is pending for the speaker', async () => {
    openFloor(THREAD, makeSink().sink);
    await acquireGenerationFloor(THREAD, 'A');
    let bGranted = false;
    void acquireGenerationFloor(THREAD, 'B').then(() => (bGranted = true));
    await tick();

    // Nothing on the audio floor (e.g. utterance filtered as non-speakable).
    releaseGenerationFloorAfterPlayback(THREAD, 'A');
    await tick();
    expect(bGranted).toBe(true);
  });
});

describe('backstop timeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('resolves backstop and proceeds without the floor if it never frees', async () => {
    openFloor(THREAD, makeSink().sink);
    await acquireGenerationFloor(THREAD, 'A'); // A holds forever (never releases)

    let bOutcome: string | null = null;
    const bPromise = acquireGenerationFloor(THREAD, 'B', { backstopMs: 1000 }).then(
      (o) => (bOutcome = o)
    );
    await Promise.resolve();
    expect(bOutcome).toBeNull();

    await jest.advanceTimersByTimeAsync(1001);
    await bPromise;
    expect(bOutcome).toBe('backstop');
    // Backstop dropped the waiter; the floor is still A's (proceed without it).
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ holder: 'A', waiting: [] });
  });
});

describe('session teardown resumes parked runs', () => {
  it('settles every parked waiter teardown on closeFloor', async () => {
    openFloor(THREAD, makeSink().sink);
    await acquireGenerationFloor(THREAD, 'A');

    const outcomes: string[] = [];
    const bP = acquireGenerationFloor(THREAD, 'B').then((o) => outcomes.push(o));
    const cP = acquireGenerationFloor(THREAD, 'C').then((o) => outcomes.push(o));
    await tick();
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ waiting: ['B', 'C'] });

    closeFloor(THREAD);
    await Promise.all([bP, cP]);
    expect(outcomes).toEqual(['teardown', 'teardown']);
    // Floor fully gone — a later acquire reports no-session.
    expect(await acquireGenerationFloor(THREAD, 'D')).toBe('no-session');
  });
});

describe('barge-in clears a lingering drain grant', () => {
  it('resets pendingDrainGrant so a fresh acquire is not wedged', async () => {
    openFloor(THREAD, makeSink().sink);
    const started: string[] = [];
    await acquireGenerationFloor(THREAD, 'A');
    enqueueUtterance(THREAD, job('uA', 'A', 'runA', started));
    await tick();
    releaseGenerationFloorAfterPlayback(THREAD, 'A');
    await tick();
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ pendingDrainGrant: true });

    // User barges in (flushes audio). The drain grant can no longer fire from an
    // advance() — barge-in must clear it so the next speaker isn't stuck parking.
    clearFloorForBargeIn(THREAD);
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ pendingDrainGrant: false });
    expect(await acquireGenerationFloor(THREAD, 'B')).toBe('acquired');
  });
});

describe('mid-tool barge-in hands the free floor to an already-parked waiter', () => {
  it('grants the parked waiter promptly instead of stranding it on the backstop', async () => {
    openFloor(THREAD, makeSink().sink);
    const started: string[] = [];

    // A speaks, then ends its turn on playback while its audio is still on the
    // floor: the generation floor is free (genHolder=null) but a drain grant is
    // pending until the audio finishes playing.
    await acquireGenerationFloor(THREAD, 'A');
    enqueueUtterance(THREAD, job('uA', 'A', 'runA', started));
    await tick();
    releaseGenerationFloorAfterPlayback(THREAD, 'A');
    await tick();

    // D reaches the gate and parks — the pending drain grant blocks the fast path.
    let dGranted = false;
    const dAcquire = acquireGenerationFloor(THREAD, 'D').then((o) => {
      dGranted = o === 'acquired';
    });
    await tick();
    expect(dGranted).toBe(false);
    expect(__genFloorSnapshot(THREAD)).toMatchObject({
      holder: null,
      waiting: ['D'],
      pendingDrainGrant: true,
    });

    // User barges in mid-tool (the inject branch does no run abort). The audio is
    // flushed, so the deferred drain grant can no longer fire from advance(). With
    // a free floor, barge-in must hand it straight to D — not leave it parked to
    // time out on the 45 s backstop. Awaiting the acquire (no fake timers) proves
    // the grant is prompt: otherwise this promise would never resolve here.
    clearFloorForBargeIn(THREAD);
    await dAcquire;
    expect(dGranted).toBe(true);
    expect(__genFloorSnapshot(THREAD)).toMatchObject({
      holder: 'D',
      waiting: [],
      pendingDrainGrant: false,
    });
  });
});

/**
 * Group pacing: two agents woken together serialize their model calls — the
 * second parks behind the first, and once granted its catch-up context
 * includes the first's spoken utterance. Composes floor FIFO (serialize) and
 * buildVoiceCatchUpBlocks (freshness).
 */
describe('two agents woken together serialize + catch up (group pacing)', () => {
  it('second parks behind the first and its catch-up includes the first utterance', async () => {
    openFloor(THREAD, makeSink().sink);
    const agentNameMap = new Map([
      ['agent-A', 'Ada'],
      ['agent-B', 'Boron'],
    ]);

    // Both start their turns and reach the floor gate. A wins (arrives first).
    const aOut = await acquireGenerationFloor(THREAD, 'agent-A');
    expect(aOut).toBe('acquired');

    // B reaches the gate → parks (A holds the floor): its model call is deferred.
    let bGranted = false;
    const bAcquire = acquireGenerationFloor(THREAD, 'agent-B').then((o) => {
      bGranted = o === 'acquired';
    });
    await tick();
    expect(bGranted).toBe(false);
    expect(__genFloorSnapshot(THREAD)).toMatchObject({ holder: 'agent-A', waiting: ['agent-B'] });

    // A speaks a terminal utterance (persisted as an assistant row after B's
    // context was assembled) and ends its turn on playback completion.
    const aUtteranceRow: MessageRow = {
      id: 'msg-A1',
      threadId: THREAD,
      agentId: 'agent-A',
      userId: null,
      role: 'assistant',
      content: 'On it — pulling the numbers now.',
      messageType: 'message',
      resolved: false,
      createdAt: '2026-07-05T00:00:01.000Z',
      responseOptions: null,
      thinkingContent: null,
      toolActivity: null,
      injectedDuringRun: false,
      usage: null,
      runId: 'runA',
      runError: null,
      contextPacks: null,
      metadata: null,
    };
    releaseGenerationFloorAfterPlayback(THREAD, 'agent-A');
    // (no audio job enqueued in this composed test → grant fires immediately)
    await bAcquire;
    expect(bGranted).toBe(true);

    // B, now generating, catches up on everything since its watermark. The
    // watermark is the user trigger; A's utterance landed after it.
    const bWatermark: VoiceCatchUpCursor = {
      createdAt: '2026-07-05T00:00:00.000Z',
      id: 'msg-user-trigger',
    };
    void bWatermark; // (the cursor the turn loop would carry into listAfter)
    const { blocks } = buildVoiceCatchUpBlocks([aUtteranceRow], {
      selfAgentId: 'agent-B',
      agentNameMap,
    });
    // B's model context now contains what Ada just said — it responds to both the
    // user and the first speaker.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('Ada');
    expect(blocks[0]).toContain('On it — pulling the numbers now.');
  });
});
