/**
 * createPausableAgentTimeout
 *
 * Per-agent turn timeout that can be paused while the run is parked on the voice
 * speaking floor, so parked time is not charged against it (floor-gated
 * generation). Behaves exactly like the plain
 * `withTimeout` when never paused — same rejection message ("… timed out …") so
 * `handleAgentDispatchError`'s timeout classification applies.
 *
 * `pause()` freezes the countdown (banking elapsed time); `resume()` re-arms it
 * with the time that remained. Both are idempotent and no-op once settled — so a
 * text-thread turn (which never pauses) behaves exactly like `withTimeout`.
 *
 * `onTimeout` (optional) runs synchronously at expiry, before the wrapper
 * rejects. Rejecting the wrapper alone does not stop the underlying turn, so
 * the dispatch passes a callback that aborts the turn's controller — otherwise
 * a timed-out turn keeps running (and may post) after its timeout error.
 *
 * `timeoutMs <= 0` means unlimited (the `agent.timeout_seconds` default): no
 * timer is ever armed, the wrapper simply mirrors `promise`, and pause/resume
 * are no-ops. Stop / targeted abort still work — they go through the turn's
 * abort controller, not this wrapper.
 */
export function createPausableAgentTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void
): { promise: Promise<T>; pause: () => void; resume: () => void } {
  if (!(timeoutMs > 0)) {
    return { promise, pause: () => {}, resume: () => {} };
  }
  let remaining = timeoutMs;
  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let onExpire: (() => void) | null = null;

  const arm = (): void => {
    if (settled || timer !== null) return;
    armedAt = Date.now();
    timer = setTimeout(() => onExpire?.(), remaining);
  };
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const wrapped = new Promise<T>((resolve, reject) => {
    onExpire = (): void => {
      if (settled) return;
      settled = true;
      disarm();
      try {
        onTimeout?.();
      } catch {
        // The timeout rejection below must land even if the abort hook throws.
      }
      reject(new Error(`Agent response timed out after ${timeoutMs / 1000}s [${label}]`));
    };
    arm();
    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        disarm();
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        disarm();
        reject(err);
      }
    );
  });

  return {
    promise: wrapped,
    pause: (): void => {
      if (settled || timer === null) return;
      remaining -= Date.now() - armedAt;
      if (remaining < 0) remaining = 0;
      disarm();
    },
    resume: (): void => arm(),
  };
}
