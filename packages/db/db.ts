import {
  PostgresBackupAdapter,
  PostgresAdapter,
  type BackupAdapter,
  type DbClient,
  type DbQueryResult,
} from './adapters';
import type { PoolConfig } from 'pg';
import { bootstrapIfFresh, pendingMigrationCount } from './migrations';
import { upgradeManagedDatabase } from './runtime/postgres/startup-upgrade';
// Re-exported for tools that manage their own DbClient.
export {
  bootstrapIfFresh,
  applyPendingMigrations,
  pendingMigrationCount,
  createMigration,
} from './migrations';
import { isCliEntry } from './db-dirname';
import { loadEnvFile } from './runtime/load-env';
import { guardScriptTarget } from './runtime/script-target';
import { resolveDbHome } from './runtime/snaglet-home';
import * as path from 'node:path';
import {
  bundledMigrationCount,
  PostgresRuntime,
  provisionTablesReaderRole,
  stampPostgresDataDir,
  TABLES_READER_ROLE,
} from './runtime/postgres/runtime';
import { recoverInterruptedPostgresRestore } from './runtime/postgres/restore-swap';
import { CUSTOM_TABLES_SCHEMA } from './runtime/postgres/readerRole';
import {
  assertReaderSessionRestricted,
  assertWorkspaceReaderRestricted,
  provisionWorkspaceReaderRole,
  WORKSPACE_READER_ROLE,
  WORKSPACE_READER_SEARCH_PATH,
} from './runtime/postgres/workspaceReader';
import {
  assertWorkspaceWriterRestricted,
  provisionWorkspaceWriterRole,
  WORKSPACE_WRITER_ROLE,
  WORKSPACE_WRITER_SEARCH_PATH,
} from './runtime/postgres/workspaceWriter';
import { PGVECTOR_VERSION, POSTGRES_VERSION } from './runtime/postgres/version';
import { getErrorMessage } from '@snaglet/shared/utils';

loadEnvFile();

/**
 * Initialize the database on server start.
 *
 * Fresh installs apply the bundled schema. Packaged managed databases create
 * a verified backup before upgrading; source development keeps explicit
 * `pnpm db:migrate` control over existing schemas.
 */
export async function initializeDatabase(): Promise<void> {
  const db = await getDbClient();
  const bootstrapped = await bootstrapIfFresh(db);
  if (bootstrapped && _managedRuntime?.owned) {
    await stampPostgresDataDir(_managedRuntime.dataDir);
  } else if (!bootstrapped && _managedRuntime?.owned) {
    await upgradeManagedDatabase(db, {
      snagletHome: _managedRuntime.snagletHome,
      dataDir: _managedRuntime.dataDir,
      backup: await getBackupAdapter(),
    });
  } else if (!bootstrapped) {
    const pending = await pendingMigrationCount(db);
    if (pending > 0) {
      // Source development keeps explicit control over existing schemas, so
      // this is deliberately not applied here — but the server's code already
      // expects the new schema, so say it loudly. /health/ready reports the
      // same condition as `schema: error` until the migrations are applied.
      console.warn(
        `[db] WARNING: ${pending} pending schema migration(s) for ${resolveDbHome()} — this checkout's code expects them. ` +
          'Queries against changed tables will fail until you run `SNAGLET_ENV=dev pnpm db:migrate` ' +
          '(set SNAGLET_HOME to that path first if this is not the dev instance).'
      );
    }
  }
  // Reader grants follow the schema, so they are (re)built once migrations
  // have run. Never throws: a failure leaves that agent SQL refused.
  await refreshManagedReaders();
}

export async function checkDatabaseConnection(): Promise<void> {
  const db = await getDbClient();
  await db.transaction(async (tx) => {
    await tx.query('SET LOCAL statement_timeout = 5000');
    await tx.query('SELECT 1');
  });
}

/**
 * Run a function inside a database transaction. Commits on success, rolls back
 * on throw. Per-tx queries arrive on a `DbClient` scoped to the transaction.
 */
export async function transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
  const db = await getDbClient();
  return db.transaction(fn);
}

