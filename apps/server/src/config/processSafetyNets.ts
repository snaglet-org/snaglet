export interface SafetyNetReporterOptions {
  /** Reports allowed per window; later ones in the same window are dropped. */
  maxReportsPerWindow?: number;
  windowMs?: number;
  /** Called once per window, on the first dropped report. */
  onSuppressed?: (windowMs: number) => void;
  now?: () => number;
}

/**
 * Wraps a last-resort `uncaughtException` / `unhandledRejection` reporter so
 * it cannot feed itself. Reporting means logging, and a logging failure (a
 * closed stdout, a broken transport) can raise the very event being reported:
 * a report raised while one is in progress is dropped, a burst beyond
 * `maxReportsPerWindow` is counted out until the window rolls over, and a
 * reporter that throws is swallowed rather than becoming the next uncaught
 * exception.
 */
export function createSafetyNetReporter<A extends unknown[]>(
  report: (...args: A) => void,
  options: SafetyNetReporterOptions = {}
): (...args: A) => void {
  const maxReports = options.maxReportsPerWindow ?? 10;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now;
  let reporting = false;
  let windowStart = Number.NEGATIVE_INFINITY;
  let reportsInWindow = 0;
  let suppressionNoted = false;

  return (...args: A) => {
    if (reporting) return;
    reporting = true;
    try {
      const at = now();
      if (at - windowStart >= windowMs) {
        windowStart = at;
        reportsInWindow = 0;
        suppressionNoted = false;
      }
      if (reportsInWindow >= maxReports) {
        if (!suppressionNoted) {
          suppressionNoted = true;
          options.onSuppressed?.(windowMs);
        }
        return;
      }
      reportsInWindow += 1;
      report(...args);
    } catch {
      // Nothing is left to report a failed report to.
    } finally {
      reporting = false;
    }
  };
}
