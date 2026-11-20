/**
 * floorArbiter — the per-thread speaking floor.
 *
 * One talker at a time. Utterances enter a FIFO; the head holds the floor while
 * its audio streams and plays; the next starts only after the client reports
 * voice:playback:done for the head (or a heartbeat timeout auto-advances so a
 * vanished client cannot wedge the queue). The user always preempts: barge-in
 * clears the floor immediately and flushes any pending audio for the interrupted
 * agent's current run.
 *
 * The arbiter is transport-agnostic: a `FloorSink` (installed by
 * VoiceSessionService for the owning client) carries floor + tts frames down.
 * Audio synthesis lives in ttsPipeline, handed in as `job.play(signal)`.
 */

import { logger } from '@server/config/logger';
import { getErrorMessage } from '@snaglet/shared/utils';
import { FLOOR_HEARTBEAT_TIMEOUT_MS } from './constants';

/**
 * Floor-gated generation backstop. A parked run must never wedge: if the floor never
 * frees (a vanished client that also dodged the heartbeat, or a lost drain
 * grant), acquireGenerationFloor resolves 'backstop' after this window so the
 * turn proceeds without the floor rather than hanging. Deliberately longer than
 * FLOOR_HEARTBEAT_TIMEOUT_MS (30s) so the normal playback/heartbeat-driven
 * advance always wins first; this is the last-ditch safety valve. Env-tunable.
 */
