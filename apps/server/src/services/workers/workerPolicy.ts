/**
 * workerPolicy — the single place that answers "should background work run
 * right now, how often, and how much?".
 *
 * Two inputs, in strict precedence order:
 *
 *   1. `RUN_BACKGROUND_WORKERS` (env) — a HARD override. When it is `false`,
 *      workers stay off no matter what the user picked. This preserves the
 *      pre-existing contract used by worker-less client servers, e2e harnesses,
 *      and the packaged-preview verifiers.
 *   2. The `workers` settings category (mode / batch size / sweep interval) —
 *      the runtime, user-settable half. Only consulted when the env allows
 *      workers at all.
 *
 * Workers call `resolveWorkerPolicy()` on every tick rather than reading once
 * at boot, so a user pausing from the UI takes effect within one tick. Reads go
 * through `settingsService`, which already has its own short cache, and a
 * last-known snapshot is kept so a transient DB failure degrades to the last
 * good policy instead of throwing inside a tick.
 */

import type { ResolvedWorkerPolicy, WorkerMode, WorkerPolicyInput } from '@snaglet/shared/types';
import { getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { settingsService } from '@server/services/settings/settingsService';
import { workerSettings } from '@server/services/settings/categories/workers';

/** Base wake cadence — how often a worker timer fires in `balanced` mode. */
const BALANCED_TICK_MS = 30_000;
/** Wake cadence in `immediate` mode. */
const IMMEDIATE_TICK_MS = 10_000;
/** Floor on the effective per-kind sweep cadence, whatever the mode math says. */
const MIN_SWEEP_INTERVAL_MS = 5_000;
/** How much `immediate` multiplies the configured batch size. */
const IMMEDIATE_BATCH_MULTIPLIER = 3;
/** Absolute ceiling on a scaled batch, so `immediate` cannot melt a laptop. */
const MAX_EFFECTIVE_BATCH = 200;

const DEFAULTS: WorkerPolicyInput = {
  mode: workerSettings.mode.default,
  hooksEnabled: workerSettings.hooksEnabled.default,
  embeddingsEnabled: workerSettings.embeddingsEnabled.default,
  batchSize: workerSettings.batchSize.default,
  sweepIntervalSeconds: workerSettings.sweepIntervalSeconds.default,
};

let lastGood: WorkerPolicyInput = { ...DEFAULTS };
/** Latch so a persistently failing settings read logs once, not every tick. */
let readFailureLogged = false;

/**
 * True unless `RUN_BACKGROUND_WORKERS=false`. Read at call time (not module
 * load) so tests and the Tauri shell can flip it before starting a worker.
 */
export function isWorkerEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RUN_BACKGROUND_WORKERS !== 'false';
}

function clampBatch(value: number): number {
  return Math.max(1, Math.min(MAX_EFFECTIVE_BATCH, Math.round(value)));
}

/**
 * Turn the persisted knobs + env into the shape workers consume. Pure — the
 * async wrapper below owns the settings reads, which keeps this unit-testable
 * without a database.
 */
export function computeWorkerPolicy(
  input: WorkerPolicyInput,
  envEnabled: boolean
): ResolvedWorkerPolicy {
  const effectiveMode: WorkerMode = envEnabled ? input.mode : 'off';
  const baseSweepMs = input.sweepIntervalSeconds * 1000;

  let tickIntervalMs = BALANCED_TICK_MS;
  let effectiveSweepIntervalMs = baseSweepMs;
  let effectiveBatchSize = clampBatch(input.batchSize);

  if (effectiveMode === 'immediate') {
    tickIntervalMs = IMMEDIATE_TICK_MS;
    effectiveSweepIntervalMs = Math.max(MIN_SWEEP_INTERVAL_MS, Math.round(baseSweepMs / 4));
    effectiveBatchSize = clampBatch(input.batchSize * IMMEDIATE_BATCH_MULTIPLIER);
  }

  // A sweep cadence faster than the wake cadence is pointless (the timer gates
  // it), so pull the wake cadence down to match rather than sleeping through
  // work the user asked to happen sooner.
  if (effectiveSweepIntervalMs < tickIntervalMs) {
    tickIntervalMs = Math.max(MIN_SWEEP_INTERVAL_MS, effectiveSweepIntervalMs);
  }

  const stopped = effectiveMode === 'off';
  const active = effectiveMode === 'balanced' || effectiveMode === 'immediate';

  return {
    ...input,
    envEnabled,
    effectiveMode,
    tickIntervalMs,
    effectiveSweepIntervalMs: Math.max(MIN_SWEEP_INTERVAL_MS, effectiveSweepIntervalMs),
    effectiveBatchSize,
    active,
    stopped,
  };
}

/** Read the persisted knobs. Falls back to the last good values on failure. */
async function readPolicyInput(): Promise<WorkerPolicyInput> {
  try {
    const [mode, hooksEnabled, embeddingsEnabled, batchSize, sweepIntervalSeconds] =
      await Promise.all([
        settingsService.read(workerSettings.mode),
        settingsService.read(workerSettings.hooksEnabled),
        settingsService.read(workerSettings.embeddingsEnabled),
        settingsService.read(workerSettings.batchSize),
        settingsService.read(workerSettings.sweepIntervalSeconds),
      ]);
    lastGood = {
      mode,
      hooksEnabled,
      embeddingsEnabled,
      batchSize,
      sweepIntervalSeconds,
    };
    readFailureLogged = false;
    return lastGood;
  } catch (err) {
    if (!readFailureLogged) {
      readFailureLogged = true;
      logger.warn(
        `[workerPolicy] settings read failed, using last known policy (${lastGood.mode}): ${getErrorMessage(err)}`
      );
    }
    return lastGood;
  }
}

/** The current policy. Safe to call every tick — settings reads are cached. */
export async function resolveWorkerPolicy(): Promise<ResolvedWorkerPolicy> {
  return computeWorkerPolicy(await readPolicyInput(), isWorkerEnvEnabled());
}

/**
 * The last resolved policy without touching the database. For status surfaces
 * that must answer even while the DB is unreachable.
 */
export function peekWorkerPolicy(): ResolvedWorkerPolicy {
  return computeWorkerPolicy(lastGood, isWorkerEnvEnabled());
}

/**
 * Subscribe to `workers.*` setting changes. Workers use this to re-arm (or
 * tear down) their timer the moment a user changes the mode, instead of
 * waiting out the current interval.
 */
export function onWorkerPolicyChange(handler: () => void): () => void {
  return settingsService.onChange((event) => {
    if (event.category !== workerSettings.mode.category) return;
    handler();
  });
}
