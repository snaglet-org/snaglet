/**
 * `workers` category settings — user-facing throttle for this server's
 * background jobs.
 *
 * Registered into the settings registry on module load (side-effect import in
 * apps/server/src/services/settings/index.ts). Values live in the generic
 * settings table.
 *
 * `RUN_BACKGROUND_WORKERS=false` is a hard override. These
 * settings only shape behavior on a server whose environment already allows
 * workers — see apps/server/src/services/workers/workerPolicy.ts.
 */

import { z } from 'zod';
import { WORKER_MODES, type WorkerMode } from '@snaglet/shared/types';
import { defineCategory } from '../defineSetting';

/** Bounds mirrored by the UI inputs and by the settings PUT validation. */
export const WORKER_BATCH_SIZE_MIN = 1;
export const WORKER_BATCH_SIZE_MAX = 200;
export const WORKER_SWEEP_INTERVAL_SECONDS_MIN = 5;
export const WORKER_SWEEP_INTERVAL_SECONDS_MAX = 3600;
/** Hook burst limit (customHooks/hookChainGuard.ts). */
const HOOKS_MAX_RUNS_PER_MINUTE_MIN = 1;
const HOOKS_MAX_RUNS_PER_MINUTE_MAX = 10_000;

const WorkerModeSchema = z.enum(
  // z.enum needs a non-empty tuple; WORKER_MODES is the shared source of truth.
  WORKER_MODES as unknown as [WorkerMode, ...WorkerMode[]]
);

export const workerSettings = defineCategory('workers', {
  /**
   * Master runtime throttle. Consulted on every worker tick (not just at
   * boot), so pausing takes effect within one tick and resuming needs no
   * restart.
   */
  mode: {
    key: 'mode',
    schema: WorkerModeSchema,
    default: 'balanced' as WorkerMode,
    description:
      'How hard background workers run: "balanced" (default cadence), "immediate" (faster ' +
      'sweeps and bigger batches to drain a backlog), "paused" (timer alive, no work), or ' +
      '"off" (loop stopped). RUN_BACKGROUND_WORKERS=false overrides all of these.',
  },
  hooksEnabled: {
    key: 'hooks_enabled',
    schema: z.boolean(),
    default: true,
    description: 'Allow user-authored lifecycle hooks to run in the background.',
  },
  /**
   * Runs one hook may start in any rolling minute, counting every automatic
   * run (events, hook-started runs). Schedules and a person's own test runs
   * don't count. 600 lets a 500-row bulk edit through and caps a runaway at
   * about 10 runs a second.
   */
  hooksMaxRunsPerMinute: {
    key: 'hooks_max_runs_per_minute',
    schema: z.number().int().min(HOOKS_MAX_RUNS_PER_MINUTE_MIN).max(HOOKS_MAX_RUNS_PER_MINUTE_MAX),
    default: 600,
    description:
      'How many times one hook may run automatically in any minute. Runs over the ' +
      'limit are refused. Schedules and test runs you start yourself do not count.',
  },
  embeddingsEnabled: {
    key: 'embeddings_enabled',
    schema: z.boolean(),
    default: true,
    description: 'Allow the automatic embedding backfill sweep to run.',
  },
  /**
   * Rows per node kind per sweep, before the mode multiplier.
   */
  batchSize: {
    key: 'batch_size',
    schema: z.number().int().min(WORKER_BATCH_SIZE_MIN).max(WORKER_BATCH_SIZE_MAX),
    default: 20,
    description:
      'Items the embedding sweep processes per node kind per pass, before the mode ' +
      'multiplier. Higher drains a backlog faster and uses more CPU.',
  },
  /**
   * Seconds between sweeps of the same node kind, before the mode multiplier.
   */
  sweepIntervalSeconds: {
    key: 'sweep_interval_seconds',
    schema: z
      .number()
      .int()
      .min(WORKER_SWEEP_INTERVAL_SECONDS_MIN)
      .max(WORKER_SWEEP_INTERVAL_SECONDS_MAX),
    default: 60,
    description:
      'Seconds between sweeps of the same node kind, before the mode multiplier. ' +
      'Lower means fresher embeddings and more background work.',
  },
});