const FLOOR_ACQUIRE_BACKSTOP_MS = ((): number => {
  const raw = Number(process.env.SNAGLET_VOICE_FLOOR_BACKSTOP_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
})();

/** How acquireGenerationFloor resolved (never rejects — every path is an outcome). */
export type FloorAcquireOutcome =
  /** The agent holds the generation floor; it must release it later. */
  | 'acquired'
  /** The run's abort signal fired while parked (barge-in / disconnect). */
  | 'aborted'
  /** The backstop timer fired — proceed without the floor (never wedge). */
  | 'backstop'
  /** The voice session ended while parked — resume immediately as a text run. */
  | 'teardown'
  /** No voice session on this thread — nothing to gate; proceed immediately. */
  | 'no-session';

export interface FloorJob {
  readonly utteranceId: string;
  readonly agentId: string;
  readonly runId: string;
  /** Stream this utterance's audio; must resolve when the last chunk is sent
   *  and honor `signal` (aborts on barge-in). */
  readonly play: (signal: AbortSignal) => Promise<void>;
}

/** Where floor transitions + audio frames go (the owning voice client). */
export interface FloorSink {
  emitFloor(holder: string | null): void;
}

/**
 * One run parked before its model call, waiting to hold the generation floor
 * (distinct from the audio-playback `current`/`queue` slots on the same floor —
 * one floor concept, two coupled roles: who may generate, and whose audio plays).
 */
interface GenWaiter {
  readonly agentId: string;
  /** Resolve the acquire() promise exactly once; also runs cleanup(). */
  settle(outcome: FloorAcquireOutcome): void;
  /** Detach the abort listener + clear the backstop timer. */
  cleanup(): void;
}

interface ThreadFloor {
  sink: FloorSink;
  queue: FloorJob[];
  current: FloorJob | null;
  /** Aborts the current job's play() on barge-in. */
  currentAbort: AbortController | null;
  /** Resolves the current holder's playback wait (playback:done or timeout). */
  playbackResolver: (() => void) | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  /** Guard so overlapping advance() calls cannot double-start the queue head. */
  advancing: boolean;
  // Generation floor (floor-gated generation)
  /** Agent currently permitted to run a model call, or null when free. */
  genHolder: string | null;
  /** FIFO of parked runs waiting to generate. */
  genWaiters: GenWaiter[];
  /**
   * True after a release-on-playback while this speaker's audio is still
   * playing: the next generator is not granted until the audio floor drains
   * (freeing the floor on playback completion, not generation completion).
   */
  pendingDrainGrant: boolean;
}

const floors = new Map<string, ThreadFloor>();

function getFloor(threadId: string): ThreadFloor | undefined {
  return floors.get(threadId);
}

/** Install the audio sink for a thread's floor (voice session start). */
export function openFloor(threadId: string, sink: FloorSink): void {
  const existing = floors.get(threadId);
  if (existing) {
    existing.sink = sink;
    return;
  }
  floors.set(threadId, {
    sink,
    queue: [],
    current: null,
    currentAbort: null,
    playbackResolver: null,
    heartbeatTimer: null,
    advancing: false,
    genHolder: null,
    genWaiters: [],
    pendingDrainGrant: false,
  });
}

/** Tear the thread's floor down (voice session stop / disconnect). */
export function closeFloor(threadId: string): void {
  const floor = floors.get(threadId);
  if (!floor) return;
  clearHeartbeat(floor);
  floor.currentAbort?.abort();
  floor.playbackResolver?.();
  // Session teardown while runs are parked: resume all of them immediately so a
  // gone voice session never leaves a run wedged behind the floor.
  releaseAllGenWaiters(floor, 'teardown');
  floor.genHolder = null;
  floor.pendingDrainGrant = false;
  floors.delete(threadId);
}

function clearHeartbeat(floor: ThreadFloor): void {
  if (floor.heartbeatTimer) {
    clearTimeout(floor.heartbeatTimer);
    floor.heartbeatTimer = null;
  }
}

/** Enqueue an utterance for speaking; kicks the queue if the floor is free. */
export function enqueueUtterance(threadId: string, job: FloorJob): void {
  const floor = floors.get(threadId);
  if (!floor) return; // no active voice session on this thread — nothing to speak
  floor.queue.push(job);
  void advance(threadId);
}

/**
 * Client reported that playback of `utteranceId` finished — release the floor
 * and let the next speaker start. Ignored if it does not match the current
 * holder (a stale/duplicate done).
 */
export function notePlaybackDone(threadId: string, utteranceId: string): void {
  const floor = floors.get(threadId);
  if (!floor || floor.current?.utteranceId !== utteranceId) return;
  resolvePlayback(floor);
}

function resolvePlayback(floor: ThreadFloor): void {
  clearHeartbeat(floor);
  const resolve = floor.playbackResolver;
  floor.playbackResolver = null;
  resolve?.();
}

/**
 * User barge-in: stop the current speaker at once, drop any queued utterances
 * belonging to the interrupted agent's current run, and free the floor. Returns
 * the interrupted agent id (the floor holder at preemption), or null if silent.
 */
export function clearFloorForBargeIn(threadId: string): string | null {
  const floor = floors.get(threadId);
  if (!floor) return null;
  const interruptedAgentId = floor.current?.agentId ?? null;
  const interruptedRunId = floor.current?.runId ?? null;

  // Stop the in-flight synthesis/stream and unblock its playback wait.
  floor.currentAbort?.abort();
  resolvePlayback(floor);

  // Flush pending audio for the interrupted run so peers don't hear stale words.
  if (interruptedRunId) {
    floor.queue = floor.queue.filter((j) => j.runId !== interruptedRunId);
  }
  // A release-on-playback that was waiting for this (now flushed) audio to drain
  // must not linger — the audio floor won't `advance()` to fire the grant. Clear
  // the pending flag so a fresh acquire after the user's turn isn't stuck parking
  // behind a drain that will never arrive.
  floor.pendingDrainGrant = false;
  // Hand the free floor directly to any already-parked waiter. In the
  // abort-redispatch barge-in branch the interrupted speaker still holds
  // `genHolder` (so this guard is a no-op) and abortThread unwinds the lot.
  // But the mid-tool (inject) barge-in branch does no abort: there the speaker
  // already released the floor into tool work (`genHolder === null`), so a parked
  // peer would otherwise wait out the full backstop despite a free floor. Grant it
  // now. A waiter granted here that is then aborted (abort-redispatch) settles
  // cleanly: its run releases the floor through the normal turn-loop finally.
  if (floor.genHolder === null) grantNextGenerationWaiter(floor);
  return interruptedAgentId;
}

/** Start the queue head if the floor is free. Serialized via `advancing`. */
async function advance(threadId: string): Promise<void> {
  const floor = floors.get(threadId);
  if (!floor || floor.advancing || floor.current) return;
  const next = floor.queue.shift();
  if (!next) {
    floor.sink.emitFloor(null);
    // Audio floor fully drained → the last speaker's utterance finished playing.
    // If a generator released on playback and parked the next one behind this
    // drain, grant it now (freeing the floor on playback, not generation).
    if (floor.pendingDrainGrant) grantNextGenerationWaiter(floor);
    return;
  }

  floor.advancing = true;
  floor.current = next;
  const abort = new AbortController();
  floor.currentAbort = abort;
  floor.sink.emitFloor(next.agentId);
  floor.advancing = false;

  try {
    // 1) Stream the audio down (resolves when the last chunk is sent).
    await next.play(abort.signal);

    // 2) Wait for the client to finish playing it (floor frees on playback, not
    //    generation) — bounded by the heartbeat so a gone client can't wedge us.
    if (!abort.signal.aborted) {
      await waitForPlayback(threadId, floor, next.utteranceId);
    }
  } catch (err) {
    logger.warn(
      `[voice] floor job failed [thread=${threadId}] [utterance=${next.utteranceId}]: ${getErrorMessage(
        err
      )}`
    );
  } finally {
    // Only clear if this job is still the current one (barge-in may have moved on).
    const f = floors.get(threadId);
    if (f && f.current === next) {
      clearHeartbeat(f);
      f.current = null;
      f.currentAbort = null;
      f.playbackResolver = null;
    }
  }

  // Chain to the next queued utterance (or emit floor:null when drained).
  await advance(threadId);
}

function waitForPlayback(threadId: string, floor: ThreadFloor, utteranceId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    floor.playbackResolver = resolve;
    floor.heartbeatTimer = setTimeout(() => {
      logger.warn(
        `[voice] floor heartbeat timeout — auto-advancing [thread=${threadId}] [utterance=${utteranceId}]`
      );
      resolvePlayback(floor);
    }, FLOOR_HEARTBEAT_TIMEOUT_MS);
  });
}