let _dbClient: DbClient | null = null;
let _activeMode: DatabaseMode | null = null;
let _managedRuntime: PostgresRuntime | null = null;
let _postgresConnection: PoolConfig | null = null;
/** How to reach the cluster as the tables reader; null means SQL mode is refused. */
let _tablesReaderConnection: PoolConfig | null = null;
let _tablesReaderClient: Promise<PostgresAdapter | null> | null = null;
/** How to reach the cluster as the workspace reader; null means database_query is refused. */
let _workspaceReaderConnection: PoolConfig | null = null;
let _workspaceReaderClient: Promise<PostgresAdapter | null> | null = null;
/** How to reach the cluster as the workspace writer; null refuses database_execute / create_view. */
let _workspaceWriterConnection: PoolConfig | null = null;
let _workspaceWriterClient: Promise<PostgresAdapter | null> | null = null;
/** Managed mode: what the reader roles are provisioned from. Null in url mode. */
let _managedReaderSetup: ManagedReaderSetup | null = null;
/** The latest (serialized) managed reader provisioning; null until first needed. */
let _managedReadersProvisioned: Promise<void> | null = null;
/** Bumped whenever the database under the readers changes (close, restore). */
let _managedReaderGeneration = 0;
let _databaseSwapWait: Promise<void> | null = null;
let _releaseDatabaseSwap: (() => void) | null = null;
let _rejectDatabaseSwap: ((error: Error) => void) | null = null;
let _databaseSwapFailure: Error | null = null;

/**
 * How the process reached its database.
 *
 * `managed` is the only lifecycle Snaglet operates: it starts and owns the local
 * cluster. `url` means an explicit `SNAGLET_DATABASE_URL` pointed us at a server
 * somebody else runs — a connection-string override, not a second lifecycle.
 * `SNAGLET_DB_MODE` is not a supported switch; see `resolveDatabaseMode`.
 */
export type DatabaseMode = 'managed' | 'url';

/**
 * Read the optional `SNAGLET_DATABASE_URL` override.
 *
 * Returns null when unset, which is the normal case — callers then use the
 * managed cluster. When set it must be a valid postgres:// URL; a malformed
 * value is a hard error rather than a silent fallback, because falling back
 * would quietly write to a different database than the operator intended.
 */
export function resolveDatabaseUrlOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.SNAGLET_DATABASE_URL?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[db] SNAGLET_DATABASE_URL must be a valid PostgreSQL connection URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('[db] SNAGLET_DATABASE_URL must use the postgres:// or postgresql:// scheme');
  }
  return value;
}

/**
 * Read the optional `SNAGLET_TABLES_READER_URL`: how to reach the database as a
 * non-superuser reader role when `SNAGLET_DATABASE_URL` points at a server Snaglet does
 * not manage. Unset means agent SQL is refused there, never run as the app
 * user. Same validation as the primary override.
 */
export function resolveTablesReaderUrlOverride(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env.SNAGLET_TABLES_READER_URL?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[db] SNAGLET_TABLES_READER_URL must be a valid PostgreSQL connection URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      '[db] SNAGLET_TABLES_READER_URL must use the postgres:// or postgresql:// scheme'
    );
  }
  return value;
}

/**
 * Read the optional `SNAGLET_WORKSPACE_READER_URL`: how `database_query` reaches an
 * `SNAGLET_DATABASE_URL` database as a restricted reader. Unset means the tool is
 * refused there, never run as the app user; a reader that can see more than
 * Snaglet's workspace policy is refused at first use.
 */
export function resolveWorkspaceReaderUrlOverride(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env.SNAGLET_WORKSPACE_READER_URL?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[db] SNAGLET_WORKSPACE_READER_URL must be a valid PostgreSQL connection URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      '[db] SNAGLET_WORKSPACE_READER_URL must use the postgres:// or postgresql:// scheme'
    );
  }
  return value;
}

/**
 * Read the optional `SNAGLET_WORKSPACE_WRITER_URL`: how `database_execute` and
 * `create_view` reach a `SNAGLET_DATABASE_URL` database as a restricted writer
 * that can touch only the custom `user_tables` schema. Unset means both tools
 * are refused there, never run as the app user; a writer that can reach Snaglet's
 * system tables is refused at first use. Same validation as the primary
 * override.
 */
export function resolveWorkspaceWriterUrlOverride(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const value = env.SNAGLET_WORKSPACE_WRITER_URL?.trim();
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[db] SNAGLET_WORKSPACE_WRITER_URL must be a valid PostgreSQL connection URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      '[db] SNAGLET_WORKSPACE_WRITER_URL must use the postgres:// or postgresql:// scheme'
    );
  }
  return value;
}

export function resolveDatabaseMode(env: NodeJS.ProcessEnv = process.env): DatabaseMode {
  const override = resolveDatabaseUrlOverride(env);
  // `SNAGLET_DB_MODE` is not supported. A value other than `managed` without
  // SNAGLET_DATABASE_URL is rejected rather than resolved to `managed`, which would
  // connect to the SNAGLET_HOME cluster and write to the live database the operator
  // meant to avoid.
  const retired = env.SNAGLET_DB_MODE?.trim();
  if (retired && retired !== 'managed' && !override) {
    throw new Error(
      `[db] SNAGLET_DB_MODE is retired (found ${JSON.stringify(retired)}). ` +
        'Set SNAGLET_DATABASE_URL to select an external database, or unset SNAGLET_DB_MODE.'
    );
  }
  return override ? 'url' : 'managed';
}

