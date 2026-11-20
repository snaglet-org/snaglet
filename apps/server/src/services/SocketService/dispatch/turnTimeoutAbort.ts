/**
 * Per-agent turn-timeout abort reason + bounded settle / abort-wait helpers.
 *
 * When the per-agent timeout fires, the dispatch aborts that agent's turn
 * controller with an `AgentTurnTimeoutAbort`. Its `name` is 'AbortError' so
 * every existing abort classifier (turnLoop's unified abort path, tool
 * executors, provider retry waits) unwinds the turn exactly like a Stop; its
 * `kind` lets callers tell a timeout apart from a user/targeted abort (e.g. to
 * label the failed run "Aborted by timeout" rather than "by user").
 *
 * Deliberately a standalone module (not abortStore) so modules that are unit
 * tested with a mocked abortStore can still import it.
 */

export class AgentTurnTimeoutAbort extends Error {
  readonly kind = 'agent_turn_timeout' as const;

  constructor(
    readonly agentId: string,
    readonly timeoutMs: number
  ) {
    // No "timed out" phrase: handleAgentDispatchError classifies timeouts by
    // that substring and must only ever see the pausable wrapper's rejection.
    super(`agent turn aborted after exceeding its ${timeoutMs / 1000}s limit`);
    this.name = 'AbortError';
  }
}

/** True when `signal` was aborted by the per-agent turn timeout. */
export function isAgentTurnTimeoutAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason instanceof AgentTurnTimeoutAbort;
}

/**
 * Wait for every promise to settle, but no longer than `boundMs`. Resolves
 * true when all settled in time, false when the bound elapsed first. Never
 * rejects. The timer is unref'd so a wedged turn can't hold the process open.
 */
export async function settleWithin(
  promises: Iterable<Promise<unknown>>,
  boundMs: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), boundMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([Promise.allSettled([...promises]).then(() => true as const), bound]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * A promise that resolves once `signal` aborts (immediately if it already
 * has), for racing against work that may ignore the abort. `dispose` removes
 * the listener when the race is decided the other way, so long-lived signals
 * don't accumulate listeners.
 */
export function waitForAbort(signal: AbortSignal): {
  promise: Promise<'aborted'>;
  dispose: () => void;
} {
  if (signal.aborted) return { promise: Promise.resolve('aborted'), dispose: () => {} };
  let onAbort: (() => void) | null = null;
  const promise = new Promise<'aborted'>((resolve) => {
    onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}