// Floor-gated generation: awaitable acquire / release
//
// In a voice thread an agent must hold the floor before each model call so it
// never generates speech from a stale world. This is
// the same per-thread floor as the audio queue above (one floor concept): the
// generation holder speaks while holding it, its utterances flow into the audio
// queue, and the floor frees for the next generator on playback completion
// (release-on-playback) — except during tool execution, when it frees at once
// (silent work never blocks anyone).

/** Remove a still-parked waiter from the FIFO (abort / backstop). */
function removeGenWaiter(floor: ThreadFloor, waiter: GenWaiter): void {
  const idx = floor.genWaiters.indexOf(waiter);
  if (idx >= 0) floor.genWaiters.splice(idx, 1);
}

/** Grant the floor to the FIFO head, if the floor is free. */
function grantNextGenerationWaiter(floor: ThreadFloor): void {
  if (floor.genHolder !== null) return;
  floor.pendingDrainGrant = false;
  const next = floor.genWaiters.shift();
  if (!next) return;
  floor.genHolder = next.agentId;
  next.settle('acquired');
}

/** Settle + drop every parked waiter (session teardown / test reset). */
function releaseAllGenWaiters(floor: ThreadFloor, outcome: FloorAcquireOutcome): void {
  const waiters = floor.genWaiters.splice(0);
  for (const w of waiters) w.settle(outcome);
}

/**
 * Acquire the thread's generation floor for `agentId` before a model call.
 * Resolves 'acquired' immediately when the floor is free; otherwise parks in a
 * FIFO until the floor frees, the run's abort signal fires ('aborted'), the
 * backstop elapses ('backstop' → proceed without the floor), or the session is
 * torn down ('teardown'). Never rejects. On a thread with no voice session it
 * resolves 'no-session' at once so text threads are untouched.
 *
 * Parking responds to abort immediately: the signal listener settles the promise
 * and removes the waiter on the same tick the signal fires.
 */