export interface DatabaseRuntimeStatus {
  mode: DatabaseMode;
  available: boolean;
  managed?: {
    state: 'uninitialized' | 'stopped' | 'stale' | 'running' | 'conflict';
    running: boolean;
    dataDir: string;
    socketDir: string;
    host: string;
    port?: number;
    transport: 'tcp' | 'socket';
    pid?: number;
    detail?: string;
    postgresVersion: string;
    pgvectorVersion: string;
  };
  url?: { configured: boolean; error?: string };
}

/** Read-only status for the local setup surface; credentials are never exposed. */
export async function getDatabaseRuntimeStatus(): Promise<DatabaseRuntimeStatus> {
  // Never let a malformed override throw here. This backs the setup page, the
  // one surface that should be able to tell you the URL is malformed; if it
  // 500s, the operator is left with a blank page and no explanation.
  if (_activeMode === null) {
    try {
      resolveDatabaseUrlOverride();
    } catch (err) {
      return {
        mode: 'url',
        available: false,
        url: { configured: true, error: getErrorMessage(err) },
      };
    }
  }
  const mode = _activeMode ?? resolveDatabaseMode();
  if (mode === 'managed') {
    const runtime = _managedRuntime ?? new PostgresRuntime();
    const status = await runtime.status();
    return {
      mode,
      available: _dbClient !== null,
      managed: {
        state: status.state,
        running: status.running,
        dataDir: status.dataDir,
        socketDir: status.socketDir,
        host: status.host,
        port: status.port,
        transport: status.transport,
        pid: status.pid,
        detail: status.detail,
        postgresVersion: POSTGRES_VERSION,
        pgvectorVersion: PGVECTOR_VERSION,
      },
    };
  }
  return {
    mode,
    available: _dbClient !== null,
    url: { configured: true },
  };
}

/**
 * True once `closeDatabase()` has torn down `_dbClient`. Lets `getDbClient()`
 * tell "never opened yet" (fine — normal boot) apart from "explicitly closed,
 * then asked for again" (almost always a bug — see the guard below). Cleared
 * on the next successful open so a legitimate, acknowledged reopen leaves the
 * client in a normal, non-flagged state.
 */
let _closedSinceLastOpen = false;
let _databaseOpen: Promise<DbClient> | null = null;
let _databaseClose: Promise<void> | null = null;
let _databaseCloseGeneration = 0;

/**
 * Public accessor for the data-format stamp (logged at startup, shown in About).
 */
export function getSchemaFormatVersion(): number {
  return bundledMigrationCount();
}

export interface GetDbClientOptions {
  /**
   * Acknowledge that this call is an intentional reopen after `closeDatabase()`
   * — e.g. restore/test scaffolding that deliberately re-points the singleton.
   * Without this, `getDbClient()` throws instead of silently reopening — see
   * the block comment on `getDbClient()` for why.
   */
  allowReopenAfterClose?: boolean;
}

/**
 * The active `DbClient`. Lazy — first call opens the selected adapter;
 * subsequent calls return the cached instance.
 *
 * Guard: a call that arrives after `closeDatabase()` has already run (and
 * hasn't passed `{ allowReopenAfterClose: true }`) throws instead of quietly
 * opening a fresh pool. This turns test-teardown ordering bugs into immediate
 * failures instead of leaked PostgreSQL handles. A process's first open is
 * unaffected.
 */
export async function getDbClient(options?: GetDbClientOptions): Promise<DbClient> {
  if (_databaseClose) await _databaseClose;
  if (_databaseSwapWait) await _databaseSwapWait;
  // A caller can have joined the swap gate before shutdown began. Once the
  // restore resumes, wait for that already-published close before returning a
  // candidate pool the closer is about to end.
  if (_databaseClose) await _databaseClose;
  if (_databaseSwapFailure) throw _databaseSwapFailure;
  if (_dbClient) return _dbClient;
  if (_databaseOpen) return _databaseOpen;
  if (_closedSinceLastOpen && !options?.allowReopenAfterClose) {
    throw new Error(
      '[db] getDbClient() called after closeDatabase() already ran, with no explicit ' +
        'reopen requested. This is almost always a test-teardown ordering bug: a ' +
        'file-level cleanup is querying after the shared database teardown already ' +
        'closed the pool. To fix it, nest the DB-touching `afterAll` inside its ' +
        '`describe()` block so it unwinds before the shared teardown. If a ' +
        'reopen after close is genuinely intentional, call ' +
        'getDbClient({ allowReopenAfterClose: true }) explicitly.'
    );
  }
  const opening = openDatabaseClient(_databaseCloseGeneration);
  _databaseOpen = opening;
  try {
    return await opening;
  } finally {
    if (_databaseOpen === opening) _databaseOpen = null;
  }
}

