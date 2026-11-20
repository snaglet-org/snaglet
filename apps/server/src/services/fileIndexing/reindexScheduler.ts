/**
 * The watchers catch live edits, so the full sweep only has to catch changes
 * made while nothing was watching.
 */
const PERIODIC_SCAN_INTERVAL_MS = 30 * 60_000;
/** A project with no working watcher has only the sweep, so it is swept this often. */
const WATCHER_GAP_SCAN_INTERVAL_MS = 5 * 60_000;

interface PeriodicSweeps {
  /** Sweep every project. */
  all: () => Promise<void>;
  /** Sweep only the projects with a watcher gap; returns at once when there are none. */
  gaps: () => Promise<void>;
  /** True while any sweep runs; a periodic sweep never starts on top of one. */
  busy: () => boolean;
}

/**
 * Run `all` every PERIODIC_SCAN_INTERVAL_MS and `gaps` on the ticks between.
 * A tick that finds a sweep running is skipped; a full sweep that comes due
 * then runs on the next free tick. Returns the function that stops it.
 */
export function startPeriodicSweep(sweeps: PeriodicSweeps): () => void {
  let sinceFullMs = 0;
  const timer = setInterval(() => {
    sinceFullMs += WATCHER_GAP_SCAN_INTERVAL_MS;
    if (sweeps.busy()) return;
    if (sinceFullMs >= PERIODIC_SCAN_INTERVAL_MS) {
      sinceFullMs = 0;
      void sweeps.all();
    } else {
      void sweeps.gaps();
    }
  }, WATCHER_GAP_SCAN_INTERVAL_MS);
  return () => clearInterval(timer);
}

interface ReindexRequest {
  label: string;
  projectId?: string;
}

type ReindexRunner = (request: ReindexRequest) => Promise<void>;

/**
 * Collapse a burst of indexing-config edits into one serialized reconciliation.
 * If more than one project changes during the burst, omit projectId so the
 * ownership pass safely considers every tree.
 */
export function createReindexScheduler(
  run: ReindexRunner,
  delayMs: number
): {
  schedule: (label: string, projectId?: string) => void;
  cancel: () => void;
} {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const labels = new Set<string>();
  const projectIds = new Set<string>();
  let includesGlobalRequest = false;

  const arm = () => {
    if (running || timer || labels.size === 0) return;
    timer = setTimeout(() => void flush(), delayMs);
  };

  const flush = async () => {
    timer = null;
    if (running || labels.size === 0) return;

    const label = [...labels].join(' + ');
    const projectId =
      !includesGlobalRequest && projectIds.size === 1 ? [...projectIds][0] : undefined;
    labels.clear();
    projectIds.clear();
    includesGlobalRequest = false;
    running = true;
    try {
      await run({ label, projectId });
    } finally {
      running = false;
      arm();
    }
  };

  return {
    schedule(label, projectId) {
      labels.add(label);
      if (projectId === undefined) includesGlobalRequest = true;
      else projectIds.add(projectId);

      // Debounce edits that arrive before work begins. Calls received while a
      // pass is running are retained and run once afterward.
      if (!running && timer) {
        clearTimeout(timer);
        timer = null;
      }
      arm();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      labels.clear();
      projectIds.clear();
      includesGlobalRequest = false;
    },
  };
}