export function acquireGenerationFloor(
  threadId: string,
  agentId: string,
  opts: { signal?: AbortSignal; backstopMs?: number } = {}
): Promise<FloorAcquireOutcome> {
  const floor = floors.get(threadId);
  if (!floor) return Promise.resolve('no-session');
  if (opts.signal?.aborted) return Promise.resolve('aborted');
  // Fast path: nobody generating, nobody ahead of us, no drain we must wait on.
  if (floor.genHolder === null && floor.genWaiters.length === 0 && !floor.pendingDrainGrant) {
    floor.genHolder = agentId;
    return Promise.resolve('acquired');
  }

  const backstopMs = opts.backstopMs ?? FLOOR_ACQUIRE_BACKSTOP_MS;
  return new Promise<FloorAcquireOutcome>((resolve) => {
    let settled = false;
    const waiter: GenWaiter = {
      agentId,
      settle(outcome) {
        if (settled) return;
        settled = true;
        waiter.cleanup();
        resolve(outcome);
      },
      cleanup() {
        /* replaced below once the timer + listener exist */
      },
    };
    const onAbort = (): void => {
      removeGenWaiter(floor, waiter);
      waiter.settle('aborted');
    };
    const timer = setTimeout(() => {
      removeGenWaiter(floor, waiter);
      logger.warn(
        `[voice] floor acquire backstop — proceeding without floor ` +
          `[thread=${threadId}] [agent=${agentId}]`
      );
      waiter.settle('backstop');
    }, backstopMs);
    waiter.cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    floor.genWaiters.push(waiter);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Release the generation floor held by `agentId` immediately and grant the next
 * parked generator. Used when the agent drops into silent tool execution — the
 * work makes no sound, so a peer may generate at once.
 */
export function releaseGenerationFloor(threadId: string, agentId: string): void {
  const floor = floors.get(threadId);
  if (!floor || floor.genHolder !== agentId) return;
  floor.genHolder = null;
  grantNextGenerationWaiter(floor);
}

/**
 * Release the generation floor at the end of a speaking turn, but hold the next
 * generator back until the current speaker's audio has finished playing (free
 * on playback completion, not generation completion). If no audio is
 * pending for this speaker, the next generator is granted at once.
 */
export function releaseGenerationFloorAfterPlayback(threadId: string, agentId: string): void {
  const floor = floors.get(threadId);
  if (!floor || floor.genHolder !== agentId) return;
  floor.genHolder = null;
  if (floor.current !== null || floor.queue.length > 0) {
    // Audio is still streaming/queued — defer the grant to the audio-floor drain
    // (advance() fires grantNextGenerationWaiter when the queue empties). The
    // heartbeat backstops a vanished client so this can never wedge forever.
    floor.pendingDrainGrant = true;
  } else {
    grantNextGenerationWaiter(floor);
  }
}

/**
 * The agent currently holding the speaking floor on `threadId`, or null when the
 * floor is free. Read by open-mic barge-in to decide whether a VAD onset should
 * pause an in-progress speaker.
 */
export function currentFloorHolder(threadId: string): string | null {
  return floors.get(threadId)?.current?.agentId ?? null;
}

/** The utteranceId of whatever currently holds the floor, or null (open-mic). */
export function currentFloorUtteranceId(threadId: string): string | null {
  return floors.get(threadId)?.current?.utteranceId ?? null;
}

/** Test-only inspection. */
export function __floorSnapshot(threadId: string): {
  holder: string | null;
  queued: number;
} | null {
  const floor = floors.get(threadId);
  if (!floor) return null;
  return { holder: floor.current?.agentId ?? null, queued: floor.queue.length };
}

/** Test-only inspection of the generation floor (holder + parked FIFO). */
export function __genFloorSnapshot(threadId: string): {
  holder: string | null;
  waiting: string[];
  pendingDrainGrant: boolean;
} | null {
  const floor = floors.get(threadId);
  if (!floor) return null;
  return {
    holder: floor.genHolder,
    waiting: floor.genWaiters.map((w) => w.agentId),
    pendingDrainGrant: floor.pendingDrainGrant,
  };
}

/** Test-only reset. */
export function __resetFloors(): void {
  for (const floor of floors.values()) {
    clearHeartbeat(floor);
    floor.currentAbort?.abort();
    floor.playbackResolver?.();
    releaseAllGenWaiters(floor, 'teardown');
  }
  floors.clear();
}
