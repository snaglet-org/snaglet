import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Pool, type QueryResultRow } from 'pg';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getErrorMessage } from '@snaglet/shared/utils';
import { ensurePostgresBinaries } from '@snaglet/db/runtime/postgres/binaries';

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/e2e/helpers → repo root
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** Grab an ephemeral free TCP port. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForReady(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`scratch server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`scratch server not ready within ${timeoutMs}ms`);
}

/**
 * Boots a real Snaglet server against a throwaway managed-PostgreSQL cluster on a free
 * port, isolated from the live dev workspace via a scratch SNAGLET_HOME. Migrations
 * auto-run on the fresh DB at boot (bootstrapIfFresh applies the full chain), and
 * all boot-time seeds/sync run identically to production.
 *
 * This is what the fresh-bootstrap + reset-integrity specs assert against —
 * they cannot use the shared live DB because they need a guaranteed-fresh
 * bootstrap and they mutate global catalog state (reset).
 */
export class ScratchServer {
  readonly baseUrl: string;
  readonly api: string;
  private child: ChildProcess | null = null;
  private readonly port: number;
  private readonly homeDir: string;
  private readonly postgresDir: string;
  private readonly postgresBinDir: string;
  private readonly credKey: string;
  private logBuffer = '';
  private captureLog = false;
  private envOverrides: Record<string, string | undefined> = {};

  private constructor(port: number, homeDir: string, postgresBinDir: string) {
    this.port = port;
    this.homeDir = homeDir;
    this.postgresDir = join(homeDir, 'runtime', 'postgres');
    this.postgresBinDir = postgresBinDir;
    this.credKey = randomBytes(32).toString('hex');
    this.baseUrl = `http://localhost:${port}`;
    this.api = `${this.baseUrl}/api`;
  }

  static async boot(
    options:
      | number
      | {
          timeoutMs?: number;
          captureLog?: boolean;
          env?: Record<string, string | undefined>;
        } = {}
  ): Promise<ScratchServer> {
    const normalized = typeof options === 'number' ? { timeoutMs: options } : options;
    const port = await freePort();
    const { binDir } = await ensurePostgresBinaries({ buildIfMissing: false });
    const homeDir = mkdtempSync(join(tmpdir(), 'snaglet-e2e-home-'));
    const server = new ScratchServer(port, homeDir, binDir);
    server.captureLog = normalized.captureLog ?? false;
    server.envOverrides = normalized.env ?? {};
    try {
      await server.start(normalized.timeoutMs ?? 45_000);
    } catch (err) {
      // start() may have already spawned the tsx child before failing (e.g.
      // waitForReady timeout) — if boot() throws, nothing else holds a
      // reference to `server`, so without this the child + scratch home
      // would leak (afterAll never sees the handle to dispose()).
      const diagnostics = server.logTail();
      await server.dispose();
      throw new Error(`${getErrorMessage(err)}\n[scratch server log tail]\n${diagnostics}`, {
        cause: err,
      });
    }
    return server;
  }

  private childEnv(): NodeJS.ProcessEnv {
    // Fresh env: keep PATH etc., strip anything that could point at the live DB.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.SNAGLET_DB_CONFIG_PATH;
    delete env.SNAGLET_DATABASE_URL;
    delete env.DATABASE_URL;
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      NODE_ENV: 'development', // Not test — test zeroes serverConfig.port
      PORT: String(this.port),
      API_BASE_URL: this.baseUrl,
      CREDENTIAL_ENCRYPTION_KEY: this.credKey,
      SNAGLET_DB_MODE: 'managed',
      SNAGLET_PG_DATA_DIR: this.postgresDir,
      SNAGLET_PG_BINDIR: this.postgresBinDir,
      SNAGLET_PG_OWNED: '1',
      SNAGLET_HOME: this.homeDir,
      RUN_BACKGROUND_WORKERS: 'false',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=tsx`.trim(),
    };
    for (const [key, value] of Object.entries(this.envOverrides)) {
      if (value === undefined) delete childEnv[key];
      else childEnv[key] = value;
    }
    // DB isolation is not overrideable: a caller's test-specific env must never
    // redirect this child to an external/live database.
    delete childEnv.SNAGLET_DATABASE_URL;
    delete childEnv.DATABASE_URL;
    Object.assign(childEnv, {
      SNAGLET_DB_MODE: 'managed',
      SNAGLET_PG_DATA_DIR: this.postgresDir,
      SNAGLET_PG_BINDIR: this.postgresBinDir,
      SNAGLET_PG_OWNED: '1',
      SNAGLET_HOME: this.homeDir,
    });
    return childEnv;
  }

  private async start(timeoutMs: number): Promise<void> {
    this.child = spawn('node', ['apps/server/src/index.ts'], {
      cwd: REPO_ROOT,
      env: this.childEnv(),
      stdio: this.captureLog ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
    if (this.captureLog) {
      const capture = (chunk: Buffer): void => {
        // Fresh managed-PostgreSQL boot runs every migration and can emit more than
        // 16 KiB before readiness. Keep enough tail for assertions about
        // early boot policy without making those checks timing-dependent.
        this.logBuffer = (this.logBuffer + chunk.toString()).slice(-64_000);
      };
      this.child.stdout?.on('data', capture);
      this.child.stderr?.on('data', capture);
    }
    await waitForReady(this.baseUrl, this.child, timeoutMs);
  }

  logTail(): string {
    return this.logBuffer;
  }

  async waitForLog(pattern: RegExp, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      pattern.lastIndex = 0;
      if (pattern.test(this.logBuffer)) return;
      if (this.child?.exitCode !== null) {
        throw new Error(`scratch server exited before log matched ${pattern}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`scratch server log did not match ${pattern}\n${this.logBuffer}`);
  }

  /** Gracefully stop the child, then verify its exact owned cluster is stopped. */
  private async kill(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
        // Allow the server's shutdown drain and closeDatabase() to stop
        // PostgreSQL before escalating the exact scratch child.
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 45_000).unref();
      });
    }
    this.child = null;
    const { PostgresRuntime } = await import('@snaglet/db/runtime/postgres/runtime');
    const runtime = new PostgresRuntime({
      snagletHome: this.homeDir,
      dataDir: this.postgresDir,
      env: {
        ...process.env,
        SNAGLET_DB_MODE: 'managed',
        SNAGLET_PG_DATA_DIR: this.postgresDir,
        SNAGLET_PG_BINDIR: this.postgresBinDir,
        SNAGLET_PG_OWNED: '1',
        SNAGLET_HOME: this.homeDir,
      },
    });
    await runtime.stop('fast');
  }

  /** SIGTERM then re-boot on the same scratch home (used to prove tool
   *  re-sync repopulates the tools table after a reset). */
  async restart(timeoutMs = 45_000): Promise<void> {
    await this.kill();
    await this.start(timeoutMs);
  }

  /** Stop the server and its owned cluster, then delete the exact scratch home. */
  async dispose(): Promise<void> {
    try {
      await this.kill();
    } catch (err) {
      console.warn(
        `[scratch-server] PostgreSQL shutdown failed; preserving ${this.homeDir}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    try {
      rmSync(this.homeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  /** GET helper returning the parsed `data` field of the envelope. */
  async getData<T>(path: string): Promise<T> {
    const res = await fetch(`${this.api}${path}`);
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return (await res.json()).data as T;
  }

  /**
   * Test-only SQL seam for arranging state that intentionally has no public API
   * (for example, a fake integration credential). The connection is scoped to
   * this server's throwaway managed cluster and closed after every call.
   */
  async query<T extends QueryResultRow>(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    const { PostgresRuntime } = await import('@snaglet/db/runtime/postgres/runtime');
    const runtime = new PostgresRuntime({
      snagletHome: this.homeDir,
      dataDir: this.postgresDir,
      env: {
        ...process.env,
        SNAGLET_DB_MODE: 'managed',
        SNAGLET_PG_DATA_DIR: this.postgresDir,
        SNAGLET_PG_BINDIR: this.postgresBinDir,
        SNAGLET_PG_OWNED: '1',
        SNAGLET_HOME: this.homeDir,
      },
    });
    const connection = await runtime.connectionInfo();
    const pool = new Pool({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password,
      max: 1,
    });
    try {
      return (await pool.query<T>(sql, [...params])).rows;
    } finally {
      await pool.end();
    }
  }
}
