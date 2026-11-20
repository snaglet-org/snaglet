import { Router, Request, Response } from 'express';
import { checkDatabaseConnection, getDbClient } from '@snaglet/db';
import { pendingMigrationCount } from '@snaglet/db/migrations';
import { resolveDbHome } from '@snaglet/db/runtime/snaglet-home';
import { formatTimestamp, formatUptime, formatBytes } from '@snaglet/shared/utils';
import { HTTP_STATUS } from '@snaglet/shared/types';
import { logger } from '@server/config/logger';
import { probeEmbeddingModel } from '@server/services/embedding/EmbeddingProvider';
import { embeddingSettings } from '@server/services/embedding/EmbeddingSettings';
import { isAutomaticLocalIntelligenceEnabled } from '@server/config/localIntelligencePolicy';

const router = Router();

/**
 * Pending-migration probe, cached briefly: readiness is polled (e2e helpers,
 * smoke scripts) and the ledger + migration-dir read is not free. A short TTL
 * still flips to ready within seconds of `pnpm db:migrate` finishing.
 */
const SCHEMA_PROBE_TTL_MS = 5_000;
let schemaProbe: { at: number; pending: number } | null = null;

async function pendingSchemaMigrations(): Promise<number> {
  const now = Date.now();
  if (schemaProbe && now - schemaProbe.at < SCHEMA_PROBE_TTL_MS) return schemaProbe.pending;
  const pending = await pendingMigrationCount(await getDbClient());
  schemaProbe = { at: now, pending };
  return pending;
}

router.get('/', (_req: Request, res: Response) => {
  res.status(HTTP_STATUS.OK).json({
    status: 'ok',
    timestamp: formatTimestamp(),
  });
});

router.get('/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, { status: 'ok' | 'error' | 'degraded'; message?: string }> = {};

  try {
    await checkDatabaseConnection();
    checks.database = { status: 'ok' };
  } catch (error) {
    // Log full error server-side for debugging, but don't expose it to callers
    logger.error('[health] Database readiness check failed:', error);
    checks.database = {
      status: 'error',
      message: 'Database unavailable',
    };
  }

  // Schema currency. Source-development boot deliberately does not apply
  // migrations (see initializeDatabase), so a checkout whose code expects a
  // newer schema than the database has must not report ready — every query
  // against a changed table would 500 behind a green light.
  if (checks.database.status === 'ok') {
    try {
      const pending = await pendingSchemaMigrations();
      checks.schema =
        pending > 0
          ? {
              status: 'error',
              message: `${pending} pending schema migration(s) for ${resolveDbHome()} — run \`SNAGLET_ENV=dev pnpm db:migrate\` (set SNAGLET_HOME to that path first if it is not the dev instance)`,
            }
          : { status: 'ok' };
    } catch (error) {
      // Unknown schema state is not ready: the same false-green risk as a
      // pending migration if the ledger itself cannot be read.
      logger.error('[health] Schema readiness probe failed:', error);
      checks.schema = { status: 'error', message: 'schema state could not be determined' };
    }
  }

  if (!isAutomaticLocalIntelligenceEnabled()) {
    checks.embedding = { status: 'ok', message: 'automatic local intelligence disabled' };
  } else {
    // 'degraded' = retrieval is impaired but the app is still operational.
    try {
      const probeError = await probeEmbeddingModel(await embeddingSettings.getActiveModel());
      checks.embedding = probeError
        ? { status: 'degraded', message: probeError }
        : { status: 'ok' };
    } catch (error) {
      logger.warn('[health] Embedding probe failed:', error);
      checks.embedding = { status: 'degraded', message: 'embedding probe threw unexpectedly' };
    }
  }

  const allOk = Object.values(checks).every(
    (check) => check.status === 'ok' || check.status === ('degraded' as string)
  );
  const statusCode = allOk ? 200 : 503;

  res.status(statusCode).json({
    status: allOk ? 'ready' : 'not_ready',
    timestamp: formatTimestamp(),
    checks,
  });
});

router.get('/metrics', (_req: Request, res: Response) => {
  const uptime = process.uptime();
  const memoryUsage = process.memoryUsage();

  res.status(HTTP_STATUS.OK).json({
    uptime: {
      seconds: Math.floor(uptime),
      human: formatUptime(uptime),
    },
    memory: {
      rss: formatBytes(memoryUsage.rss),
      heapTotal: formatBytes(memoryUsage.heapTotal),
      heapUsed: formatBytes(memoryUsage.heapUsed),
      external: formatBytes(memoryUsage.external),
    },
    timestamp: formatTimestamp(),
  });
});

export default router;
