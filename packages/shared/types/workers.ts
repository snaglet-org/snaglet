/**
 * Background-worker control + status wire types.
 *
 * Shared by the server (`/api/workers`) and the desktop UI's Background work
 * settings surface. The persisted knobs live in the generic settings table
 * under the `workers` category (see
 * apps/server/src/services/settings/categories/workers.ts) — these types only
 * describe the HTTP shapes.
 */

/**
 * How hard background workers run.
 *
 *   - `balanced`  — the historical default cadence and batch size.
 *   - `immediate` — shorter sweep interval and a larger batch, for draining a
 *                   backlog quickly at the cost of CPU.
 *   - `paused`    — the timer stays alive but every pass is a no-op. Flipping
 *                   back to `balanced` resumes without a restart.
 *   - `off`       — the loop is stopped entirely (no timer). A mode change
 *                   restarts it; no server restart needed.
 */
export type WorkerMode = 'balanced' | 'immediate' | 'paused' | 'off';

export const WORKER_MODES: readonly WorkerMode[] = [
  'balanced',
  'immediate',
  'paused',
  'off',
] as const;

export function isWorkerMode(value: unknown): value is WorkerMode {
  return typeof value === 'string' && (WORKER_MODES as readonly string[]).includes(value);
}

/** The user-settable half of the policy (what is persisted in settings). */
export interface WorkerPolicyInput {
  mode: WorkerMode;
  /** Whether user-authored lifecycle hooks may be dispatched. */
  hooksEnabled: boolean;
  /** Whether the automatic embedding sweep may process backlog. */
  embeddingsEnabled: boolean;
  /** Rows per node kind per sweep, before the mode multiplier. */
  batchSize: number;
  /** Seconds between sweeps of the same node kind, before the mode multiplier. */
  sweepIntervalSeconds: number;
}

/** The policy as the workers actually see it, after env + mode resolution. */
export interface ResolvedWorkerPolicy extends WorkerPolicyInput {
  /**
   * False when `RUN_BACKGROUND_WORKERS=false`. The env var is a hard
   * override: workers stay off no matter what the setting says.
   */
  envEnabled: boolean;
  /** `off` whenever `envEnabled` is false, otherwise the configured mode. */
  effectiveMode: WorkerMode;
  /** Wake cadence of the worker timer, in ms. */
  tickIntervalMs: number;
  /** Effective per-kind sweep cadence, in ms (mode multiplier applied). */
  effectiveSweepIntervalMs: number;
  /** Effective per-kind batch size (mode multiplier applied). */
  effectiveBatchSize: number;
  /** True when a tick should do work this pass. */
  active: boolean;
  /** True when the loop should not be armed at all. */
  stopped: boolean;
}

export type WorkerSweepOutcome = 'ok' | 'error' | 'skipped';

/** Per-worker runtime telemetry, reset when the process restarts. */
export interface WorkerRuntimeStatus {
  /** Stable worker id, e.g. `embedding`. */
  worker: string;
  /** True while a sweep is in flight right now. */
  sweeping: boolean;
  /** ISO timestamp the in-flight sweep started, else null. */
  sweepStartedAt: string | null;
  /** ISO timestamp the last sweep finished, else null. */
  lastSweepAt: string | null;
  /** Wall-clock duration of the last completed sweep. */
  lastSweepDurationMs: number | null;
  lastOutcome: WorkerSweepOutcome | null;
  /** Error message from the last failed sweep (null once one succeeds). */
  lastError: string | null;
  /** Items processed by the last sweep. */
  lastProcessed: number;
  /** Sweeps that did work since process start (skips excluded). */
  totalSweeps: number;
  /** Items processed since process start. */
  totalProcessed: number;
}

/** Pending (missing or stale) embedding work, counted per node kind. */
export interface WorkerQueueDepth {
  /** Sum of `byKind`. */
  total: number;
  /** True when any kind hit the per-kind counting cap (so `total` is a floor). */
  capped: boolean;
  /** Per-kind counting cap used for this reading. */
  cap: number;
  byKind: Record<string, number>;
  /** False when no embedding model is resolvable — counts are all zero. */
  ready: boolean;
}

/** GET /api/workers/status */
export interface WorkerStatusResponse {
  /** Environment gate for automatic model work; absent on older servers. Manual inference remains available. */
  automaticLocalIntelligenceEnabled?: boolean;
  policy: ResolvedWorkerPolicy;
  workers: WorkerRuntimeStatus[];
  queue: WorkerQueueDepth;
}
