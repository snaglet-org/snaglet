/**
 * utilityConcurrency — two small primitives for utility text generation:
 *
 * - a GLOBAL slot (concurrency 1) for LOCAL providers, so background
 *   summarization never hammers ollama / LM Studio / the Apple shim while
 *   the user is actively chatting with it — every utility call on a local
 *   model queues behind the previous one, process-wide;
 * - per-key single-flight, so one thread+agent never has two summary
 *   generations racing (the second attempt reports itself as skipped
 *   rather than queueing — the next turn will re-trigger anyway).
 */

let localTail: Promise<void> = Promise.resolve();

/** Serialize `run` behind every other in-flight local-provider call. */
export function withLocalProviderSlot<T>(run: () => Promise<T>): Promise<T> {
  const result = localTail.then(run, run);
  localTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

const inFlight = new Set<string>();

/**
 * Run `run` unless another call with the same key is already in flight, in
 * which case resolve to `null` immediately (callers surface this as a
 * visible "in-flight" skip, not an error).
 */
export async function withSingleFlight<T>(key: string, run: () => Promise<T>): Promise<T | null> {
  if (inFlight.has(key)) return null;
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

/** Test-only: clear all in-flight bookkeeping. */
export function resetUtilityConcurrencyForTests(): void {
  inFlight.clear();
  localTail = Promise.resolve();
}
