/**
 * Stream-idle watchdog for ONE model call.
 *
 * Agent turns have no wall-clock limit by default (`agent.timeout_seconds` =
 * 0). What we DO want to catch is a provider call that hangs: the HTTP stream
 * is open but nothing arrives. This watchdog aborts a single model call when
 * its stream has been silent for `idleMs`.
 *
 * "Activity" is anything the stream delivers: the providers' raw-read hook
 * (`ProviderChatOptions.onStreamActivity`, fired on every network chunk —
 * including tool-call argument deltas, which fire no other callback) plus the
 * chunk / thinking / usage callbacks as a fallback for providers that don't
 * use the shared readers. Call `touch()` for each.
 *
 * The watchdog owns a child AbortController linked to the turn's signal: a
 * Stop / targeted abort of the turn still cancels the call, and a stall
 * aborts only the call (the turn's controller is untouched, so the turn loop
 * can retry). Use `signal` for the provider request, and pass any error from
 * the call through `translate()` so a stall-induced abort surfaces as a
 * `ProviderStreamStallError` instead of an AbortError.
 *
 * `idleMs <= 0` disables the watchdog (signal is still linked to the turn).
 */

export class ProviderStreamStallError extends Error {
  readonly idleMs: number;
  readonly providerStreamStall = true;

  constructor(idleMs: number, providerLabel?: string) {
    super(
      `Model stream stalled: no output${providerLabel ? ` from ${providerLabel}` : ''} for ` +
        `${formatIdle(idleMs)}; the call was aborted.`
    );
    this.name = 'ProviderStreamStallError';
    this.idleMs = idleMs;
  }
}

export function isProviderStreamStallError(err: unknown): err is ProviderStreamStallError {
  return (
    err instanceof ProviderStreamStallError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { providerStreamStall?: unknown }).providerStreamStall === true)
  );
}

function formatIdle(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s >= 60 && s % 60 === 0) return `${s / 60}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export interface StreamIdleWatchdog {
  /** Signal to hand the provider call. Aborts on stall OR turn abort. */
  readonly signal: AbortSignal;
  /** Record stream activity; restarts the idle timer. */
  touch: () => void;
  /** True once the watchdog fired. */
  readonly stalled: () => boolean;
  /** Map an error thrown by the call: stall-induced aborts → ProviderStreamStallError. */
  translate: (err: unknown) => unknown;
  /** Clear the timer and unlink from the turn signal. Always call (finally). */
  dispose: () => void;
}

export function createStreamIdleWatchdog(
  turnSignal: AbortSignal,
  idleMs: number,
  providerLabel?: string
): StreamIdleWatchdog {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  let disposed = false;

  const onTurnAbort = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    controller.abort(turnSignal.reason);
  };
  if (turnSignal.aborted) onTurnAbort();
  else turnSignal.addEventListener('abort', onTurnAbort, { once: true });

  const enabled = idleMs > 0;
  const arm = (): void => {
    if (!enabled || disposed || fired || controller.signal.aborted) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (disposed || controller.signal.aborted) return;
      fired = true;
      controller.abort(new ProviderStreamStallError(idleMs, providerLabel));
    }, idleMs);
  };
  arm();

  return {
    signal: controller.signal,
    touch: arm,
    stalled: () => fired,
    translate: (err) =>
      fired && !turnSignal.aborted && !isProviderStreamStallError(err)
        ? new ProviderStreamStallError(idleMs, providerLabel)
        : err,
    dispose: () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      turnSignal.removeEventListener('abort', onTurnAbort);
    },
  };
}
