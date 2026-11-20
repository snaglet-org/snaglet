import { useEffect } from 'react';

/**
 * Single-flight polling interval: skips a tick while the previous one is
 * still in flight, swallows tick errors (transient — retry next tick), and
 * exposes a cancellation signal so callers can guard their setState after
 * awaits. Cleans up on unmount / when `enabled` flips false.
 */
export function useGuardedInterval(
  tick: (signal: { canceled: boolean }) => Promise<void>,
  opts: { intervalMs: number; enabled: boolean; immediate?: boolean }
): void {
  const { intervalMs, enabled, immediate } = opts;
  useEffect(() => {
    if (!enabled) return;
    const signal = { canceled: false };
    let inflight = false;
    const run = async () => {
      if (inflight) return;
      inflight = true;
      try {
        await tick(signal);
      } catch {
        // transient — retry next tick
      } finally {
        inflight = false;
      }
    };
    if (immediate) void run();
    const id = window.setInterval(() => void run(), intervalMs);
    return () => {
      signal.canceled = true;
      window.clearInterval(id);
    };
  }, [enabled, intervalMs]);
}
