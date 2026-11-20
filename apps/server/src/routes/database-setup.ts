/**
 * Database-setup routes — backs Settings → Data & Search → DB Setup.
 *
 * Reports the active managed/external database mode without ever returning
 * credentials. External URLs can be connection-tested but are not persisted
 * by this route; process/desktop configuration remains the source of truth.
 *
 * GET  /api/database-setup          — managed/external runtime status
 * POST /api/database-setup/test-external — validate an external URL
 * POST /api/database-setup/restart  — exit so the supervisor (nodemon in dev,
 *                                     the desktop shell's sidecar manager in
 *                                     packaged builds) brings the server back up
 */

import { Router } from 'express';
import { existsSync, utimesSync } from 'fs';
import { join } from 'path';
import { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { getDatabaseRuntimeStatus, getDbClient } from '@snaglet/db/db';
import { AppError } from '@snaglet/shared/utils';
import { ErrorCode, HTTP_STATUS } from '@snaglet/shared/types';
import { asyncHandler } from '@server/middleware';
import { logger } from '@server/config/logger';
import { sendOk } from '@server/utils/http';

const router = Router();

interface DatabaseSetupState {
  mode: 'managed' | 'external';
  available: boolean;
  managed?: {
    state: 'uninitialized' | 'stopped' | 'stale' | 'running' | 'conflict';
    running: boolean;
    postgresVersion: string;
    pgvectorVersion: string;
    dataDir: string;
    sizeBytes: number;
    pid?: number;
    detail?: string;
  };
  external?: { configured: boolean; displayTarget: string | null };
}

function externalDisplayTarget(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value);
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.hostname}${port}${parsed.pathname || '/'}`;
  } catch {
    return null;
  }
}

async function currentState(): Promise<DatabaseSetupState> {
  const status = await getDatabaseRuntimeStatus();
  if (status.mode === 'managed' && status.managed) {
    let sizeBytes = 0;
    if (status.available && status.managed.running) {
      const size = await (
        await getDbClient()
      ).query<{ sizeBytes: number }>(
        'SELECT pg_database_size(current_database())::int8 AS "sizeBytes"'
      );
      sizeBytes = size.rows[0]?.sizeBytes ?? 0;
    }
    return {
      mode: status.mode,
      available: status.available,
      managed: {
        state: status.managed.state,
        running: status.managed.running,
        postgresVersion: status.managed.postgresVersion,
        pgvectorVersion: status.managed.pgvectorVersion,
        dataDir: status.managed.dataDir,
        sizeBytes,
        pid: status.managed.pid,
        detail: status.managed.detail,
      },
    };
  }
  // Internally this is the `url` mode (SNAGLET_DATABASE_URL override). The wire
  // contract uses the `external` key the desktop UI reads.
  if (status.mode === 'url') {
    return {
      mode: 'external',
      available: status.available,
      external: {
        configured: status.url?.configured ?? false,
        displayTarget: externalDisplayTarget(process.env.SNAGLET_DATABASE_URL),
      },
    };
  }
  throw new Error(`[database-setup] Unsupported database mode: ${String(status.mode)}`);
}

router.get(
  '/',
  asyncHandler(async (_req, res) => {
    sendOk(res, await currentState());
  })
);

router.post(
  '/test-external',
  asyncHandler(async (req, res) => {
    const databaseUrl =
      typeof req.body?.databaseUrl === 'string' ? req.body.databaseUrl.trim() : '';
    if (!databaseUrl) {
      throw new AppError(
        'databaseUrl is required',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new AppError(
        'databaseUrl must be a valid PostgreSQL URL',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      throw new AppError(
        'databaseUrl must use postgres:// or postgresql://',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    }

    const adapter = new PostgresAdapter({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 5_000,
    });
    try {
      const result = await adapter.query<{
        database: string;
        version: string;
        vectorInstalled: boolean;
        pgTrgmInstalled: boolean;
      }>(`SELECT
        current_database() AS database,
        current_setting('server_version') AS version,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS "vectorInstalled",
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS "pgTrgmInstalled"`);
      sendOk(res, result.rows[0]);
    } catch (error: unknown) {
      logger.warn('[database-setup] external PostgreSQL connection test failed', {
        errorType: error instanceof Error ? error.name : 'UnknownError',
      });
      throw new AppError(
        'Could not connect to external PostgreSQL with the supplied URL',
        ErrorCode.VALIDATION_ERROR,
        HTTP_STATUS.BAD_REQUEST
      );
    } finally {
      await adapter.end();
    }
  })
);

router.post(
  '/restart',
  asyncHandler(async (_req, res) => {
    logger.info('[database-setup] restart requested from settings UI');
    sendOk(res, { restarting: true });
    setTimeout(() => {
      // Dev path: nodemon does not restart on a clean exit (it waits for a
      // file change), so bump the entrypoint's mtime — nodemon sees the
      // "change" and restarts us gracefully. No content is modified.
      try {
        const entry = join(process.cwd(), 'src', 'index.ts');
        if (existsSync(entry)) {
          const now = new Date();
          utimesSync(entry, now, now);
          return; // nodemon takes it from here
        }
      } catch {
        // fall through to exit
      }
      // Packaged path: no nodemon, no src/ tree — exit and let the desktop
      // shell's sidecar manager bring the server back up.
      process.exit(0);
    }, 300);
  })
);

export default router;