function assertDatabaseOpenNotCanceled(generation: number): void {
  if (generation !== _databaseCloseGeneration) {
    throw new Error('[db] Database initialization was interrupted by closeDatabase()');
  }
}

async function openDatabaseClient(generation: number): Promise<DbClient> {
  // Go through resolveDatabaseMode() rather than re-deriving "URL means url
  // mode" here: one encoding of that rule, including the SNAGLET_DB_MODE check.
  const mode = resolveDatabaseMode();
  const urlOverride = resolveDatabaseUrlOverride();
  if (mode === 'managed') {
    const runtime = new PostgresRuntime();
    // Publish ownership before the first await so shutdown can always account
    // for a postmaster which is still starting, even before a pool exists.
    _managedRuntime = runtime;
    try {
      await runtime.start();
    } catch (error: unknown) {
      try {
        await runtime.stopIfOwned('fast');
      } catch (stopError: unknown) {
        console.error(
          `[DB] failed to stop managed PostgreSQL after boot error: ${getErrorMessage(
            stopError,
            'unknown error'
          )}`
        );
      }
      throw error;
    }
    assertDatabaseOpenNotCanceled(generation);
    const connection = await runtime.connectionInfo();
    assertDatabaseOpenNotCanceled(generation);
    console.log(
      `[DB] connecting to managed PostgreSQL at ${connection.host}:${connection.port ?? 5432}`
    );
    _postgresConnection = {
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password,
    };
    _dbClient = new PostgresAdapter(_postgresConnection);
    // The readers are bounded extras on top of a healthy `snaglet` connection,
    // provisioned after migrations (or on first use): a failure logs and
    // leaves that agent SQL refused; it never blocks boot.
    _managedReaderSetup = {
      runtime,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      tablesPassword: connection.readerPassword,
      workspacePassword: connection.workspaceReaderPassword,
      writerPassword: connection.workspaceWriterPassword,
    };
    _managedReadersProvisioned = null;
    _tablesReaderConnection = null;
    _workspaceReaderConnection = null;
    _workspaceWriterConnection = null;
  } else {
    console.log('[DB] connecting to PostgreSQL via SNAGLET_DATABASE_URL override');
    _postgresConnection = { connectionString: urlOverride as string };
    await recoverInterruptedPostgresRestore({
      connection: _postgresConnection,
      markerPath: path.join(resolveDbHome(), 'pg-restore-swap.json'),
      log: (line) => console.log(`[DB] restore recovery: ${line}`),
    });
    assertDatabaseOpenNotCanceled(generation);
    _dbClient = new PostgresAdapter(_postgresConnection);
    // Snaglet provisions no roles on a server it does not manage; the operator
    // supplies reader connections or that agent SQL stays refused.
    _managedReaderSetup = null;
    const readerUrl = resolveTablesReaderUrlOverride();
    _tablesReaderConnection = readerUrl ? { connectionString: readerUrl } : null;
    const workspaceReaderUrl = resolveWorkspaceReaderUrlOverride();
    _workspaceReaderConnection = workspaceReaderUrl
      ? { connectionString: workspaceReaderUrl }
      : null;
    const workspaceWriterUrl = resolveWorkspaceWriterUrlOverride();
    _workspaceWriterConnection = workspaceWriterUrl
      ? { connectionString: workspaceWriterUrl }
      : null;
  }
  if (!_dbClient) throw new Error(`[db] Failed to initialize ${mode} database client`);
  _activeMode = mode;
  _closedSinceLastOpen = false;
  return _dbClient;
}

interface ManagedReaderSetup {
  runtime: PostgresRuntime;
  host: string;
  port?: number;
  database: string;
  tablesPassword?: string;
  workspacePassword?: string;
  writerPassword?: string;
}

/**
 * Managed clusters: make sure the reader role exists with the credential Snaglet
 * holds, then describe how to connect as it. Returns null (and warns) when
 * any step fails, so the caller refuses agent SQL instead of running it as
 * the superuser.
 */
