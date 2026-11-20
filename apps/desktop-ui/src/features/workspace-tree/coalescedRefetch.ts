export interface CoalescedRefetch {
  /** Ask for a fresh run. Cheap to call once per event. */
  request: () => void;
  /** Cancel a pending start; a run already in flight never gets a follow-up. */
  dispose: () => void;
}

/**
 * Turns a stream of "refetch now" requests into a few runs of `run`:
 *
 * - at most one run is in flight; a request that arrives during it is
 *   remembered, and exactly one more run follows when it settles;
 * - starts are at least `minGapMs` apart: a request after a quiet spell
 *   starts at once (leading edge: on a microtask, so every request made in
 *   the same task, such as each reader of one event or each subscriber
 *   mounted in one commit, joins it), a request soon after the last start
 *   waits out the rest of the gap (trailing edge), and every request in
 *   that wait shares the one run.
 *
 * So every request is followed by a run that starts after it, and no run's
 * result is made stale by a later one in flight beside it. `run` reports its
 * own errors; a rejection only settles the flight.
 */
export function createCoalescedRefetch(
  run: () => Promise<void>,
  minGapMs: number
): CoalescedRefetch {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let startPending = false;
  let inFlight = false;
  let requestedInFlight = false;
  let lastStartAt = Number.NEGATIVE_INFINITY;
  let disposed = false;

  const settle = () => {
    inFlight = false;
    if (!requestedInFlight) return;
    requestedInFlight = false;
    schedule();
  };

  const start = () => {
    startPending = false;
    timer = null;
    if (disposed) return;
    inFlight = true;
    lastStartAt = Date.now();
    run().then(settle, settle);
  };

  function schedule() {
    if (disposed || startPending) return;
    startPending = true;
    const wait = lastStartAt + minGapMs - Date.now();
    if (wait <= 0) void Promise.resolve().then(start);
    else timer = setTimeout(start, wait);
  }

  return {
    request() {
      if (disposed) return;
      if (inFlight) requestedInFlight = true;
      else schedule();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
