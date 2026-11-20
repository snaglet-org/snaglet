import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolConfig, type QueryResultRow } from 'pg';
import { ensurePostgresBinaries } from '@snaglet/db/runtime/postgres/binaries';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

interface ManagedProcess {
  child: ChildProcess;
  name: string;
  log: string;
  sensitiveOutputSeen: boolean;
  sensitiveScanTail: string;
}

export interface BuiltWorkspaceOptions {
  /** Enable the same per-launch API session gate used by the packaged desktop. */
  authToken?: string;
}

interface BrowserPreviewManifest {
  schemaVersion: 1;
  profile: string;
  files: Array<{ path: string; sha256: string; size: number }>;
}

function verifyReusableArtifact(): void {
  const appPath = resolve(REPO_ROOT, 'dist/browser-preview/app');
  const manifestPath = resolve(REPO_ROOT, 'dist/browser-preview/manifest.json');
  if (!existsSync(manifestPath) || !existsSync(join(appPath, 'server.mjs'))) {
    throw new Error('Reusable browser-preview artifact is missing. Build it before this test.');
  }
  let manifest: BrowserPreviewManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BrowserPreviewManifest;
  } catch {
    throw new Error(
      'Reusable browser-preview manifest is unreadable. Rebuild it before this test.'
    );
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.profile !== 'browser-preview' ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error('Reusable browser-preview manifest is invalid. Rebuild it before this test.');
  }
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      typeof entry.size !== 'number' ||
      isAbsolute(entry.path)
    ) {
      throw new Error('Reusable browser-preview manifest contains an invalid file entry.');
    }
    const absolutePath = resolve(appPath, entry.path);
    const relativePath = relative(appPath, absolutePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || !existsSync(absolutePath)) {
      throw new Error(`Reusable browser-preview file is missing: ${entry.path}`);
    }
    const stats = statSync(absolutePath);
    if (!stats.isFile() || stats.size !== entry.size) {
      throw new Error(`Reusable browser-preview file size changed: ${entry.path}`);
    }
    const sha256 = createHash('sha256').update(readFileSync(absolutePath)).digest('hex');
    if (sha256 !== entry.sha256) {
      throw new Error(`Reusable browser-preview file hash changed: ${entry.path}`);
    }
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function startProcess(
  name: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = REPO_ROOT,
  sensitiveValues: string[] = []
): ManagedProcess {
  const managed: ManagedProcess = {
    name,
    log: '',
    sensitiveOutputSeen: false,
    sensitiveScanTail: '',
    child: spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  };
  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();
    const scanText = managed.sensitiveScanTail + text;
    if (sensitiveValues.some((value) => value.length > 0 && scanText.includes(value))) {
      managed.sensitiveOutputSeen = true;
    }
    const longestSensitiveValue = Math.max(0, ...sensitiveValues.map((value) => value.length));
    managed.sensitiveScanTail =
      longestSensitiveValue > 1 ? scanText.slice(1 - longestSensitiveValue) : '';
    managed.log = (managed.log + text).slice(-64_000);
  };
  managed.child.stdout?.on('data', capture);
  managed.child.stderr?.on('data', capture);
  return managed;
}

async function waitForExit(processHandle: ManagedProcess, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  const exitCode = await Promise.race([
    new Promise<number | null>((resolveExit) =>
      processHandle.child.once('exit', (code) => resolveExit(code))
    ),
    new Promise<'timeout'>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout('timeout'), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  if (exitCode === 'timeout') {
    await stopProcess(processHandle);
    throw new Error(`${processHandle.name} did not exit within ${timeoutMs}ms`);
  }
  if (exitCode !== 0) {
    throw new Error(`${processHandle.name} exited with code ${exitCode}\n${processHandle.log}`);
  }
}

async function waitForUrl(
  url: string,
  processes: ManagedProcess[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const exited = processes.find((processHandle) => processHandle.child.exitCode !== null);
    if (exited) {
      throw new Error(
        `${exited.name} exited before ${url} became ready (code ${exited.child.exitCode})\n${exited.log}`
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Expected while the isolated process boots.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `Timed out waiting for ${url}\n${processes.map((item) => `[${item.name}]\n${item.log}`).join('\n')}`
  );
}

async function stopProcess(processHandle: ManagedProcess): Promise<'already-stopped' | 'graceful'> {
  const child = processHandle.child;
  if (child.exitCode !== null || child.pid === undefined) return 'already-stopped';
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  let stopTimeout: NodeJS.Timeout | undefined;
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveTimeout) => {
      // The server drains active runs and closes the database on shutdown;
      // give its owned PostgreSQL cluster time to stop cleanly before
      // escalation.
      stopTimeout = setTimeout(() => resolveTimeout(false), 45_000);
    }),
  ]).finally(() => {
    if (stopTimeout) clearTimeout(stopTimeout);
  });
  if (stopped) return 'graceful';
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await exited;
  throw new Error(`${processHandle.name} did not shut down gracefully within 45000ms`);
}