async function provisionManagedTablesReader(
  setup: ManagedReaderSetup,
  db: DbClient
): Promise<PoolConfig | null> {
  const password = setup.tablesPassword;
  if (!password) return null;
  try {
    await setup.runtime.ensureTablesReaderHbaEntry();
    await provisionTablesReaderRole(db, {
      password,
      database: setup.database,
      revokePublic: true,
    });
    return {
      host: setup.host,
      port: setup.port,
      database: setup.database,
      user: TABLES_READER_ROLE,
      password,
    };
  } catch (error: unknown) {
    console.warn(
      `[DB] tables reader role unavailable; agent SQL will be refused: ${getErrorMessage(error)}`
    );
    return null;
  }
}

/** {@link provisionManagedTablesReader} for the `database_query` reader. */
async function provisionManagedWorkspaceReader(
  setup: ManagedReaderSetup,
  db: DbClient
): Promise<PoolConfig | null> {
  const password = setup.workspacePassword;
  if (!password) return null;
  try {
    await setup.runtime.ensureWorkspaceReaderHbaEntry();
    const report = await provisionWorkspaceReaderRole(db, {
      password,
      database: setup.database,
      revokePublic: true,
    });
    if (report.unclassified.length > 0 || report.withheldColumns.length > 0) {
      console.warn(
        '[DB] workspace reader: hidden from database_query until classified in ' +
          `WORKSPACE_READER_POLICY: ${[...report.unclassified, ...report.withheldColumns].join(', ')}`
      );
    }
    return {
      host: setup.host,
      port: setup.port,
      database: setup.database,
      user: WORKSPACE_READER_ROLE,
      password,
    };
  } catch (error: unknown) {
    console.warn(
      `[DB] workspace reader role unavailable; database_query will be refused: ${getErrorMessage(error)}`
    );
    return null;
  }
}

/** {@link provisionManagedWorkspaceReader} for the write-side writer role. */
async function provisionManagedWorkspaceWriter(
  setup: ManagedReaderSetup,
  db: DbClient
): Promise<PoolConfig | null> {
  const password = setup.writerPassword;
  if (!password) return null;
  try {
    await setup.runtime.ensureWorkspaceWriterHbaEntry();
    await provisionWorkspaceWriterRole(db, {
      password,
      database: setup.database,
      revokePublic: true,
    });
    return {
      host: setup.host,
      port: setup.port,
      database: setup.database,
      user: WORKSPACE_WRITER_ROLE,
      password,
    };
  } catch (error: unknown) {
    console.warn(
      '[DB] workspace writer role unavailable; database_execute and create_view will be ' +
        `refused: ${getErrorMessage(error)}`
    );
    return null;
  }
}

async function provisionManagedReaders(setup: ManagedReaderSetup): Promise<void> {
  const generation = _managedReaderGeneration;
  const db = _dbClient;
  if (!db || _managedReaderSetup !== setup) return;
  const tables = await provisionManagedTablesReader(setup, db);
  const workspace = await provisionManagedWorkspaceReader(setup, db);
  const writer = await provisionManagedWorkspaceWriter(setup, db);
  // A close or restore may have swapped the database while this ran; the
  // next use provisions again against the new one.
  if (_managedReaderSetup !== setup || _managedReaderGeneration !== generation) return;
  _tablesReaderConnection = tables;
  _workspaceReaderConnection = workspace;
  _workspaceWriterConnection = writer;
}

/** Queue a provisioning run after any in flight; runs never overlap. */
function scheduleManagedReaders(setup: ManagedReaderSetup): Promise<void> {
  const previous = _managedReadersProvisioned ?? Promise.resolve();
  const next = previous.then(() => provisionManagedReaders(setup));
  _managedReadersProvisioned = next;
  return next;
}

/** Managed mode: provision the reader roles once per open, on first need. */
async function ensureManagedReaders(): Promise<void> {
  const setup = _managedReaderSetup;
  if (!setup) return;
  await (_managedReadersProvisioned ?? scheduleManagedReaders(setup));
}

/**
 * Managed mode: rebuild both reader roles and their grants against the
 * current schema. Called at boot once migrations have run; idempotent, and a
 * no-op in url mode. Never throws.
 */
export async function refreshManagedReaders(): Promise<void> {
  const setup = _managedReaderSetup;
  if (setup) await scheduleManagedReaders(setup);
}

/** Server-side ceiling on one reader statement; the role default says the same. */
export const TABLES_READER_STATEMENT_TIMEOUT_MS = 5_000;
/** Client-side ceiling; a query still on the wire past this is canceled server-side. */
export const TABLES_READER_QUERY_TIMEOUT_MS = 7_000;

