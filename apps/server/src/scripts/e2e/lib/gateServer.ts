/**
 * gateServer — boot a REAL Snaglet server for the release gate against a throwaway
 * database, isolated from the live dev workspace.
 *
 * This is the ScratchServer pattern (tests/e2e/helpers/scratchServer.ts) widened
 * to prove the managed PostgreSQL engine against a fresh temp Snaglet home and data
 * directory.
 *
 * Migrations auto-run on the fresh DB at boot (bootstrapIfFresh applies the full
 * chain), and all boot-time seeds/sync run exactly as in production.
 * We spawn `node apps/server/src/index.ts` with `--import=tsx` — identical to
 * how ScratchServer boots — so this is the real server, not a stub.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { ensurePostgresBinaries } from '@snaglet/db/runtime/postgres/binaries';
import { getErrorMessage } from '@snaglet/shared/utils';

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/server/src/scripts/e2e/lib → repo root
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');

export type Engine = 'managed';

// Sequential from 4002 (the dev server owns 4001): predictable, human-
// recognizable ports for the scratch Snaglet instead of ephemeral ones, scanning
// upward past anything already listening (parallel runs each get the next).
async function freePort(): Promise<number> {
  const tryPort = (port: number): Promise<boolean> =>
    new Promise((resolveTry) => {
      const srv = net.createServer();
      srv.once('error', () => resolveTry(false));
      srv.listen(port, () => srv.close(() => resolveTry(true)));
    });
  for (let port = 4002; port < 4102; port++) {
    if (await tryPort(port)) return port;
  }
  throw new Error('no free port in 4002-4101 for the scratch server');
}

async function waitForReady(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gate server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/health/ready`);
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`gate server not ready within ${timeoutMs}ms`);
}

export class GateServer {
  readonly baseUrl: string;
  readonly api: string;
  readonly engine: Engine;
  private child: ChildProcess | null = null;
  private readonly port: number;
  private readonly homeDir: string;
  private readonly postgresDir: string;
  private readonly postgresBinDir: string;
  private readonly credKey: string;
  private lastLog = '';

  private constructor(engine: Engine, port: number, homeDir: string, postgresBinDir: string) {
    this.engine = engine;
    this.port = port;
    this.homeDir = homeDir;
    this.postgresDir = join(homeDir, 'runtime', 'postgres');
    this.postgresBinDir = postgresBinDir;
    this.credKey = randomBytes(32).toString('hex');
    this.baseUrl = `http://localhost:${port}`;
    this.api = `${this.baseUrl}/api`;
  }

  static async boot(
    engine: Engine,
    opts: {
      timeoutMs?: number;
      captureLog?: boolean;
      webStaticDir?: string;
    } = {}
  ): Promise<GateServer> {
    const port = await freePort();
    const { binDir } = await ensurePostgresBinaries({ buildIfMissing: false });
    const homeDir = mkdtempSync(join(tmpdir(), `snaglet-e2e-${engine}-`));
    const server = new GateServer(engine, port, homeDir, binDir);
    server.webStaticDir = opts.webStaticDir;
    try {
      await server.start(opts.timeoutMs ?? 60_000, opts.captureLog ?? false);
    } catch (err) {
      await server.dispose();
      throw err;
    }
    return server;
  }

  /** When set, the scratch server serves the built UI from this dir. */
  webStaticDir?: string;

  private childEnv(): NodeJS.ProcessEnv {
    // Fresh env: keep PATH/runtime overrides, but strip every setting that
    // could redirect this child to an external/live database.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.SNAGLET_DB_CONFIG_PATH;
    delete env.SNAGLET_DATABASE_URL;
    delete env.DATABASE_URL;
    const base: NodeJS.ProcessEnv = {
      ...env,
      NODE_ENV: 'development', // not 'test', which zeroes serverConfig.port
      PORT: String(this.port),
      API_BASE_URL: this.baseUrl,
      CREDENTIAL_ENCRYPTION_KEY: this.credKey,
      SNAGLET_DB_MODE: 'managed',
      SNAGLET_PG_DATA_DIR: this.postgresDir,
      SNAGLET_PG_BINDIR: this.postgresBinDir,
      SNAGLET_PG_OWNED: '1',
      SNAGLET_HOME: this.homeDir,
      SNAGLET_ALLOWED_ORIGINS: this.baseUrl,
      RUN_BACKGROUND_WORKERS: 'false',
      ...(this.webStaticDir ? { SNAGLET_WEB_STATIC_DIR: this.webStaticDir } : {}),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=tsx`.trim(),
    };
    return base;
  }

  private async start(timeoutMs: number, captureLog: boolean): Promise<void> {
    this.child = spawn('node', ['apps/server/src/index.ts'], {
      cwd: REPO_ROOT,
      env: this.childEnv(),
      stdio: captureLog ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
    if (captureLog && this.child.stdout && this.child.stderr) {
      const cap = (buf: Buffer): void => {
        this.lastLog = (this.lastLog + buf.toString()).slice(-8000);
      };
      this.child.stdout.on('data', cap);
      this.child.stderr.on('data', cap);
    }
    await waitForReady(this.baseUrl, this.child, timeoutMs);
  }

  logTail(): string {
    return this.lastLog;
  }

  private async kill(): Promise<void> {
    const child = this.child;
    if (child && child.exitCode === null) {
      await new Promise<void>((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
        // Let the server close its pool and stop its owned PostgreSQL cluster
        // before escalating only this exact scratch child.
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 45_000).unref();
      });
    }
    this.child = null;

    // A SIGKILL escalation can bypass server shutdown. Verify and stop the
    // exact scratch cluster before any owned directory is removed.
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

  /** SIGTERM then re-boot on the same scratch home (proves tool re-sync after reset). */
  async restart(timeoutMs = 60_000): Promise<void> {
    await this.kill();
    await this.start(timeoutMs, false);
  }

  /** Kill only the Node server, leave its PostgreSQL child running, then prove adoption. */
  async crashAndRestart(timeoutMs = 60_000): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      throw new Error('gate server is not running');
    }
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('exit', () => resolveExit());
      child.kill('SIGKILL');
    });
    this.child = null;
    await this.start(timeoutMs, true);
  }

  async dispose(): Promise<void> {
    try {
      await this.kill();
    } catch (err) {
      console.warn(
        `[gate-server] PostgreSQL shutdown failed; preserving ${this.homeDir}: ${getErrorMessage(err)}`
      );
      return;
    }
    // The exact temp SNAGLET_HOME is removed only after its owned cluster is known
    // to be stopped.
    try {
      rmSync(this.homeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  // REST helpers over the { success, data, timestamp } envelope

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.api}${path}`);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}: ${JSON.stringify(body)}`);
    return (body as { data: T }).data;
  }

  async post<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${JSON.stringify(body)}`);
    return (body as { data: T }).data;
  }

  async patch<T>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(`${this.api}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`PATCH ${path} → HTTP ${res.status}: ${JSON.stringify(body)}`);
    return (body as { data: T }).data;
  }

  /** Raw fetch against the /api base (for endpoints that don't use the envelope). */
  fetchApi(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.api}${path}`, init);
  }

  /** Raw fetch against the server root (health, admin/db, non-/api routes). */
  fetchRoot(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, init);
  }
}
