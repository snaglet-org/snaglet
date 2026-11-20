const RETRY_MIN_MS = 2_000;
const RETRY_JITTER_MS = 1_000;

export function transientProviderRetryDelayMs(random: () => number = Math.random): number {
  return RETRY_MIN_MS + Math.floor(random() * RETRY_JITTER_MS);
}

/** Wait for the retry backoff without making Stop wait for the timer. */
export async function waitForTransientProviderRetry(
  signal: AbortSignal,
  delayMs: number
): Promise<void> {
  if (signal.aborted) throw new DOMException('run aborted during provider retry', 'AbortError');

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('run aborted during provider retry', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
