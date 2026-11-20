import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import * as os from 'node:os';
import { createServer } from 'node:net';
import * as path from 'node:path';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { resolveConfiguredPath } from '@snaglet/shared/utils/paths';
import { migrationFiles } from '../../migration-files';
import { resolveDbHome } from '../snaglet-home';
import { ensurePostgresBinaries, postgresRuntimeEnvironment, type BinDir } from './binaries';
import { recoverInterruptedPostgresRestore } from './restore-swap';
import { restrictPostgresPath } from './filesystem';
import { withWindowsPostgresLease } from './lease';
import { PGVECTOR_VERSION, POSTGRES_MAJOR } from './version';
import {
  CUSTOM_TABLES_SCHEMA,
  ensureReaderLoginRole,
  quoteSqlIdentifier,
  readerHbaEntry,
  revokePublicDefaults,
  withConcurrentCatalogRetry,
  type ProvisioningQueryable,
} from './readerRole';
import { WORKSPACE_READER_HBA_ENTRY } from './workspaceReader';
import { WORKSPACE_WRITER_HBA_ENTRY } from './workspaceWriter';

const POSTGRES_PORT = 5432;
const LOCK_WAIT_MS = 2 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const SOCKET_FILE = `.s.PGSQL.${POSTGRES_PORT}`;
const MACOS_SOCKET_PATH_LIMIT = 104;
const META_FILE = 'snaglet-meta.json';
const SYNC_MARKERS = ['Mobile Documents', 'iCloud', 'Dropbox', 'Google Drive', 'OneDrive'];

/**
 * Server options given on every start (they override postgresql.conf), so
 * clusters initialized before an option was added get it too. The shared
 * lock table holds max_locks_per_transaction x (max_connections + background
 * processes) locks for all sessions; dropping a custom table takes about a
 * dozen, so the default 64 runs out at a few hundred tables in one
 * transaction. 256 costs a few MB of shared memory.
 */
const POSTGRES_START_OPTIONS = '-c max_locks_per_transaction=256';

export const DEFAULT_DATABASE_NAME = 'snaglet';
export const POSTGRES_ROLE = 'snaglet';

/**
 * The non-superuser LOGIN role that agent SQL (`table_read`'s SQL mode) runs
 * as. It is the session user of its own pool, so `SET ROLE`/`set_config('role')`
 * cannot climb back to `snaglet`: PostgreSQL checks role membership against the
 * session user, and this role is a member of nothing.
 */
export const TABLES_READER_ROLE = 'snaglet_tables_reader';

/** Loopback pg_hba entry the reader needs on the Windows TCP transport. */
export const TABLES_READER_HBA_ENTRY = readerHbaEntry(TABLES_READER_ROLE);

export interface TablesReaderProvisioningOptions {
  /** The LOGIN password; it travels as a bound parameter, never as SQL text. */
  password: string;
  /** Database to grant CONNECT and `user_tables` reads on. */
  database: string;
  /**
   * Managed clusters only: strip PUBLIC's default EXECUTE on `public`
   * functions and TEMP on the database, so a SECURITY DEFINER function or a
   * temp object can never widen the reader. Never run on an operator-owned
   * server, where other roles may rely on those defaults.
   */
  revokePublic: boolean;
}

/**
 * Create or refresh {@link TABLES_READER_ROLE} on the connected cluster and
 * grant it read access to `user_tables` in `database`. Idempotent and safe to
 * run concurrently from several Snaglet processes: a lost CREATE ROLE race is
 * absorbed, and every caller writes the same role-level defaults. The password
 * is set every time so the role always matches the credential file Snaglet holds.
 *
 * Runs as the connected user, which must be able to create roles (the
 * managed cluster's `snaglet` superuser). Nothing here touches user data.
 */