async function stopOwnedPostgres(homeDir: string): Promise<void> {
  const postgresDir = join(homeDir, 'runtime', 'postgres');
  const { binDir } = await ensurePostgresBinaries({ buildIfMissing: false });
  const { PostgresRuntime } = await import('@snaglet/db/runtime/postgres/runtime');
  const runtime = new PostgresRuntime({
    snagletHome: homeDir,
    dataDir: postgresDir,
    env: {
      ...process.env,
      SNAGLET_DB_MODE: 'managed',
      SNAGLET_PG_DATA_DIR: postgresDir,
      SNAGLET_PG_BINDIR: binDir,
      SNAGLET_PG_OWNED: '1',
      SNAGLET_HOME: homeDir,
    },
  });
  await runtime.stop('fast');
}

/**
 * Production-like browser E2E runtime: the finalized same-origin artifact on
 * an ephemeral port, backed by a fresh managed-PostgreSQL cluster and SNAGLET_HOME.
 */
export class BuiltWorkspace {
  readonly baseUrl: string;
  readonly apiUrl: string;
  readonly serverPort: number;
  readonly buildMs: number;
  readonly homePath: string;
  readonly runtimePath: string;
  private readonly homeDir: string;
  private readonly processes: ManagedProcess[];
  private disposed = false;
  private connection: Promise<PoolConfig> | null = null;

  private constructor(args: {
    serverPort: number;
    homeDir: string;
    processes: ManagedProcess[];
    buildMs: number;
  }) {
    this.serverPort = args.serverPort;
    this.baseUrl = `http://127.0.0.1:${args.serverPort}`;
    this.apiUrl = `${this.baseUrl}/api`;
    this.homeDir = args.homeDir;
    this.processes = args.processes;
    this.buildMs = args.buildMs;
    this.homePath = args.homeDir;
    this.runtimePath = dirname(args.homeDir);
  }

