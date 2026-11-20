import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { Pool, type PoolConfig } from 'pg';
import { getErrorMessage } from '@snaglet/shared/utils';
import { restrictPostgresPath } from '../runtime/postgres/filesystem';
import {
  ensurePostgresBinaries,
  postgresRuntimeEnvironment,
  type BinDir,
} from '../runtime/postgres/binaries';
import {
  assertDatabaseName,
  clearRestoreSwapMarker,
  databaseNameFromConfig,
  poolConfigForDatabase,
  quoteDatabaseName,
  recoverInterruptedPostgresRestore,
  writeRestoreSwapMarker,
  type RestoreSwapMarker,
  type RestoreSwapState,
} from '../runtime/postgres/restore-swap';
import type {
  BackupAdapter,
  BackupArtifactFormat,
  BackupDumpOptions,
  BackupRestoreOptions,
} from './backup-types';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

interface CommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type PostgresBackupCommandRunner = (
  executable: string,
  args: string[],
  options: CommandOptions
) => Promise<CommandResult>;

export interface PostgresBackupAdapterOptions {
  connection: PoolConfig;
  markerPath: string;
  quiesce: () => Promise<void>;
  reconnect: () => Promise<void>;
  resume: () => void;
  /** Marks a restore that could not be rolled back as terminal for callers. */
  failSwap?: (error: unknown) => void;
  ensureBinaries?: () => Promise<BinDir>;
  runCommand?: PostgresBackupCommandRunner;
  log?: (line: string) => void;
  onSwapState?: (state: RestoreSwapState) => Promise<void> | void;
}

interface RestoreSanity {
  nodes: string;
  messages: string;
  embeddings: string;
  migrations: string;
  hnswEfSearch: string;
}

async function defaultRunCommand(
  executable: string,
  args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 10 * 60_000);
    timer.unref();
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function commandError(executable: string, args: string[], result: CommandResult): Error {
  const end = result.signal ? `signal ${result.signal}` : `exit ${String(result.exitCode)}`;
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return new Error(
    `${path.basename(executable)} ${args.join(' ')} failed (${end})${detail ? `:\n${detail}` : ''}`
  );
}

function passwordFromConfig(config: PoolConfig): string | undefined {
  if (typeof config.password === 'string') return config.password;
  if (!config.connectionString) return undefined;
  const parsed = new URL(config.connectionString);
  return parsed.password ? decodeURIComponent(parsed.password) : undefined;
}

function cliConnection(
  config: PoolConfig,
  database: string
): { args: string[]; password?: string } {
  assertDatabaseName(database);
  if (config.connectionString) {
    const parsed = new URL(config.connectionString);
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined;
    parsed.password = '';
    parsed.pathname = `/${encodeURIComponent(database)}`;
    return { args: [`--dbname=${parsed.toString()}`], password };
  }
  const args = [
    '--host',
    String(config.host ?? ''),
    '--username',
    String(config.user ?? ''),
    '--dbname',
    database,
  ];
  if (config.port) args.push('--port', String(config.port));
  return { args, password: passwordFromConfig(config) };
}

async function databaseExists(pool: Pool, database: string): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS present',
    [database]
  );
  return result.rows[0]?.present ?? false;
}

async function terminateDatabaseBackends(pool: Pool, database: string): Promise<void> {
  await pool.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [database]
  );
}

async function renameDatabase(pool: Pool, from: string, to: string): Promise<void> {
  await terminateDatabaseBackends(pool, from);
  await pool.query(`ALTER DATABASE ${quoteDatabaseName(from)} RENAME TO ${quoteDatabaseName(to)}`);
}

