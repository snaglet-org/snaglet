/**
 * /api/workers — user-facing controls and visibility for this server's
 * background workers.
 *
 *   GET /api/workers/status  → resolved policy + per-worker runtime state +
 *                              pending embedding queue depth
 *   PUT /api/workers/policy  → update mode / batch size / sweep interval
 *
 * The policy itself is stored in the generic settings table (`workers`
 * category), so `PUT /api/settings/workers/:key` works too. This route exists
 * because the UI wants all three knobs written together and the status read is
 * the thing a user actually watches — one endpoint instead of three settings
 * calls plus a coverage query.
 *
 * `RUN_BACKGROUND_WORKERS=false` is reported (`policy.envEnabled === false`)
 * but never writable here: it is a deployment-level hard override.
 */

import { Router, type Request, type Response } from 'express';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';
import { asyncHandler } from '@server/middleware';
import { sendOk } from '@server/utils/http';
import { ErrorCode, HTTP_STATUS, isWorkerMode } from '@snaglet/shared/types';
import type { WorkerQueueDepth, WorkerStatusResponse } from '@snaglet/shared/types';
import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { settingsService } from '@server/services/settings/settingsService';
import {
  workerSettings,
  WORKER_BATCH_SIZE_MAX,
  WORKER_BATCH_SIZE_MIN,
  WORKER_SWEEP_INTERVAL_SECONDS_MAX,
  WORKER_SWEEP_INTERVAL_SECONDS_MIN,
} from '@server/services/settings/categories/workers';
import { peekWorkerPolicy, resolveWorkerPolicy } from '@server/services/workers/workerPolicy';
import { listWorkerStatus } from '@server/services/workers/workerStatus';
import { getEmbeddingQueueDepth } from '@server/workers/EmbeddingWorker';

const router = Router();

/** Queue depth is a nice-to-have on a status read — never fail the whole
 * response because a coverage query did. */
async function safeQueueDepth(): Promise<WorkerQueueDepth> {
  try {
    return await getEmbeddingQueueDepth();
  } catch (err) {
    logger.warn(`[workers] queue depth unavailable: ${getErrorMessage(err)}`);
    return { total: 0, capped: false, cap: 0, byKind: {}, ready: false };
  }
}

/**
 * GET /api/workers/status
 *
 * Everything the Background work pane renders: which mode is in force (and
 * whether the environment is overriding it), whether a sweep is in flight,
 * when the last one finished and how it went, and how much work is pending.
 */
router.get(
  '/status',
  asyncHandler(async (_req: Request, res: Response) => {
    let policy;
    try {
      policy = await resolveWorkerPolicy();
    } catch (err) {
      // The status surface must still answer when the settings read fails —
      // the last known policy is more useful than a 500.
      logger.warn(`[workers] policy read failed, serving last known: ${getErrorMessage(err)}`);
      policy = peekWorkerPolicy();
    }

    const body: WorkerStatusResponse = {
      automaticLocalIntelligenceEnabled: isAutomaticLocalIntelligenceEnabled(),
      policy,
      workers: listWorkerStatus(),
      queue: await safeQueueDepth(),
    };
    sendOk(res, body);
  })
);

function badRequest(message: string): AppError {
  return new AppError(message, ErrorCode.VALIDATION_ERROR, HTTP_STATUS.BAD_REQUEST);
}

function parseIntInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw badRequest(`${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw badRequest(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * PUT /api/workers/policy
 *
 * Partial update — omit a field to leave it alone. Every field is validated
 * before any is written, so a 400 leaves the policy untouched. Writes go
 * through `settingsService`, so the change event fires and the running worker
 * re-arms itself without a restart.
 */
router.put(
  '/policy',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const writes: Array<() => Promise<unknown>> = [];

    if ('mode' in body) {
      const mode = body.mode;
      if (!isWorkerMode(mode)) {
        throw badRequest('mode must be one of: balanced, immediate, paused, off');
      }
      writes.push(() => settingsService.write(workerSettings.mode, mode));
    }

    for (const [field, setting] of [
      ['hooksEnabled', workerSettings.hooksEnabled],
      ['embeddingsEnabled', workerSettings.embeddingsEnabled],
    ] as const) {
      if (field in body) {
        const enabled = body[field];
        if (typeof enabled !== 'boolean') throw badRequest(`${field} must be a boolean`);
        writes.push(() => settingsService.write(setting, enabled));
      }
    }

    if ('batchSize' in body) {
      const batchSize = parseIntInRange(
        body.batchSize,
        'batchSize',
        WORKER_BATCH_SIZE_MIN,
        WORKER_BATCH_SIZE_MAX
      );
      writes.push(() => settingsService.write(workerSettings.batchSize, batchSize));
    }

    if ('sweepIntervalSeconds' in body) {
      const seconds = parseIntInRange(
        body.sweepIntervalSeconds,
        'sweepIntervalSeconds',
        WORKER_SWEEP_INTERVAL_SECONDS_MIN,
        WORKER_SWEEP_INTERVAL_SECONDS_MAX
      );
      writes.push(() => settingsService.write(workerSettings.sweepIntervalSeconds, seconds));
    }

    for (const write of writes) await write();
    sendOk(res, await resolveWorkerPolicy());
  })
);

export default router;
