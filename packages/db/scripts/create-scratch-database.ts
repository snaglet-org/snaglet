import { Pool } from 'pg';
import { getErrorMessage } from '@snaglet/shared/utils';

import { closeDatabase, getDbClient, resolveDatabaseMode } from '../db';
import { isMainModule } from '../db-dirname';
import { guardScriptTarget, parseScriptArgs } from '../runtime/script-target';
import { PostgresRuntime } from '../runtime/postgres/runtime';
import { quoteDatabaseName } from '../runtime/postgres/restore-swap';
import { externalDatabaseUrl, scratchDatabaseName } from '../runtime/postgres/scratch';

function usage(): string {
  return [
    'Usage: pnpm db:scratch <name>',
    '',
    'Creates snaglet_scratch_<name> in the managed PostgreSQL cluster for the current SNAGLET_HOME.',
    'The command is idempotent and prints the external-mode environment to use.',
  ].join('\n');
}

export async function createScratchDatabase(rawName: string): Promise<{
  created: boolean;
  database: string;
  databaseUrl: string;
}> {
  if (resolveDatabaseMode() !== 'managed') {
    throw new Error(
      'db:scratch targets the current SNAGLET_HOME managed cluster; unset SNAGLET_DATABASE_URL first.'
    );
  }

  const database = scratchDatabaseName(rawName);
  // A CLI invocation is never the desktop lifecycle owner, even if launched
  // from a shell that inherited the sidecar variable.
  delete process.env.SNAGLET_PG_OWNED;

  let admin: Pool | undefined;
  let result: { created: boolean; database: string; databaseUrl: string } | undefined;
  let operationError: unknown;
  try {
    // Use the normal managed boot seam so migration and recovery are never
    // bypassed just because the first command run in a Snaglet home was scratch.
    await getDbClient();
    const connection = await new PostgresRuntime().connectionInfo();
    admin = new Pool({
      host: connection.host,
      port: connection.port,
      database: 'postgres',
      user: connection.user,
      password: connection.password,
      max: 1,
    });
    const existing = await admin.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present',
      [database]
    );
    const created = existing.rows[0]?.present !== true;
    if (created) {
      await admin.query(`CREATE DATABASE ${quoteDatabaseName(database)} TEMPLATE template0`);
    }
    result = {
      created,
      database,
      databaseUrl: externalDatabaseUrl({
        database,
        password: connection.password,
        socketDir: connection.socketDir,
        host: connection.host,
        port: connection.port,
        user: connection.user,
      }),
    };
  } catch (error: unknown) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    await admin?.end();
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  try {
    await closeDatabase();
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      'Scratch database creation and cleanup both failed'
    );
  }
  if (operationError) throw operationError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'Scratch database cleanup failed');
  }
  if (!result) throw new Error('Scratch database creation completed without a result');
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }
  // Target guard before the managed boot below can start, recover
  // or migrate anything in the resolved home.
  const target = guardScriptTarget('scratch', args);
  if (!target) return; // refused: exit code 2, nothing opened
  const { rest } = parseScriptArgs(args);
  if (rest.length !== 1) throw new Error(usage());
  if (target.dryRun) {
    console.error(`[db:scratch] dry run: would create ${scratchDatabaseName(rest[0]!)}`);
    return;
  }
  const result = await createScratchDatabase(rest[0]!);
  console.log(`[db:scratch] ${result.created ? 'created' : 'using existing'} ${result.database}`);
  console.log(`SNAGLET_DATABASE_URL=${JSON.stringify(result.databaseUrl)}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[db:scratch] ${getErrorMessage(error)}`);
    process.exitCode = 1;
  });
}