/** Server-side ceiling on one writer statement; the role default says the same. */
export const WORKSPACE_WRITER_STATEMENT_TIMEOUT_MS = 30_000;
/** Client-side ceiling for the writer; a statement still on the wire past this is canceled. */
export const WORKSPACE_WRITER_QUERY_TIMEOUT_MS = 32_000;

interface ReaderPoolSpec {
  label: string;
  applicationName: string;
  searchPath: string;
  /** Read-only session (default true); the writer pool sets it false. */
  readOnly?: boolean;
  /** Server-side statement ceiling; defaults to the readers' 5s. */
  statementTimeoutMs?: number;
  /** Client-side ceiling; defaults to the readers' 7s. */
  queryTimeoutMs?: number;
  /** Server-side lock ceiling; defaults to the readers' 1s. */
  lockTimeoutMs?: number;
  verify(pool: PostgresAdapter): Promise<void>;
}

const TABLES_READER_POOL: ReaderPoolSpec = {
  label: 'tables reader',
  applicationName: 'snaglet-tables-reader',
  searchPath: CUSTOM_TABLES_SCHEMA,
  verify: (pool) => assertReaderSessionRestricted(pool, 'tables reader'),
};

const WORKSPACE_READER_POOL: ReaderPoolSpec = {
  label: 'workspace reader',
  applicationName: 'snaglet-workspace-reader',
  searchPath: WORKSPACE_READER_SEARCH_PATH.replace(/\s+/g, ''),
  verify: (pool) => assertWorkspaceReaderRestricted(pool),
};

const WORKSPACE_WRITER_POOL: ReaderPoolSpec = {
  label: 'workspace writer',
  applicationName: 'snaglet-workspace-writer',
  searchPath: WORKSPACE_WRITER_SEARCH_PATH.replace(/\s+/g, ''),
  readOnly: false,
  statementTimeoutMs: WORKSPACE_WRITER_STATEMENT_TIMEOUT_MS,
  queryTimeoutMs: WORKSPACE_WRITER_QUERY_TIMEOUT_MS,
  lockTimeoutMs: 5_000,
  verify: (pool) => assertWorkspaceWriterRestricted(pool),
};

/**
 * Open a two-connection bounded pool and check, as that role, that it cannot
 * escape its sandbox. A role that fails the check is closed and refused. The
 * reader pools are read-only; the writer pool ({@link WORKSPACE_WRITER_POOL})
 * is read-write but still bounded and confined to its own login role.
 */
async function openReaderPool(
  connection: PoolConfig,
  spec: ReaderPoolSpec
): Promise<PostgresAdapter | null> {
  const readOnly = spec.readOnly ?? true;
  const options = [
    ...(readOnly ? ['-c default_transaction_read_only=on'] : []),
    `-c search_path=${spec.searchPath}`,
  ].join(' ');
  const pool = new PostgresAdapter(
    {
      ...connection,
      application_name: spec.applicationName,
      statement_timeout: spec.statementTimeoutMs ?? TABLES_READER_STATEMENT_TIMEOUT_MS,
      query_timeout: spec.queryTimeoutMs ?? TABLES_READER_QUERY_TIMEOUT_MS,
      lock_timeout: spec.lockTimeoutMs ?? 1_000,
      idle_in_transaction_session_timeout: 10_000,
      // Belt and braces over the role defaults, in case a url-mode operator
      // created the role without them.
      options,
    },
    { poolMax: 2 }
  );
  try {
    await spec.verify(pool);
    return pool;
  } catch (error: unknown) {
    console.warn(
      `[DB] ${spec.label} refused; its agent SQL is disabled: ${getErrorMessage(error)}`
    );
    try {
      await pool.end();
    } catch (endError: unknown) {
      console.warn(`[DB] failed to close the ${spec.label} pool: ${getErrorMessage(endError)}`);
    }
    return null;
  }
}

/**
 * The pool that runs agent SQL as {@link TABLES_READER_ROLE}. Lazy, two
 * connections, and null whenever no reader connection is configured — the
 * caller must then refuse the query. Never a fallback to the app pool.
 */
export async function getTablesReaderClient(): Promise<PostgresAdapter | null> {
  await getDbClient();
  await ensureManagedReaders();
  if (!_tablesReaderClient) {
    const connection = _tablesReaderConnection;
    if (!connection) return null;
    _tablesReaderClient = openReaderPool(connection, TABLES_READER_POOL);
  }
  return _tablesReaderClient;
}

/**
 * The pool `database_query` runs agent SQL on, as `snaglet_workspace_reader` (or
 * the operator's `SNAGLET_WORKSPACE_READER_URL` role). Same contract as
 * {@link getTablesReaderClient}: null means refuse, never fall back.
 */