  static async boot(options: BuiltWorkspaceOptions = {}): Promise<BuiltWorkspace> {
    const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };
    delete inheritedEnv.SNAGLET_DATABASE_URL;
    delete inheritedEnv.DATABASE_URL;
    delete inheritedEnv.SNAGLET_DB_CONFIG_PATH;
    delete inheritedEnv.SNAGLET_AUTH_TOKEN;
    delete inheritedEnv.SNAGLET_PANEL_TOKEN;
    for (const credential of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'MISTRAL_API_KEY',
      'XAI_API_KEY',
      'COHERE_API_KEY',
    ]) {
      delete inheritedEnv[credential];
    }
    const buildEnv: NodeJS.ProcessEnv = { ...inheritedEnv };
    for (const key of Object.keys(buildEnv)) {
      if (key.startsWith('VITE_')) delete buildEnv[key];
    }
    delete buildEnv.SNAGLET_BUILD_PROFILE;
    delete buildEnv.NODE_ENV;
    Object.assign(buildEnv, {
      // A hostile developer environment must never compile the test artifact
      // against a live API. The finalized server serves UI + API same-origin.
      VITE_API_BASE_URL: '/api',
      VITE_APP_NAME: 'Snaglet',
    });
    const processes: ManagedProcess[] = [];
    const reuseBuild = process.env.SNAGLET_E2E_REUSE_BUILD === 'true';
    let buildMs = 0;
    console.log('[built-e2e] phase=build');
    if (reuseBuild) {
      verifyReusableArtifact();
      console.log('[built-e2e] artifact=reused');
    } else {
      const buildStartedAt = Date.now();
      const build = startProcess(
        'production build',
        pnpm,
        ['run', 'build:browser-preview'],
        buildEnv
      );
      await waitForExit(build, 240_000);
      buildMs = Date.now() - buildStartedAt;
    }

    // Allocate only after the slow build so another process has almost no
    // opportunity to claim the chosen port before the artifact binds it.
    const serverPort = await freePort();
    const runtimeParent = process.env.SNAGLET_BUILT_E2E_TMP_PARENT ?? tmpdir();
    const runtimeDir = mkdtempSync(join(runtimeParent, 'snaglet-built-e2e-'));
    const homeDir = join(runtimeDir, 'home');
    const postgresDir = join(homeDir, 'runtime', 'postgres');
    const { binDir: postgresBinDir } = await ensurePostgresBinaries({ buildIfMissing: false });
    const pointerFile = join(runtimeDir, 'home-pointer.json');
    // Prevent the pointer reader from falling back to other pointer files in
    // the real user home when the isolated pointer does not exist yet.
    writeFileSync(pointerFile, '{"recentPaths":[]}\n', 'utf8');
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    const env: NodeJS.ProcessEnv = {
      ...inheritedEnv,
      NODE_ENV: 'production',
      PORT: String(serverPort),
      API_BASE_URL: baseUrl,
      CLIENT_BASE_URL: baseUrl,
      CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      SNAGLET_BUILD_PROFILE: 'browser-preview',
      SNAGLET_DB_MODE: 'managed',
      SNAGLET_PG_DATA_DIR: postgresDir,
      SNAGLET_PG_BINDIR: postgresBinDir,
      SNAGLET_PG_OWNED: '1',
      SNAGLET_HOME: homeDir,
      SNAGLET_HOME_POINTER_FILE: pointerFile,
      SNAGLET_BACKUPS_DIR: join(runtimeDir, 'data', 'backups'),
      SNAGLET_LOG_DIR: join(runtimeDir, 'logs'),
      SNAGLET_ALLOWED_ORIGINS: baseUrl,
      SNAGLET_LOCAL_INTELLIGENCE: 'false',
      RUN_BACKGROUND_WORKERS: 'false',
      ...(options.authToken ? { SNAGLET_AUTH_TOKEN: options.authToken } : {}),
    };
    try {
      console.log('[built-e2e] phase=boot');
      const server = startProcess(
        'built Snaglet artifact',
        'node',
        ['server.mjs'],
        env,
        resolve(REPO_ROOT, 'dist/browser-preview/app'),
        options.authToken ? [options.authToken] : []
      );
      processes.push(server);
      await waitForUrl(`http://127.0.0.1:${serverPort}/health/ready`, processes, 60_000);
      await waitForUrl(baseUrl, processes, 30_000);
      console.log('[built-e2e] phase=test');
      return new BuiltWorkspace({
        serverPort,
        homeDir,
        processes,
        buildMs,
      });
    } catch (error) {
      await Promise.allSettled(processes.map((processHandle) => stopProcess(processHandle)));
      try {
        await stopOwnedPostgres(homeDir);
        rmSync(runtimeDir, { recursive: true, force: true });
      } catch (stopError) {
        console.warn(
          `[built-e2e] PostgreSQL shutdown failed; preserving ${runtimeDir}: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        );
      }
      throw error;
    }
  }

  get serverOutput(): string {
    return this.processes.map((processHandle) => processHandle.log).join('\n');
  }

  /**
   * Test-only SQL seam for arranging state that has no public API (finished
   * agent runs and their tool-call log, say). It reaches only this workspace's
   * throwaway cluster; each call opens and closes its own connection.
   */
  async query<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    if (this.disposed) throw new Error('BuiltWorkspace.query() called after dispose()');
    const pool = new Pool({ ...(await this.connectionConfig()), max: 1 });
    try {
      return (await pool.query<T>(sql, [...params])).rows;
    } finally {
      await pool.end();
    }
  }

  /**
   * The cluster's superuser connection config, resolved once: `connectionInfo()` runs
   * the cluster check under the runtime's lock. The port is always explicit
   * (from postmaster.pid for a socket connection), so pg never falls back to
   * the developer's PGPORT and looks for the wrong socket.
   */
  private connectionConfig(): Promise<PoolConfig> {
    this.connection ??= (async () => {
      const postgresDir = join(this.homeDir, 'runtime', 'postgres');
      const { binDir } = await ensurePostgresBinaries({ buildIfMissing: false });
      const { PostgresRuntime } = await import('@snaglet/db/runtime/postgres/runtime');
      const runtime = new PostgresRuntime({
        snagletHome: this.homeDir,
        dataDir: postgresDir,
        env: {
          ...process.env,
          SNAGLET_DB_MODE: 'managed',
          SNAGLET_PG_DATA_DIR: postgresDir,
          SNAGLET_PG_BINDIR: binDir,
          SNAGLET_PG_OWNED: '1',
          SNAGLET_HOME: this.homeDir,
        },
      });
      const info = await runtime.connectionInfo();
      const port =
        info.port ??
        Number(readFileSync(join(postgresDir, 'postmaster.pid'), 'utf8').split(/\r?\n/)[3]);
      if (!Number.isInteger(port) || port <= 0) {
        throw new Error(`Could not read the test cluster's port from ${postgresDir}`);
      }
      return {
        host: info.host,
        port,
        database: info.database,
        user: info.user,
        password: info.password,
      };
    })().catch((error: unknown) => {
      this.connection = null;
      throw error;
    });
    return this.connection;
  }

  get sensitiveServerOutputSeen(): boolean {
    return this.processes.some((processHandle) => processHandle.sensitiveOutputSeen);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    console.log('[built-e2e] phase=cleanup');
    const stopResults = await Promise.allSettled(
      this.processes.map((processHandle) => stopProcess(processHandle))
    );
    await stopOwnedPostgres(this.homeDir);
    rmSync(dirname(this.homeDir), { recursive: true, force: true });
    const failedStop = stopResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failedStop) throw failedStop.reason;
  }
}