function uniqueDatabaseName(live: string, role: 'restore' | 'parked' | 'failed'): string {
  const suffix = `${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const room = 63 - role.length - suffix.length - 2;
  return assertDatabaseName(`${live.slice(0, Math.max(room, 1))}_${role}_${suffix}`);
}

export class PostgresBackupAdapter implements BackupAdapter {
  readonly engine = 'postgres' as const;

  private readonly connection: PoolConfig;
  private readonly markerPath: string;
  private readonly quiesceActive: () => Promise<void>;
  private readonly reconnectActive: () => Promise<void>;
  private readonly resumeActive: () => void;
  private readonly failSwapActive?: (error: unknown) => void;
  private readonly ensureBinariesImpl: () => Promise<BinDir>;
  private readonly runCommand: PostgresBackupCommandRunner;
  private readonly log: (line: string) => void;
  private readonly onSwapState?: (state: RestoreSwapState) => Promise<void> | void;

  constructor(options: PostgresBackupAdapterOptions) {
    this.connection = options.connection;
    this.markerPath = options.markerPath;
    this.quiesceActive = options.quiesce;
    this.reconnectActive = options.reconnect;
    this.resumeActive = options.resume;
    this.failSwapActive = options.failSwap;
    this.ensureBinariesImpl = options.ensureBinaries ?? (() => ensurePostgresBinaries());
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.log = options.log ?? (() => {});
    this.onSwapState = options.onSwapState;
  }

  private async commandEnvironment(
    binaries: BinDir,
    password?: string
  ): Promise<NodeJS.ProcessEnv> {
    return {
      ...postgresRuntimeEnvironment(binaries),
      ...(password ? { PGPASSWORD: password } : {}),
    };
  }

  private async runRequired(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    timeoutMs = 10 * 60_000
  ): Promise<void> {
    const result = await this.runCommand(executable, args, { env, timeoutMs });
    if (result.exitCode !== 0) throw commandError(executable, args, result);
  }

  async dump(options: BackupDumpOptions = {}): Promise<Buffer> {
    const format = options.format ?? 'custom';
    if (format === 'legacy-embedded') {
      throw new Error('PostgreSQL cannot create legacy embedded backup artifacts');
    }
    const database = databaseNameFromConfig(this.connection);
    const binaries = await this.ensureBinariesImpl();
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'snaglet-pg-dump-'));
    await restrictPostgresPath(temporary, true);
    const output = path.join(temporary, format === 'custom' ? 'snapshot.dump' : 'export.sql');
    const target = cliConnection(this.connection, database);
    const args = [
      ...target.args,
      `--format=${format === 'custom' ? 'custom' : 'plain'}`,
      '--no-owner',
      '--no-privileges',
      '--file',
      output,
    ];
    try {
      await this.runRequired(
        binaries.pgDump,
        args,
        await this.commandEnvironment(binaries, target.password)
      );
      const artifact = await readFile(output);
      if (artifact.byteLength === 0) throw new Error('pg_dump produced an empty artifact');
      return format === 'plain-gzip' ? Buffer.from(await gzipAsync(artifact)) : artifact;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async restoreIntoScratch(
    artifact: Buffer,
    format: BackupArtifactFormat,
    scratchDatabase: string,
    temporary: string
  ): Promise<void> {
    const binaries = await this.ensureBinariesImpl();
    const target = cliConnection(this.connection, scratchDatabase);
    const env = await this.commandEnvironment(binaries, target.password);
    if (format === 'custom') {
      const dumpPath = path.join(temporary, 'restore.dump');
      await writeFile(dumpPath, artifact, { mode: 0o600 });
      await this.runRequired(
        binaries.pgRestore,
        [
          ...target.args,
          '--exit-on-error',
          '--no-owner',
          '--no-privileges',
          '--single-transaction',
          dumpPath,
        ],
        env
      );
      return;
    }
    if (format === 'plain-gzip') {
      const sqlPath = path.join(temporary, 'restore.sql');
      await writeFile(sqlPath, Buffer.from(await gunzipAsync(artifact)), { mode: 0o600 });
      await this.runRequired(
        binaries.psql,
        [...target.args, '--set=ON_ERROR_STOP=1', '--single-transaction', '--file', sqlPath],
        env
      );
      return;
    }
    throw new Error('Legacy embedded backups cannot be restored by the PostgreSQL adapter');
  }

  private async sanity(database: string): Promise<RestoreSanity> {
    const pool = new Pool(poolConfigForDatabase(this.connection, database));
    try {
      const extensions = await pool.query<{ vector: boolean; trgm: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector,
           EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trgm`
      );
      if (!extensions.rows[0]?.vector || !extensions.rows[0]?.trgm) {
        throw new Error('Restored database is missing vector or pg_trgm extension');
      }
      const schema = await pool.query<{
        nodes: string | null;
        messages: string | null;
        embeddings: string | null;
        ledger: string | null;
      }>(`SELECT
        to_regclass('public.nodes')::text AS nodes,
        to_regclass('public.messages')::text AS messages,
        to_regclass('public.embeddings')::text AS embeddings,
        to_regclass('public._migrations')::text AS ledger`);
      if (
        !schema.rows[0]?.nodes ||
        !schema.rows[0]?.messages ||
        !schema.rows[0]?.embeddings ||
        !schema.rows[0]?.ledger
      ) {
        throw new Error('Restored database is missing required Snaglet schema tables');
      }
      const counts = await pool.query<RestoreSanity>(`SELECT
        (SELECT count(*)::int8 FROM public.nodes) AS nodes,
        (SELECT count(*)::int8 FROM public.messages) AS messages,
        (SELECT count(*)::int8 FROM public.embeddings) AS embeddings,
        (SELECT count(*)::int8 FROM public._migrations) AS migrations,
        current_setting('hnsw.ef_search') AS "hnswEfSearch"`);
      const result = counts.rows[0];
      if (!result || Number(result.migrations) <= 0)
        throw new Error('Restored database has no migration ledger entries');
      if (result.hnswEfSearch !== '100')
        throw new Error(
          `Restored database has hnsw.ef_search=${result.hnswEfSearch}, expected 100`
        );
      return result;
    } finally {
      await pool.end();
    }
  }

  private async updateMarker(
    marker: RestoreSwapMarker,
    state: RestoreSwapState
  ): Promise<RestoreSwapMarker> {
    const next = { ...marker, state };
    await writeRestoreSwapMarker(this.markerPath, next);
    await this.onSwapState?.(state);
    return next;
  }

  async restore(artifact: Buffer, options: BackupRestoreOptions = {}): Promise<void> {
    const format = options.format ?? 'custom';
    if (format === 'legacy-embedded') {
      throw new Error('Legacy embedded backups cannot be restored by the PostgreSQL adapter');
    }
    if (artifact.byteLength === 0) throw new Error('Cannot restore an empty backup artifact');

    await recoverInterruptedPostgresRestore({
      connection: this.connection,
      markerPath: this.markerPath,
      log: this.log,
    });

    const liveDatabase = databaseNameFromConfig(this.connection);
    const scratchDatabase = uniqueDatabaseName(liveDatabase, 'restore');
    const parkedDatabase = uniqueDatabaseName(liveDatabase, 'parked');
    let marker: RestoreSwapMarker = {
      schemaVersion: 1,
      state: 'preparing',
      liveDatabase,
      scratchDatabase,
      parkedDatabase,
      startedAt: new Date().toISOString(),
    };
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'snaglet-pg-restore-'));
    await restrictPostgresPath(temporary, true);
    const admin = new Pool(poolConfigForDatabase(this.connection, 'postgres'));
    let swapStarted = false;
    try {
      await writeRestoreSwapMarker(this.markerPath, marker);
      await admin.query(`CREATE DATABASE ${quoteDatabaseName(scratchDatabase)} TEMPLATE template0`);
      await this.restoreIntoScratch(artifact, format, scratchDatabase, temporary);
      // Database-level settings are not included unless pg_dump owns CREATE
      // DATABASE. Snaglet restores into an existing scratch DB, so reapply the
      // database-level hnsw.ef_search setting before any connection verifies it.
      await admin.query(
        `ALTER DATABASE ${quoteDatabaseName(scratchDatabase)} SET hnsw.ef_search = 100`
      );
      const expected = await this.sanity(scratchDatabase);

      swapStarted = true;
      await this.quiesceActive();
      await renameDatabase(admin, liveDatabase, parkedDatabase);
      marker = await this.updateMarker(marker, 'parked');
      await renameDatabase(admin, scratchDatabase, liveDatabase);
      marker = await this.updateMarker(marker, 'promoted');

      await this.reconnectActive();
      const actual = await this.sanity(liveDatabase);
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
          `Restored database count verification failed: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`
        );
      }
      await terminateDatabaseBackends(admin, parkedDatabase);
      await admin.query(`DROP DATABASE ${quoteDatabaseName(parkedDatabase)}`);
      await clearRestoreSwapMarker(this.markerPath);
      this.resumeActive();
      swapStarted = false;
      this.log(`restored ${liveDatabase} with verified counts ${JSON.stringify(actual)}`);
    } catch (error: unknown) {
      let recoveryError: unknown;
      try {
        if (swapStarted) await this.quiesceActive();
        const liveExists = await databaseExists(admin, liveDatabase);
        const parkedExists = await databaseExists(admin, parkedDatabase);
        const scratchExists = await databaseExists(admin, scratchDatabase);
        if (parkedExists) {
          if (liveExists) {
            await renameDatabase(admin, liveDatabase, uniqueDatabaseName(liveDatabase, 'failed'));
          }
          await renameDatabase(admin, parkedDatabase, liveDatabase);
        } else if (scratchExists) {
          await renameDatabase(admin, scratchDatabase, uniqueDatabaseName(liveDatabase, 'failed'));
        }
        if (swapStarted || parkedExists) {
          await this.reconnectActive();
          this.resumeActive();
          swapStarted = false;
        }
        await clearRestoreSwapMarker(this.markerPath);
      } catch (caught: unknown) {
        recoveryError = caught;
      }
      if (recoveryError) {
        const terminal = new Error(
          `PostgreSQL restore failed (${getErrorMessage(error)}) and automatic rollback also failed (${getErrorMessage(recoveryError)}). ` +
            `Recovery marker retained at ${this.markerPath}.`
        );
        if (swapStarted) this.failSwapActive?.(terminal);
        throw terminal;
      }
      throw error;
    } finally {
      await admin.end();
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