export async function getWorkspaceReaderClient(): Promise<PostgresAdapter | null> {
  await getDbClient();
  await ensureManagedReaders();
  if (!_workspaceReaderClient) {
    const connection = _workspaceReaderConnection;
    if (!connection) return null;
    _workspaceReaderClient = openReaderPool(connection, WORKSPACE_READER_POOL);
  }
  return _workspaceReaderClient;
}

/**
 * The read-write pool `database_execute` and `create_view` run agent SQL on,
 * as `snaglet_workspace_writer` (or the operator's `SNAGLET_WORKSPACE_WRITER_URL` role).
 * It can write the custom `user_tables` schema and nothing in `public`. Same
 * contract as {@link getWorkspaceReaderClient}: null means refuse, never fall
 * back to the app pool.
 */
export async function getWorkspaceWriterPool(): Promise<PostgresAdapter | null> {
  await getDbClient();
  await ensureManagedReaders();
  if (!_workspaceWriterClient) {
    const connection = _workspaceWriterConnection;
    if (!connection) return null;
    _workspaceWriterClient = openReaderPool(connection, WORKSPACE_WRITER_POOL);
  }
  return _workspaceWriterClient;
}

async function endReaderClients(): Promise<void> {
  const readers = [_tablesReaderClient, _workspaceReaderClient, _workspaceWriterClient];
  _tablesReaderClient = null;
  _workspaceReaderClient = null;
  _workspaceWriterClient = null;
  for (const reader of readers) {
    const pool = reader ? await reader : null;
    if (pool) await pool.end();
  }
}

/**
 * Minimal engine-agnostic query surface — the subset of `DbClient` the Model
 * layer and route/tool code need synchronously in hand. Obtainable without
 * awaiting; each `query()` resolves the adapter lazily.
 */
export interface DbQueryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic default; callers pass concrete T for typed results
  query<T = any>(sql: string, params?: ReadonlyArray<unknown>): Promise<DbQueryResult<T>>;
}

const _dbQueryable: DbQueryable = {
  async query(sql, params) {
    const db = await getDbClient();
    return db.query(sql, params);
  },
};

/**
 * Engine-agnostic query facade — a stable object whose `query()` routes through
 * the active adapter. What Models, routes, and tools use for plain reads/writes.
 */
export function getDb(): DbQueryable {
  return _dbQueryable;
}

/**
 * Close the active client. Managed PostgreSQL survives dev restarts and is
 * stopped only when the desktop sidecar declares lifecycle ownership.
 */
export async function closeDatabase(): Promise<void> {
  if (_databaseClose) return _databaseClose;
  // Closing an in-flight first open must also close the door to late pools.
  _closedSinceLastOpen = true;
  _databaseCloseGeneration += 1;
  const opening = _databaseOpen;
  const closing = closeDatabaseAfterOpen(opening);
  _databaseClose = closing;
  try {
    await closing;
  } finally {
    if (_databaseClose === closing) _databaseClose = null;
  }
}

async function closeDatabaseAfterOpen(opening: Promise<DbClient> | null): Promise<void> {
  // Startup owns its subprocesses until it settles. Never let the server exit
  // while pg_ctl can still launch a detached postmaster after our stop check.
  if (opening) {
    try {
      await opening;
    } catch (error: unknown) {
      console.warn(`[DB] closing after interrupted startup: ${getErrorMessage(error)}`);
    }
  }
  // A restore renames the live database only after it has quiesced this pool.
  // Let that transaction finish (and call resume) before taking the client and
  // runtime snapshot below. `_databaseClose` is already published, so new
  // callers remain blocked rather than joining the restored pool.
  const swap = _databaseSwapWait;
  if (swap) {
    try {
      await swap;
    } catch (error: unknown) {
      // The restore request already surfaced its failure to its caller. Server
      // shutdown must still stop the owned runtime rather than leave a
      // postmaster behind because rollback could not complete.
      console.warn(`[DB] closing after failed restore: ${getErrorMessage(error)}`);
    }
  }
  const dbClient = _dbClient;
  const runtime = _managedRuntime;
  _dbClient = null;
  _activeMode = null;
  _managedRuntime = null;
  _postgresConnection = null;
  _tablesReaderConnection = null;
  _workspaceReaderConnection = null;
  _workspaceWriterConnection = null;
  _managedReaderSetup = null;
  _managedReadersProvisioned = null;
  _managedReaderGeneration += 1;

  try {
    try {
      await endReaderClients();
    } catch (error: unknown) {
      console.warn(`[DB] failed to close the reader pools: ${getErrorMessage(error)}`);
    }
    if (dbClient) {
      await dbClient.end();
      _closedSinceLastOpen = true;
    }
  } finally {
    if (runtime) await runtime.stopIfOwned('fast');
    _backupAdapter = null;
    _releaseDatabaseSwap = null;
    _rejectDatabaseSwap = null;
    _databaseSwapWait = null;
    _databaseSwapFailure = null;
  }
}