export async function provisionTablesReaderRole(
  db: ProvisioningQueryable,
  options: TablesReaderProvisioningOptions
): Promise<void> {
  if (!options.password) throw new Error('tables reader password must not be empty');
  const role = quoteSqlIdentifier(TABLES_READER_ROLE, 'role name');
  const schema = quoteSqlIdentifier(CUSTOM_TABLES_SCHEMA, 'schema name');
  await withConcurrentCatalogRetry(() =>
    db.transaction(async (tx) => {
      await ensureReaderLoginRole(tx, {
        role: TABLES_READER_ROLE,
        password: options.password,
        database: options.database,
        connectionLimit: 2,
        settings: [
          'default_transaction_read_only = on',
          "statement_timeout = '5s'",
          "lock_timeout = '1s'",
          "idle_in_transaction_session_timeout = '10s'",
          `search_path = ${CUSTOM_TABLES_SCHEMA}`,
        ],
      });
      await tx.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await tx.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      await tx.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${role}`
      );
      if (options.revokePublic) await revokePublicDefaults(tx, options.database);
    })
  );
}

/**
 * Resolve the managed-cluster database name.
 *
 * `SNAGLET_DATABASE_NAME` selects which database inside the one managed cluster this
 * checkout talks to, so two worktrees can share a cluster without sharing data.
 * The role stays `snaglet` — this knob names the database only.
 *
 * The value reaches `psql -c` and `createdb` as a bare SQL identifier, so it is
 * restricted to the unquoted-identifier grammar rather than escaped.
 */
export function resolveDatabaseName(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SNAGLET_DATABASE_NAME?.trim();
  if (!configured) return DEFAULT_DATABASE_NAME;
  if (configured.length > 63 || !/^[a-z_][a-z0-9_]*$/.test(configured)) {
    throw new Error(
      `[db] Invalid SNAGLET_DATABASE_NAME=${JSON.stringify(configured)}. ` +
        'Expected a lowercase PostgreSQL identifier matching /^[a-z_][a-z0-9_]*$/ of at most 63 characters.'
    );
  }
  return configured;
}

export interface PostgresConnectionInfo {
  socketDir: string;
  host: string;
  transport: 'socket' | 'tcp';
  port: number | undefined;
  database: string;
  user: string;
  password: string;
  /**
   * Password for {@link TABLES_READER_ROLE}, from `<SNAGLET_HOME>/pg-reader-password`.
   * Undefined when the credential file could not be created; the reader pool
   * is then unavailable and agent SQL is refused rather than run as `snaglet`.
   */
  readerPassword?: string;
  /**
   * Password for `snaglet_workspace_reader`, from
   * `<SNAGLET_HOME>/pg-workspace-reader-password`. Undefined when the credential
   * file could not be created; `database_query` is then refused.
   */
  workspaceReaderPassword?: string;
  /**
   * Password for `snaglet_workspace_writer`, from
   * `<SNAGLET_HOME>/pg-workspace-writer-password`. Undefined when the credential
   * file could not be created; `database_execute` and `create_view` are then
   * refused.
   */
  workspaceWriterPassword?: string;
}

export interface PostgresRuntimeStatus {
  host: string;
  transport: 'socket' | 'tcp';
  port?: number;
  state: 'uninitialized' | 'stopped' | 'stale' | 'running' | 'conflict';
  running: boolean;
  dataDir: string;
  socketDir: string;
  pid?: number;
  socketReady?: boolean;
  detail?: string;
}

export interface PostgresDataDirMeta {
  pgMajor: number;
  pgvectorVersion: string;
  /**
   * Which migration NUMBERING the count below belongs to (1 when the field is
   * absent). The epoch goes up whenever the migrations are collapsed into a new
   * `0001_init.sql` baseline, because the count then starts over at 1. Counts
   * are only comparable within the same epoch.
   */
  migrationEpoch?: number;
  migrationCount: number;
  lastOpenedAt: string;
}

/**
 * The migration-numbering epoch this build stamps and understands. Epoch 3
 * counts from the current `0001_init.sql` baseline.
 */
export const MIGRATION_EPOCH = 3;

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

export interface PostgresRuntimeOptions {
  platform?: NodeJS.Platform;
  snagletHome?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  ensureBinaries?: () => Promise<BinDir>;
  restrictPath?: typeof restrictPostgresPath;
  runCommand?: CommandRunner;
  isPidAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  recoverInterruptedRestore?: typeof recoverInterruptedPostgresRestore;
  /**
   * Runs after the postmaster is healthy and restore recovery is complete,
   * but before the runtime creates the normal `snaglet` database — a seam for
   * one-time provisioning steps that must fail closed (leave the database
   * absent) rather than let an empty Snaglet boot.
   */
  beforeEnsureDatabase?: (context: {
    clusterWasInitialized: boolean;
    connection: PostgresConnectionInfo;
  }) => Promise<void>;
}

interface PostmasterPid {
  pid: number;
  dataDir: string;
  port: number;
  startedAt: number;
  listenAddress: string;
  socketDir: string;
}

interface PostmasterInspection {
  pidFileExists: boolean;
  parsed?: PostmasterPid;
  alive: boolean;
  pgCtlRunning: boolean;
  dataDirMatches: boolean;
  socketDirMatches: boolean;
  socketReady: boolean;
  parseError?: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function defaultRunCommand(
  executable: string,
  args: string[],
  options: CommandOptions = {}
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
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
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 90_000);
    timer.unref();
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function shellFreeCommandError(executable: string, args: string[], result: CommandResult): Error {
  const output = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  const end = result.signal ? `signal ${result.signal}` : `exit ${String(result.exitCode)}`;
  return new Error(
    `${path.basename(executable)} ${args.join(' ')} failed (${end})${output ? `:\n${output}` : ''}`
  );
}

function quotePostgresConfig(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number(part));
  const rightParts = right.split('.').map((part) => Number(part));
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function bundledMigrationCount(): number {
  try {
    return migrationFiles().length;
  } catch {
    return 0;
  }
}

export async function guardPostgresDataDir(
  dataDir: string,
  warn: (line: string) => void = console.warn
): Promise<void> {
  let inspectedPath = path.resolve(dataDir);
  try {
    inspectedPath = await realpath(inspectedPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const marker = SYNC_MARKERS.find((candidate) => inspectedPath.includes(candidate));
  if (marker) {
    warn(
      `[DB] WARNING: PostgreSQL data dir ${inspectedPath} appears to be cloud-synced (${marker}). ` +
        'Sync engines can corrupt live database files; move SNAGLET_HOME or SNAGLET_PG_DATA_DIR.'
    );
  }

  const metaPath = path.join(dataDir, META_FILE);
  if (!(await pathExists(metaPath))) return;
  const raw = await readFile(metaPath, 'utf8');
  const parsed = safeJsonParse<Partial<PostgresDataDirMeta> | null>(raw, null);
  if (!parsed) {
    warn(`[DB] ${META_FILE} unreadable, will rewrite after a successful boot`);
    return;
  }
  if (typeof parsed.pgMajor === 'number' && parsed.pgMajor > POSTGRES_MAJOR) {
    throw new Error(
      `This PostgreSQL data directory was last opened by a NEWER Snaglet database runtime ` +
        `(PostgreSQL ${parsed.pgMajor}, this build supports ${POSTGRES_MAJOR}). Refusing downgrade.`
    );
  }
  if (
    typeof parsed.pgvectorVersion === 'string' &&
    compareDottedVersions(parsed.pgvectorVersion, PGVECTOR_VERSION) > 0
  ) {
    throw new Error(
      `This PostgreSQL data directory uses newer pgvector ${parsed.pgvectorVersion}; ` +
        `this build supports ${PGVECTOR_VERSION}. Refusing downgrade.`
    );
  }
  const stampedEpoch = typeof parsed.migrationEpoch === 'number' ? parsed.migrationEpoch : 1;
  if (stampedEpoch > MIGRATION_EPOCH) {
    throw new Error(
      `This PostgreSQL data directory was last opened by a NEWER Snaglet build ` +
        `(migration epoch ${stampedEpoch}, this build stamps epoch ${MIGRATION_EPOCH}). ` +
        'Refusing downgrade.'
    );
  }
  // A stamp from an OLDER epoch counted a different migration numbering, so
  // its count is not comparable and is not a downgrade signal; the migration
  // ledger check decides whether this build can open that database.
  const supportedMigrations = bundledMigrationCount();
  if (
    stampedEpoch === MIGRATION_EPOCH &&
    typeof parsed.migrationCount === 'number' &&
    parsed.migrationCount > supportedMigrations
  ) {
    throw new Error(
      `This PostgreSQL data directory was last opened with ${parsed.migrationCount} migrations; ` +
        `this build contains ${supportedMigrations}. Refusing downgrade.`
    );
  }
}

export async function stampPostgresDataDir(
  dataDir: string,
  migrationCount = bundledMigrationCount()
): Promise<void> {
  const meta: PostgresDataDirMeta = {
    pgMajor: POSTGRES_MAJOR,
    pgvectorVersion: PGVECTOR_VERSION,
    migrationEpoch: MIGRATION_EPOCH,
    migrationCount,
    lastOpenedAt: new Date().toISOString(),
  };
  const target = path.join(dataDir, META_FILE);
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await writeFile(temporary, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function parsePostmasterPid(contents: string, windows: boolean): PostmasterPid {
  const lines = contents.split(/\r?\n/);
  const pid = Number(lines[0]);
  const dataDir = lines[1]?.trim() ?? '';
  const port = Number(lines[3]);
  const startedAt = Number(lines[2]);
  const listenAddress = lines[5]?.trim() ?? '';
  const socketDir = lines[4]?.trim() ?? '';
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !dataDir ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (!windows && !socketDir)
  ) {
    throw new Error('postmaster.pid is incomplete or malformed');
  }
  return { pid, dataDir, port, socketDir, startedAt, listenAddress };
}

async function canonicalPath(target: string): Promise<string> {
  try {
    const resolved = await realpath(target);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    const resolved = path.resolve(target);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }
}

async function parkPath(target: string, label: string): Promise<string> {
  const parked = `${target}.${label}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  await rename(target, parked);
  return parked;
}

interface RuntimeLockRecord {
  pid: number;
  token: string;
  startedAt: string;
  lease?: 'windows-pipe-v1';
}

async function withRuntimeLock<T>(
  dataDir: string,
  isPidAlive: (pid: number) => boolean,
  operation: () => Promise<T>
): Promise<T> {
  if (process.platform === 'win32') {
    return withWindowsPostgresLease(dataDir, () =>
      withRuntimeFileLock(dataDir, isPidAlive, operation)
    );
  }
  return withRuntimeFileLock(dataDir, isPidAlive, operation);
}

async function withRuntimeFileLock<T>(
  dataDir: string,
  isPidAlive: (pid: number) => boolean,
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = `${dataDir}.snaglet-runtime-lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = randomBytes(12).toString('hex');
  let handle: Awaited<ReturnType<typeof open>> | null = null;

  while (!handle) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      const record: RuntimeLockRecord = {
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
        ...(process.platform === 'win32' ? { lease: 'windows-pipe-v1' as const } : {}),
      };
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
      } catch (error: unknown) {
        await handle.close();
        await unlink(lockPath);
        throw error;
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let reclaim = false;
      try {
        const current = safeJsonParse<Partial<RuntimeLockRecord>>(
          await readFile(lockPath, 'utf8'),
          {}
        );
        if (process.platform === 'win32' && current.lease === 'windows-pipe-v1') reclaim = true;
        else if (typeof current.pid === 'number') reclaim = !isPidAlive(current.pid);
        else
          reclaim =
            Date.now() - (await stat(lockPath)).mtimeMs >
            (process.platform === 'win32' ? 1_000 : LOCK_STALE_MS);
      } catch (readError: unknown) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        reclaim = false;
      }
      if (reclaim) {
        try {
          // The Windows OS lease excludes every other reclaimer. A dead owner
          // leaves only diagnostic metadata; no file-based recovery gate remains.
          await parkPath(lockPath, 'stale');
          continue;
        } catch (renameError: unknown) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw renameError;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for PostgreSQL runtime lock ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch((error: unknown) => {
      console.error(
        `Failed to close PostgreSQL runtime lock ${lockPath}: ${getErrorMessage(error)}`
      );
    });
    try {
      const current = safeJsonParse<Partial<RuntimeLockRecord>>(
        await readFile(lockPath, 'utf8'),
        {}
      );
      if (current.token === token) await unlink(lockPath);
    } catch {
      // A lost/reclaimed lock is never unlinked by a former owner.
    }
  }
}

export class PostgresRuntime {
  readonly snagletHome: string;
  readonly dataDir: string;
  readonly socketDir: string;
  readonly passwordPath: string;
  readonly readerPasswordPath: string;
  readonly workspaceReaderPasswordPath: string;
  readonly workspaceWriterPasswordPath: string;
  readonly restoreMarkerPath: string;
  readonly databaseName: string;
  readonly transport: 'socket' | 'tcp';
  private port = POSTGRES_PORT;

  private readonly env: NodeJS.ProcessEnv;
  private readonly ensureBinariesImpl: () => Promise<BinDir>;
  private readonly restrictPath: typeof restrictPostgresPath;
  private readonly runCommand: CommandRunner;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;
  private readonly recoverInterruptedRestore: typeof recoverInterruptedPostgresRestore;
  private readonly beforeEnsureDatabase?: PostgresRuntimeOptions['beforeEnsureDatabase'];
  private binaryCache: BinDir | null = null;

  constructor(options: PostgresRuntimeOptions = {}) {
    this.env = options.env ?? process.env;
    this.transport = (options.platform ?? process.platform) === 'win32' ? 'tcp' : 'socket';
    this.snagletHome = path.resolve(options.snagletHome ?? resolveDbHome());
    // SNAGLET_PG_DATA_DIR is expanded/validated like every path-like setting: `~`
    // expands against the user home, and a bare relative value throws instead
    // of resolving against the process cwd. Programmatic `options.dataDir`
    // stays as-is — callers (tests, scripts) pass absolute paths.
    const envDataDir = this.env.SNAGLET_PG_DATA_DIR?.trim();
    const explicitDataDir =
      options.dataDir ??
      (envDataDir ? resolveConfiguredPath(envDataDir, 'SNAGLET_PG_DATA_DIR') : undefined);
    this.dataDir = path.resolve(explicitDataDir || path.join(this.snagletHome, 'postgres'));
    this.databaseName = resolveDatabaseName(this.env);
    this.passwordPath = path.join(this.snagletHome, 'pg-password');
    this.readerPasswordPath = path.join(this.snagletHome, 'pg-reader-password');
    this.workspaceReaderPasswordPath = path.join(this.snagletHome, 'pg-workspace-reader-password');
    this.workspaceWriterPasswordPath = path.join(this.snagletHome, 'pg-workspace-writer-password');
    this.restoreMarkerPath = path.join(this.snagletHome, 'pg-restore-swap.json');
    const hash = createHash('sha256').update(this.dataDir).digest('hex').slice(0, 12);
    this.socketDir = path.join(os.tmpdir(), `snaglet-pg-${hash}`);
    const socketPathLength = Buffer.byteLength(path.join(this.socketDir, SOCKET_FILE));
    if (process.platform === 'darwin' && socketPathLength >= MACOS_SOCKET_PATH_LIMIT) {
      throw new Error(
        `PostgreSQL socket path is too long for macOS (${socketPathLength} bytes): ${this.socketDir}`
      );
    }
    this.restrictPath = options.restrictPath ?? restrictPostgresPath;
    this.ensureBinariesImpl = options.ensureBinaries ?? (() => ensurePostgresBinaries());
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.log = options.log ?? ((line: string) => console.log(`[DB] ${line}`));
    this.warn = options.warn ?? console.warn;
    this.recoverInterruptedRestore =
      options.recoverInterruptedRestore ?? recoverInterruptedPostgresRestore;
    this.beforeEnsureDatabase = options.beforeEnsureDatabase;
  }

  get host(): string {
    return this.transport === 'tcp' ? '127.0.0.1' : this.socketDir;
  }

  get owned(): boolean {
    return this.env.SNAGLET_PG_OWNED === '1';
  }

  private async binaries(): Promise<BinDir> {
    this.binaryCache ??= await this.ensureBinariesImpl();
    return this.binaryCache;
  }

  private async commandEnvironment(password?: string): Promise<NodeJS.ProcessEnv> {
    const binaries = await this.binaries();
    return {
      ...postgresRuntimeEnvironment(binaries, this.env),
      PGHOST: this.host,
      PGPORT: String(this.port),
      PGCONNECT_TIMEOUT: '5',
      PGSSLMODE: 'disable',
      PGUSER: POSTGRES_ROLE,
      ...(password ? { PGPASSWORD: password } : {}),
    };
  }

  private async loadConnection(): Promise<void> {
    if (this.transport !== 'tcp') return;
    const configPath = path.join(this.dataDir, 'snaglet-connection.conf');
    const contents = await readFile(configPath, 'utf8');
    const port = Number(/^port = ([0-9]+)\s*$/.exec(contents)?.[1]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid managed PostgreSQL connection file: ${configPath}`);
    }
    this.port = port;
  }

  private async configureConnection(directory: string, preferredPort = 0): Promise<void> {
    // The runtime lock serializes this cluster. An OS-assigned loopback port
    // avoids collisions between independent Snaglet homes and system PostgreSQL.
    // If another process wins the small bind gap, pg_ctl fails without adoption.
    const reserve = (port: number): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        const listener = createServer();
        listener.once('error', reject);
        listener.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
          const address = listener.address();
          if (!address || typeof address === 'string') {
            listener.close();
            reject(new Error('Unable to allocate PostgreSQL loopback port'));
            return;
          }
          listener.close((error) => (error ? reject(error) : resolve(address.port)));
        });
      });
    try {
      this.port = await reserve(preferredPort);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (preferredPort === 0 || (code !== 'EADDRINUSE' && code !== 'EACCES')) throw error;
      this.port = await reserve(0);
    }
    const target = path.join(directory, 'snaglet-connection.conf');
    const temporary = `${target}.tmp-${randomBytes(6).toString('hex')}`;
    await writeFile(temporary, `port = ${this.port}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  }

  private async authenticatedIdentityMatches(parsed: PostmasterPid): Promise<boolean> {
    const binaries = await this.binaries();
    const result = await this.runCommand(
      binaries.psql,
      [
        '-X',
        '-w',
        '-d',
        'postgres',
        '-Atqc',
        "SELECT json_build_object('dataDir', current_setting('data_directory'), 'startedAt', floor(extract(epoch FROM pg_postmaster_start_time())))",
      ],
      { env: await this.commandEnvironment(await this.ensurePassword(true)), timeoutMs: 10_000 }
    );
    if (result.exitCode !== 0) return false;
    const identity = safeJsonParse<{ dataDir?: string; startedAt?: number } | null>(
      result.stdout.trim(),
      null
    );
    // PostgreSQL records PID-file time before its SQL-visible startup timestamp.
    // Windows initialization can cross a clock-second boundary between them.
    return (
      typeof identity?.dataDir === 'string' &&
      typeof identity.startedAt === 'number' &&
      identity.startedAt >= parsed.startedAt &&
      identity.startedAt - parsed.startedAt <= 10 &&
      (await canonicalPath(identity.dataDir)) === (await canonicalPath(this.dataDir))
    );
  }

  private async runRequired(
    executable: string,
    args: string[],
    options: CommandOptions = {}
  ): Promise<CommandResult> {
    const result = await this.runCommand(executable, args, options);
    if (result.exitCode !== 0) throw shellFreeCommandError(executable, args, result);
    return result;
  }

  private async clusterInitialized(): Promise<boolean> {
    return pathExists(path.join(this.dataDir, 'PG_VERSION'));
  }

  private async validateClusterVersion(): Promise<void> {
    const version = (await readFile(path.join(this.dataDir, 'PG_VERSION'), 'utf8')).trim();
    if (version !== String(POSTGRES_MAJOR)) {
      throw new Error(
        `PostgreSQL data directory ${this.dataDir} is major ${version}; Snaglet requires ${POSTGRES_MAJOR}. ` +
          'A major upgrade requires pg_upgrade and is not automatic.'
      );
    }
  }

  private async readPrivateSecret(target: string): Promise<string> {
    const info = await lstat(target);
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(`PostgreSQL credentials must be a regular, unlinked file: ${target}`);
    }
    await this.restrictPath(target);
    return (await readFile(target, 'utf8')).trim();
  }

  private async readPrivatePassword(): Promise<string> {
    return this.readPrivateSecret(this.passwordPath);
  }

  /**
   * Generate a fresh secret into an exclusively created, private file. A
   * concurrent creator wins the `wx` race; its value is read back instead.
   */
  private async createPrivateSecret(target: string): Promise<string> {
    const secret = randomBytes(32).toString('base64url');
    try {
      const handle = await open(target, 'wx', 0o600);
      try {
        // A custom Snaglet home may inherit broad access. No credential bytes are
        // materialized until this exclusively created file has its private ACL.
        await this.restrictPath(target);
        await handle.writeFile(`${secret}\n`);
        await handle.sync();
        return secret;
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const concurrent = await this.readPrivateSecret(target);
      if (!concurrent) throw new Error(`PostgreSQL password file ${target} is empty`);
      return concurrent;
    }
  }

  private async ensurePassword(clusterExists: boolean): Promise<string> {
    await mkdir(this.snagletHome, { recursive: true });
    try {
      const password = await this.readPrivatePassword();
      if (!password) {
        if (clusterExists) {
          throw new Error(
            `Initialized PostgreSQL cluster ${this.dataDir} has an empty ${this.passwordPath}; ` +
              'refusing to rotate credentials automatically.'
          );
        }
        await parkPath(this.passwordPath, 'empty');
      } else {
        return password;
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (clusterExists) {
        throw new Error(
          `Initialized PostgreSQL cluster ${this.dataDir} is missing ${this.passwordPath}; ` +
            'refusing to generate a replacement that would strand the cluster.'
        );
      }
    }

    return this.createPrivateSecret(this.passwordPath);
  }

  /**
   * The {@link TABLES_READER_ROLE} password, from `<SNAGLET_HOME>/pg-reader-password`.
   *
   * Unlike the superuser password, a missing or empty file is regenerated
   * freely: the role is re-provisioned from this value on every boot, so a new
   * secret never strands anything. Only the filesystem is touched.
   */
  async ensureReaderPassword(): Promise<string> {
    return this.ensureRegenerableSecret(this.readerPasswordPath);
  }

  /**
   * The `snaglet_workspace_reader` password, from
   * `<SNAGLET_HOME>/pg-workspace-reader-password`; regenerated as freely as
   * {@link ensureReaderPassword}.
   */
  async ensureWorkspaceReaderPassword(): Promise<string> {
    return this.ensureRegenerableSecret(this.workspaceReaderPasswordPath);
  }

  /**
   * The `snaglet_workspace_writer` password, from
   * `<SNAGLET_HOME>/pg-workspace-writer-password`; regenerated as freely as
   * {@link ensureReaderPassword}.
   */
  async ensureWorkspaceWriterPassword(): Promise<string> {
    return this.ensureRegenerableSecret(this.workspaceWriterPasswordPath);
  }

  private async ensureRegenerableSecret(target: string): Promise<string> {
    await mkdir(this.snagletHome, { recursive: true });
    try {
      const password = await this.readPrivateSecret(target);
      if (password) return password;
      await parkPath(target, 'empty');
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return this.createPrivateSecret(target);
  }

  /**
   * Let {@link TABLES_READER_ROLE} authenticate over the Windows loopback
   * transport: the initdb-time `pg_hba.conf` names only `snaglet`, so the reader
   * entry is appended once and the running postmaster reloads it. Socket
   * transport already accepts every local role with a password.
   */
  async ensureTablesReaderHbaEntry(): Promise<void> {
    await this.ensureLoopbackHbaEntry(TABLES_READER_HBA_ENTRY);
  }

  /** {@link ensureTablesReaderHbaEntry} for `snaglet_workspace_reader`. */
  async ensureWorkspaceReaderHbaEntry(): Promise<void> {
    await this.ensureLoopbackHbaEntry(WORKSPACE_READER_HBA_ENTRY);
  }

  /** {@link ensureTablesReaderHbaEntry} for `snaglet_workspace_writer`. */
  async ensureWorkspaceWriterHbaEntry(): Promise<void> {
    await this.ensureLoopbackHbaEntry(WORKSPACE_WRITER_HBA_ENTRY);
  }

  private async ensureLoopbackHbaEntry(entry: string): Promise<void> {
    if (this.transport !== 'tcp') return;
    const hbaPath = path.join(this.dataDir, 'pg_hba.conf');
    const current = await readFile(hbaPath, 'utf8');
    if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
    await appendFile(hbaPath, `${current.endsWith('\n') ? '' : '\n'}${entry}\n`);
    const binaries = await this.binaries();
    await this.runRequired(binaries.pgCtl, ['reload', '-D', this.dataDir], {
      env: await this.commandEnvironment(),
      timeoutMs: 30_000,
    });
  }

  private configuration(): string {
    return [
      '',
      '# Managed by Snaglet. Runtime pin and compatibility live in snaglet-meta.json.',
      'shared_buffers = 128MB',
      'max_wal_size = 256MB',
      'min_wal_size = 80MB',
      'max_connections = 30',
      ...(this.transport === 'tcp'
        ? [
            "unix_socket_directories = ''",
            "listen_addresses = '127.0.0.1'",
            "include = 'snaglet-connection.conf'",
          ]
        : [
            `unix_socket_directories = ${quotePostgresConfig(this.socketDir)}`,
            "listen_addresses = ''",
          ]),
      'logging_collector = on',
      "log_directory = 'log'",
      "log_filename = 'postgresql-%Y-%m-%d_%H%M%S.log'",
      "password_encryption = 'scram-sha-256'",
      '',
    ].join('\n');
  }

  async ensureCluster(): Promise<void> {
    await this.binaries();
    await withRuntimeLock(this.dataDir, this.isPidAlive, async () => {
      const initialized = await this.clusterInitialized();
      if (initialized) {
        await this.validateClusterVersion();
        await this.loadConnection();
        await this.ensurePassword(true);
        await guardPostgresDataDir(this.dataDir, this.warn);
        return;
      }

      if (await pathExists(this.dataDir)) {
        const entries = await readdir(this.dataDir);
        if (entries.length > 0) {
          throw new Error(
            `Refusing to initialize PostgreSQL in non-empty directory ${this.dataDir}; ` +
              'it may contain legacy or user data.'
          );
        }
      }
      await guardPostgresDataDir(this.dataDir, this.warn);
      await this.ensurePassword(false);
      const parent = path.dirname(this.dataDir);
      await mkdir(parent, { recursive: true });
      const staging = await mkdtemp(path.join(parent, `.${path.basename(this.dataDir)}.init-`));
      const binaries = await this.binaries();
      try {
        await this.restrictPath(staging, true);
        const result = await this.runCommand(
          binaries.initdb,
          [
            '-D',
            staging,
            '--data-checksums',
            '--encoding=UTF8',
            '--locale=C',
            `--username=${POSTGRES_ROLE}`,
            '--auth=scram-sha-256',
            `--pwfile=${this.passwordPath}`,
          ],
          { env: await this.commandEnvironment(), timeoutMs: 120_000 }
        );
        if (result.exitCode !== 0)
          throw shellFreeCommandError(binaries.initdb, ['-D', staging], result);
        await mkdir(path.join(staging, 'log'), { recursive: true, mode: 0o700 });
        await appendFile(path.join(staging, 'postgresql.conf'), this.configuration(), 'utf8');
        if (this.transport === 'tcp') {
          await this.configureConnection(staging);
          await writeFile(
            path.join(staging, 'pg_hba.conf'),
            `host all ${POSTGRES_ROLE} 127.0.0.1/32 scram-sha-256\n`,
            'utf8'
          );
        }
        if (await pathExists(this.dataDir)) await rmdir(this.dataDir);
        await rename(staging, this.dataDir);
        await this.validateClusterVersion();
        this.log(`initialized PostgreSQL ${POSTGRES_MAJOR} cluster at ${this.dataDir}`);
      } catch (error: unknown) {
        await rm(staging, { recursive: true, force: true }).catch((cleanupError: unknown) =>
          this.warn(
            `Failed to remove PostgreSQL initialization staging directory ${staging}: ${getErrorMessage(cleanupError)}`
          )
        );
        throw new Error(
          `PostgreSQL initialization failed; no cluster was promoted at ${this.dataDir}: ${getErrorMessage(error)}`
        );
      }
    });
  }

  private async inspectPostmaster(): Promise<PostmasterInspection> {
    await this.loadConnection();
    const pidPath = path.join(this.dataDir, 'postmaster.pid');
    if (!(await pathExists(pidPath))) {
      return {
        pidFileExists: false,
        alive: false,
        pgCtlRunning: false,
        dataDirMatches: false,
        socketDirMatches: false,
        socketReady: false,
      };
    }

    let parsed: PostmasterPid;
    try {
      parsed = parsePostmasterPid(await readFile(pidPath, 'utf8'), this.transport === 'tcp');
    } catch (error: unknown) {
      return {
        pidFileExists: true,
        alive: false,
        pgCtlRunning: false,
        dataDirMatches: false,
        socketDirMatches: false,
        socketReady: false,
        parseError: getErrorMessage(error),
      };
    }

    const alive = this.isPidAlive(parsed.pid);
    const dataDirMatches =
      (await canonicalPath(parsed.dataDir)) === (await canonicalPath(this.dataDir));
    const socketDirMatches =
      this.transport === 'tcp'
        ? parsed.port === this.port && parsed.listenAddress === '127.0.0.1'
        : parsed.port === POSTGRES_PORT &&
          parsed.socketDir
            .split(',')
            .map((value) => value.trim())
            .includes(this.socketDir);
    const socketReady =
      this.transport === 'tcp'
        ? alive &&
          dataDirMatches &&
          socketDirMatches &&
          (await this.authenticatedIdentityMatches(parsed))
        : await pathExists(path.join(this.socketDir, SOCKET_FILE));
    let pgCtlRunning = false;
    if (alive) {
      const binaries = await this.binaries();
      const status = await this.runCommand(binaries.pgCtl, ['status', '-D', this.dataDir], {
        env: await this.commandEnvironment(),
        timeoutMs: 10_000,
      });
      pgCtlRunning = status.exitCode === 0;
    }
    return {
      pidFileExists: true,
      parsed,
      alive,
      pgCtlRunning,
      dataDirMatches,
      socketDirMatches,
      socketReady,
    };
  }

  /**
   * True when a live postmaster fails any of the three checks that gate
   * adoption, stopping, and the `conflict` status.
   */
  private hasConflict(inspection: PostmasterInspection): boolean {
    return (
      !inspection.dataDirMatches ||
      !inspection.socketDirMatches ||
      !inspection.pgCtlRunning ||
      (this.transport === 'tcp' && !inspection.socketReady)
    );
  }

  /**
   * Name the specific check(s) that make a live postmaster look like a conflict.
   *
   * `socketDirMatches` can fail for a healthy Snaglet-started cluster:
   * {@link socketDir} is recomputed from `os.tmpdir()` on construction, so a
   * launcher whose environment differs from the one that started the cluster
   * (an env without `TMPDIR`, `sudo`, cron, systemd `PrivateTmp=`) derives a
   * different path than `postmaster.pid` records. The message names both
   * paths and the `TMPDIR` they came from.
   */
  private conflictReasons(inspection: PostmasterInspection): string[] {
    const reasons: string[] = [];
    if (!inspection.dataDirMatches) {
      reasons.push(
        `data directory mismatch (pid file: ${inspection.parsed?.dataDir ?? 'unreadable'}; ` +
          `this process expects: ${this.dataDir})`
      );
    }
    if (!inspection.socketDirMatches) {
      reasons.push(
        `socket directory mismatch (pid file: ${inspection.parsed?.socketDir ?? 'unreadable'} ` +
          `port ${inspection.parsed?.port ?? '?'}; this process derives: ${this.socketDir} ` +
          `port ${POSTGRES_PORT} from TMPDIR=${os.tmpdir()}) — if the data directory matches, ` +
          'the cluster is healthy and this process simply has a different TMPDIR than the one ' +
          'that started it'
      );
    }
    if (!inspection.pgCtlRunning) {
      reasons.push(`pg_ctl status did not report a running server for ${this.dataDir}`);
    }
    if (this.transport === 'tcp' && !inspection.socketReady)
      reasons.push('authenticated PostgreSQL cluster identity could not be verified');
    return reasons;
  }

  async status(): Promise<PostgresRuntimeStatus> {
    if (!(await this.clusterInitialized())) {
      return {
        state: 'uninitialized',
        running: false,
        dataDir: this.dataDir,
        socketDir: this.socketDir,
        host: this.host,
        transport: this.transport,
        port: this.transport === 'tcp' ? this.port : undefined,
      };
    }
    const inspection = await this.inspectPostmaster();
    if (!inspection.pidFileExists) {
      return {
        state: 'stopped',
        running: false,
        dataDir: this.dataDir,
        socketDir: this.socketDir,
        host: this.host,
        transport: this.transport,
        port: this.transport === 'tcp' ? this.port : undefined,
      };
    }
    if (!inspection.parsed || !inspection.alive) {
      return {
        state: 'stale',
        running: false,
        dataDir: this.dataDir,
        socketDir: this.socketDir,
        host: this.host,
        transport: this.transport,
        port: this.transport === 'tcp' ? this.port : undefined,
        pid: inspection.parsed?.pid,
        detail: inspection.parseError ?? 'postmaster pid is not alive',
      };
    }
    if (this.hasConflict(inspection)) {
      return {
        state: 'conflict',
        running: false,
        dataDir: this.dataDir,
        socketDir: this.socketDir,
        host: this.host,
        transport: this.transport,
        port: this.transport === 'tcp' ? this.port : undefined,
        pid: inspection.parsed.pid,
        socketReady: inspection.socketReady,
        detail: `live postmaster does not match the expected data/socket configuration: ${this.conflictReasons(
          inspection
        ).join('; ')}`,
      };
    }
    return {
      state: 'running',
      running: true,
      dataDir: this.dataDir,
      socketDir: this.socketDir,
      host: this.host,
      transport: this.transport,
      port: this.transport === 'tcp' ? this.port : undefined,
      pid: inspection.parsed.pid,
      socketReady: inspection.socketReady,
      detail: inspection.socketReady ? undefined : 'socket file is missing',
    };
  }

  private async parkStalePidFile(): Promise<void> {
    const pidPath = path.join(this.dataDir, 'postmaster.pid');
    if (await pathExists(pidPath)) await parkPath(pidPath, 'stale');
  }

  private async stopUnlocked(mode: 'fast' | 'smart'): Promise<void> {
    const inspection = await this.inspectPostmaster();
    if (!inspection.pidFileExists) return;
    if (!inspection.parsed)
      throw new Error(
        `Refusing to change an unreadable PostgreSQL PID file at ${this.dataDir}: ${inspection.parseError}`
      );
    if (!inspection.alive) {
      await this.parkStalePidFile();
      return;
    }
    if (this.hasConflict(inspection)) {
      throw new Error(
        `Refusing to stop live PostgreSQL pid ${inspection.parsed.pid}: its data/socket ` +
          `configuration does not match ${this.dataDir} — ` +
          this.conflictReasons(inspection).join('; ')
      );
    }
    const binaries = await this.binaries();
    await this.runRequired(binaries.pgCtl, ['stop', '-D', this.dataDir, '-m', mode, '-w'], {
      env: await this.commandEnvironment(),
      timeoutMs: mode === 'smart' ? 120_000 : 60_000,
    });
  }

  private async adoptUnlocked(): Promise<boolean> {
    const inspection = await this.inspectPostmaster();
    if (!inspection.pidFileExists) return false;
    if (!inspection.parsed)
      throw new Error(
        `Refusing to change an unreadable PostgreSQL PID file at ${this.dataDir}: ${inspection.parseError}`
      );
    if (!inspection.alive) {
      await this.parkStalePidFile();
      return false;
    }
    if (this.hasConflict(inspection)) {
      throw new Error(
        `Live PostgreSQL pid ${inspection.parsed.pid} conflicts with Snaglet cluster ${this.dataDir}; ` +
          'refusing to unlink its pid file or start a second postmaster. Cause: ' +
          this.conflictReasons(inspection).join('; ')
      );
    }
    if (!inspection.socketReady) {
      this.warn(
        `[DB] PostgreSQL pid ${inspection.parsed.pid} lost its socket directory; restarting it safely.`
      );
      await this.stopUnlocked('fast');
      await mkdir(this.socketDir, { recursive: true, mode: 0o700 });
      await chmod(this.socketDir, 0o700);
      return false;
    }
    this.log(`adopted running PostgreSQL pid ${inspection.parsed.pid}`);
    return true;
  }

  async adoptIfRunning(): Promise<boolean> {
    await this.ensureCluster();
    return withRuntimeLock(this.dataDir, this.isPidAlive, () => this.adoptUnlocked());
  }

  private async ensureDatabase(password: string): Promise<void> {
    const binaries = await this.binaries();
    const env = await this.commandEnvironment(password);
    const existsArgs = [
      '-h',
      this.host,
      '-p',
      String(this.port),
      '-U',
      POSTGRES_ROLE,
      '-d',
      'postgres',
      '-Atqc',
      // `psql -c` performs no client-side variable interpolation, so `:'dbname'`
      // would reach the parser verbatim and error. The name is validated against
      // /^[a-z_][a-z0-9_]*$/ in resolveDatabaseName(), so a quoted literal is safe;
      // the escape is belt-and-braces against future validator changes.
      `SELECT 1 FROM pg_database WHERE datname = '${this.databaseName.replace(/'/g, "''")}'`,
    ];
    const inspect = await this.runRequired(binaries.psql, existsArgs, { env, timeoutMs: 30_000 });
    if (inspect.stdout.trim() === '1') return;
    const create = await this.runCommand(
      binaries.createdb,
      ['-h', this.host, '-p', String(this.port), '-U', POSTGRES_ROLE, this.databaseName],
      { env, timeoutMs: 30_000 }
    );
    if (create.exitCode !== 0) {
      const recheck = await this.runCommand(binaries.psql, existsArgs, {
        env,
        timeoutMs: 30_000,
      });
      if (recheck.exitCode !== 0 || recheck.stdout.trim() !== '1') {
        throw shellFreeCommandError(binaries.createdb, [this.databaseName], create);
      }
    }
  }

  private async lastLogLines(limit = 40): Promise<string> {
    const logDir = path.join(this.dataDir, 'log');
    try {
      const entries = await readdir(logDir);
      const candidates = await Promise.all(
        entries.map(async (name) => {
          const filePath = path.join(logDir, name);
          return { filePath, modified: (await stat(filePath)).mtimeMs };
        })
      );
      const latest = candidates.sort((left, right) => right.modified - left.modified)[0];
      if (!latest) return '';
      return (await readFile(latest.filePath, 'utf8')).split(/\r?\n/).slice(-limit).join('\n');
    } catch {
      return '';
    }
  }

  async start(): Promise<PostgresRuntimeStatus> {
    const clusterWasInitialized = await this.clusterInitialized();
    await this.ensureCluster();
    return withRuntimeLock(this.dataDir, this.isPidAlive, async () => {
      const password = await this.ensurePassword(true);
      const adopted = await this.adoptUnlocked();
      if (!adopted) {
        if (this.transport === 'tcp') await this.configureConnection(this.dataDir, this.port);
        else {
          await mkdir(this.socketDir, { recursive: true, mode: 0o700 });
          await chmod(this.socketDir, 0o700);
        }
        const binaries = await this.binaries();
        const startupLog = path.join(this.dataDir, 'log', 'snaglet-pgctl.log');
        const args = [
          'start',
          '-D',
          this.dataDir,
          '-l',
          startupLog,
          '-w',
          '-o',
          POSTGRES_START_OPTIONS,
        ];
        const result = await this.runCommand(binaries.pgCtl, args, {
          env: await this.commandEnvironment(password),
          timeoutMs: 90_000,
        });
        if (result.exitCode !== 0) {
          const tail = await this.lastLogLines(40);
          throw new Error(
            `${getErrorMessage(shellFreeCommandError(binaries.pgCtl, args, result))}` +
              (tail ? `\nLast PostgreSQL log lines:\n${tail}` : '')
          );
        }
        this.log(`started PostgreSQL cluster at ${this.dataDir}`);
      }
      await this.recoverInterruptedRestore({
        connection: {
          host: this.host,
          port: this.transport === 'tcp' ? this.port : undefined,
          database: this.databaseName,
          user: POSTGRES_ROLE,
          password,
        },
        markerPath: this.restoreMarkerPath,
        log: (line) => this.log(`restore recovery: ${line}`),
      });
      await this.beforeEnsureDatabase?.({
        clusterWasInitialized,
        connection: {
          socketDir: this.socketDir,
          host: this.host,
          transport: this.transport,
          port: this.transport === 'tcp' ? this.port : undefined,
          database: this.databaseName,
          user: POSTGRES_ROLE,
          password,
        },
      });
      await this.ensureDatabase(password);
      const current = await this.status();
      if (!current.running || !current.socketReady) {
        throw new Error(
          `PostgreSQL start did not reach a healthy connection: ${current.detail ?? current.state}`
        );
      }
      return current;
    });
  }

  async stop(mode: 'fast' | 'smart' = 'fast'): Promise<void> {
    if (!(await this.clusterInitialized())) return;
    await withRuntimeLock(this.dataDir, this.isPidAlive, () => this.stopUnlocked(mode));
  }

  async stopIfOwned(mode: 'fast' | 'smart' = 'fast'): Promise<void> {
    if (this.owned) await this.stop(mode);
  }

  async connectionInfo(): Promise<PostgresConnectionInfo> {
    await this.ensureCluster();
    // The readers are bounded extras; their credentials must never block the
    // superuser connection. Without one, that agent SQL is refused, not escalated.
    const readerPassword = await this.optionalReaderSecret('tables', this.readerPasswordPath);
    const workspaceReaderPassword = await this.optionalReaderSecret(
      'workspace',
      this.workspaceReaderPasswordPath
    );
    const workspaceWriterPassword = await this.optionalReaderSecret(
      'workspace-writer',
      this.workspaceWriterPasswordPath
    );
    return {
      socketDir: this.socketDir,
      host: this.host,
      transport: this.transport,
      port: this.transport === 'tcp' ? this.port : undefined,
      database: this.databaseName,
      user: POSTGRES_ROLE,
      password: await this.ensurePassword(true),
      ...(readerPassword !== undefined ? { readerPassword } : {}),
      ...(workspaceReaderPassword !== undefined ? { workspaceReaderPassword } : {}),
      ...(workspaceWriterPassword !== undefined ? { workspaceWriterPassword } : {}),
    };
  }

  private async optionalReaderSecret(
    reader: 'tables' | 'workspace' | 'workspace-writer',
    target: string
  ): Promise<string | undefined> {
    try {
      return await this.ensureRegenerableSecret(target);
    } catch (error: unknown) {
      this.warn(
        `[DB] ${reader} reader credential unavailable (${target}): ${getErrorMessage(error)}`
      );
      return undefined;
    }
  }
}
