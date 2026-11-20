/**
 * workerStatus — in-process telemetry for the background workers.
 *
 * Deliberately memory-only: this answers "what is THIS server process doing
 * right now", which is exactly what a user watching the Background work
 * settings pane wants. Nothing here is durable, and nothing here is on a hot
 * path — the workers call `beginSweep` / `endSweep` once per tick.
 */

import type { WorkerRuntimeStatus, WorkerSweepOutcome } from '@snaglet/shared/types';

interface MutableStatus extends WorkerRuntimeStatus {
  /** Monotonic start marker for the in-flight sweep (Date.now()). */
  startedAtMs: number | null;
}

const states = new Map<string, MutableStatus>();

function ensure(worker: string): MutableStatus {
  const existing = states.get(worker);
  if (existing) return existing;
  const fresh: MutableStatus = {
    worker,
    sweeping: false,
    sweepStartedAt: null,
    lastSweepAt: null,
    lastSweepDurationMs: null,
    lastOutcome: null,
    lastError: null,
    lastProcessed: 0,
    totalSweeps: 0,
    totalProcessed: 0,
    startedAtMs: null,
  };
  states.set(worker, fresh);
  return fresh;
}

/** Register a worker so it shows up in status before its first sweep. */
export function registerWorker(worker: string): void {
  ensure(worker);
}

/** Mark a sweep as in flight. */
export function beginSweep(worker: string): void {
  const state = ensure(worker);
  state.sweeping = true;
  state.startedAtMs = Date.now();
  state.sweepStartedAt = new Date(state.startedAtMs).toISOString();
}

export interface SweepResult {
  outcome: WorkerSweepOutcome;
  /** Items processed. Ignored for `skipped`. */
  processed?: number;
  /** Message for a failed sweep; cleared on the next successful one. */
  error?: string;
}

/**
 * Close out a sweep. `skipped` (paused / off / nothing to do because policy
 * said so) does not count toward the sweep or processed totals — it would
 * otherwise make a paused worker look busy.
 */
export function endSweep(worker: string, result: SweepResult): void {
  const state = ensure(worker);
  const now = Date.now();
  state.lastSweepDurationMs = state.startedAtMs === null ? null : now - state.startedAtMs;
  state.sweeping = false;
  state.startedAtMs = null;
  state.sweepStartedAt = null;
  state.lastSweepAt = new Date(now).toISOString();
  state.lastOutcome = result.outcome;

  if (result.outcome === 'error') {
    state.lastError = result.error ?? 'Unknown error';
    return;
  }

  state.lastError = null;
  if (result.outcome === 'skipped') return;

  const processed = result.processed ?? 0;
  state.lastProcessed = processed;
  state.totalSweeps += 1;
  state.totalProcessed += processed;
}

/** Snapshot of every known worker, stable-sorted by worker id. */
export function listWorkerStatus(): WorkerRuntimeStatus[] {
  return [...states.values()]
    .map(({ startedAtMs: _startedAtMs, ...rest }) => ({ ...rest }))
    .sort((a, b) => a.worker.localeCompare(b.worker));
}