/** Alias kept for callers that close the DB explicitly. */
export const closeDbClient = closeDatabase;

// BackupAdapter singleton resolved through the active engine. PostgreSQL
// restore uses a dedicated quiesce/reconnect seam so the runtime and stable
// getDb() facade survive the database rename swap.

let _backupAdapter: BackupAdapter | null = null;

export async function getBackupAdapter(): Promise<BackupAdapter> {
  if (_backupAdapter) return _backupAdapter;
  await getDbClient();
  if (!_postgresConnection) {
    throw new Error('PostgreSQL backup adapter requires active connection configuration');
  }
  const connection = { ..._postgresConnection };
  const markerPath =
    _managedRuntime?.restoreMarkerPath ?? path.join(resolveDbHome(), 'pg-restore-swap.json');
  _backupAdapter = new PostgresBackupAdapter({
    connection,
    markerPath,
    quiesce: async () => {
      if (_databaseSwapFailure) throw _databaseSwapFailure;
      if (!_databaseSwapWait) {
        const swap = new Promise<void>((resolve, reject) => {
          _releaseDatabaseSwap = resolve;
          _rejectDatabaseSwap = reject;
        });
        // A restore can fail before another application request has joined the
        // gate. Observe that rejection so Node does not report it as unhandled;
        // callers that do await it still receive the original terminal error.
        void swap.catch((error: unknown) => {
          console.warn(`[DB] restore swap failed: ${getErrorMessage(error)}`);
        });
        _databaseSwapWait = swap;
      }
      const active = _dbClient;
      _dbClient = null;
      // The restore renames the live database out from under every session;
      // the lazy reader pools reconnect, and managed grants are rebuilt
      // against the restored database, on their next use.
      _managedReadersProvisioned = null;
      _managedReaderGeneration += 1;
      await endReaderClients();
      if (active) await active.end();
    },
    reconnect: async () => {
      const candidate = new PostgresAdapter(connection);
      try {
        await candidate.query('SELECT 1');
        _dbClient = candidate;
      } catch (error: unknown) {
        // eslint-disable-next-line no-restricted-syntax -- intentional: best-effort teardown of a failed candidate connection; the probe error rethrown below is the one that matters
        await candidate.end().catch(() => {});
        throw error;
      }
    },
    resume: () => {
      _releaseDatabaseSwap?.();
      _releaseDatabaseSwap = null;
      _rejectDatabaseSwap = null;
      _databaseSwapWait = null;
    },
    failSwap: (error: unknown) => {
      if (!_databaseSwapWait) return;
      const failure =
        error instanceof Error
          ? error
          : new Error(getErrorMessage(error, 'PostgreSQL restore failed'));
      _databaseSwapFailure = failure;
      _rejectDatabaseSwap?.(failure);
      _releaseDatabaseSwap = null;
      _rejectDatabaseSwap = null;
      _databaseSwapWait = null;
    },
    log: (line) => console.log(`[DB] backup: ${line}`),
  });
  return _backupAdapter;
}

// `pnpm db:init`. Inside the esbuild server bundle this module's URL is
// argv[1] (server.mjs), so a bare isMainModule check would fire the CLI path on
// every server boot. isCliEntry also requires the entry file to be db.ts, which
// the bundle never is — structural, so no env var (SNAGLET_BUNDLED included) can
// skip the CLI's target guard from a checkout.
if (isCliEntry(import.meta.url, 'db')) {
  void (async () => {
    // `pnpm db:init`: target guard first, before anything connects.
    // The packaged server calls initializeDatabase() directly and never gets here.
    const target = guardScriptTarget('init');
    if (!target) return; // refused: exit code 2, nothing opened
    if (target.dryRun) {
      console.error('[db] dry run: target resolved; nothing was initialized.');
      return;
    }
    let exitCode = 0;
    try {
      await initializeDatabase();
      console.log('Done.');
    } catch (err: unknown) {
      console.error('Failed to initialize database:', err);
      exitCode = 1;
    }
    try {
      await closeDatabase();
    } catch (err: unknown) {
      console.error('Failed to close database:', err);
      exitCode = 1;
    }
    process.exitCode = exitCode;
  })();
}
