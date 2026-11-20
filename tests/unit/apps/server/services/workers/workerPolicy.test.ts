/**
 * workerPolicy — the env-vs-setting precedence and the per-mode cadence/batch
 * math. `computeWorkerPolicy` is pure, so this needs no database: the settings
 * read is exercised separately by the route/integration surface.
 */

import { describe, expect, it } from '@jest/globals';
import type { WorkerPolicyInput } from '@snaglet/shared/types';
import { computeWorkerPolicy, isWorkerEnvEnabled } from '@server/services/workers/workerPolicy';

const BASE: WorkerPolicyInput = {
  mode: 'balanced',
  hooksEnabled: true,
  embeddingsEnabled: true,
  batchSize: 20,
  sweepIntervalSeconds: 60,
};

describe('isWorkerEnvEnabled', () => {
  it('is true unless RUN_BACKGROUND_WORKERS is exactly "false"', () => {
    expect(isWorkerEnvEnabled({})).toBe(true);
    expect(isWorkerEnvEnabled({ RUN_BACKGROUND_WORKERS: 'true' })).toBe(true);
    expect(isWorkerEnvEnabled({ RUN_BACKGROUND_WORKERS: 'false' })).toBe(false);
  });
});

describe('computeWorkerPolicy', () => {
  it('balanced keeps the configured cadence and batch', () => {
    const policy = computeWorkerPolicy(BASE, true);
    expect(policy.effectiveMode).toBe('balanced');
    expect(policy.active).toBe(true);
    expect(policy.stopped).toBe(false);
    expect(policy.effectiveSweepIntervalMs).toBe(60_000);
    expect(policy.effectiveBatchSize).toBe(20);
    expect(policy.tickIntervalMs).toBe(30_000);
  });

  it('immediate shortens the cadence and grows the batch', () => {
    const policy = computeWorkerPolicy({ ...BASE, mode: 'immediate' }, true);
    expect(policy.active).toBe(true);
    expect(policy.effectiveSweepIntervalMs).toBe(15_000);
    expect(policy.effectiveBatchSize).toBe(60);
    expect(policy.tickIntervalMs).toBe(10_000);
  });

  it('paused keeps the timer alive but does no work', () => {
    const policy = computeWorkerPolicy({ ...BASE, mode: 'paused' }, true);
    expect(policy.active).toBe(false);
    expect(policy.stopped).toBe(false);
  });

  it('off stops the loop', () => {
    const policy = computeWorkerPolicy({ ...BASE, mode: 'off' }, true);
    expect(policy.active).toBe(false);
    expect(policy.stopped).toBe(true);
  });

  it('RUN_BACKGROUND_WORKERS=false hard-overrides any mode', () => {
    for (const mode of ['balanced', 'immediate', 'paused', 'off'] as const) {
      const policy = computeWorkerPolicy({ ...BASE, mode }, false);
      expect(policy.envEnabled).toBe(false);
      expect(policy.effectiveMode).toBe('off');
      expect(policy.active).toBe(false);
      expect(policy.stopped).toBe(true);
      // The user's own choice is still reported so the UI can explain itself.
      expect(policy.mode).toBe(mode);
    }
  });

  it('never wakes slower than the requested sweep cadence', () => {
    const policy = computeWorkerPolicy({ ...BASE, sweepIntervalSeconds: 10 }, true);
    expect(policy.effectiveSweepIntervalMs).toBe(10_000);
    expect(policy.tickIntervalMs).toBeLessThanOrEqual(10_000);
  });

  it('clamps the effective batch to a sane ceiling', () => {
    const policy = computeWorkerPolicy({ ...BASE, mode: 'immediate', batchSize: 200 }, true);
    expect(policy.effectiveBatchSize).toBe(200);
  });
});
