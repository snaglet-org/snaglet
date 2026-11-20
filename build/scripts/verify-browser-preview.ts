import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { browserPreview } from '../profiles/browser-preview';
import crossSpawn from 'cross-spawn';
import { requestServerShutdown } from '../../scripts/lib/child-shutdown';
import { scratchTestCredentialEnvironment } from '../../scripts/preview-scratch';

interface Manifest {
  profile: string;
  productName: string;
  files: Array<{ path: string; sha256: string; size: number }>;
  totalBytes: number;
}

const output = path.resolve(browserPreview.outputDirectory);
const app = path.join(output, 'app');
const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8')) as Manifest;
const runtime = mkdtempSync(path.join(os.tmpdir(), 'snaglet-browser-preview-'));
const screenshot = path.resolve('test-results/browser-preview.png');
const port = browserPreview.serverPort;
const baseUrl = `http://127.0.0.1:${port}`;
const forbidden = /(^|\/)(\.env(?:\.|$)|plans?|test-results|coverage|\.git)(\/|$)/;
const snagletHome = path.join(runtime, 'home');
const postgresDataDir = path.join(snagletHome, 'postgres');
const shutdownToken = randomBytes(32).toString('hex');

function resolvePostgresRuntime(): string {
  const result = crossSpawn.sync(
    'pnpm',
    ['--silent', '--filter', '@snaglet/db', 'pg:runtime:path'],
    {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env: process.env,
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Could not resolve the development PostgreSQL runtime: ${result.stderr.trim() || `exit ${String(result.status)}`}`
    );
  }
  const root = result.stdout.trim().split('\n').at(-1)?.trim();
  if (!root) throw new Error('PostgreSQL runtime path helper returned no path');
  return path.resolve(root);
}

const postgresRoot = resolvePostgresRuntime();
const postgresBinDir = path.join(postgresRoot, 'bin');
const pgCtl = path.join(postgresBinDir, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl');
const postgresLibDir = path.join(postgresRoot, 'lib');

function verifyManifest(): void {
  if (
    manifest.profile !== browserPreview.name ||
    manifest.productName !== browserPreview.productName
  ) {
    throw new Error('Browser preview manifest identity does not match its build profile');
  }
  if (
    existsSync(path.join(app, 'pg')) ||
    manifest.files.some((file) => file.path === 'pg' || file.path.startsWith('pg/'))
  ) {
    throw new Error('Browser preview must not contain the desktop PostgreSQL runtime under app/pg');
  }
  for (const file of manifest.files) {
    if (forbidden.test(file.path)) throw new Error(`Forbidden artifact path: ${file.path}`);
    const absolute = path.join(app, file.path);
    const content = readFileSync(absolute);
    const hash = createHash('sha256').update(content).digest('hex');
    if (statSync(absolute).size !== file.size || hash !== file.sha256) {
      throw new Error(`Manifest mismatch: ${file.path}`);
    }
  }
  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (total !== manifest.totalBytes)
    throw new Error('Manifest totalBytes does not match file sizes');

  const webFiles = readdirSync(path.join(app, 'static/web/assets'));
  if (!webFiles.some((file) => /-[A-Za-z0-9_-]{8,}\.(?:js|css)$/.test(file))) {
    throw new Error('Browser preview does not contain hashed production assets');
  }
}

async function waitForHealth(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Browser preview exited before readiness (${child.signalCode ?? `code ${String(child.exitCode)}`})`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Browser preview did not become ready within 120 seconds');
}

function serverEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'SNAGLET_DB_CONFIG_PATH',
    'SNAGLET_DATABASE_URL',
    'DATABASE_URL',
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSERVICE',
    'PGSERVICEFILE',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    ...scratchTestCredentialEnvironment({}),
    DATABASE_URL: '',
    SNAGLET_DATABASE_URL: '',
    SNAGLET_DB_CONFIG_PATH: '',
    SNAGLET_DATABASE_NAME: 'snaglet',
    SNAGLET_ENV: 'prod',
    SNAGLET_BIND_HOST: '127.0.0.1',
    PORT: String(port),
    API_BASE_URL: baseUrl,
    CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    SNAGLET_BUILD_PROFILE: browserPreview.name,
    SNAGLET_DB_MODE: 'managed',
    SNAGLET_HOME: snagletHome,
    SNAGLET_HOME_POINTER_FILE: path.join(runtime, 'home-pointer.json'),
    SNAGLET_PG_DATA_DIR: postgresDataDir,
    SNAGLET_PG_BINDIR: postgresBinDir,
    SNAGLET_PG_OWNED: '1',
    SNAGLET_SHUTDOWN_TOKEN: shutdownToken,
    SNAGLET_BACKUPS_DIR: path.join(snagletHome, 'backups'),
    SNAGLET_LOG_DIR: path.join(runtime, 'logs'),
    SNAGLET_ALLOWED_ORIGINS: baseUrl,
    RUN_BACKGROUND_WORKERS: 'false',
    NODE_ENV: 'production',
  };
}

function postgresCommandEnvironment(): NodeJS.ProcessEnv {
  const prepend = (value: string, current: string | undefined): string =>
    current ? `${value}${path.delimiter}${current}` : value;
  return {
    ...process.env,
    PATH: prepend(postgresBinDir, process.env.PATH),
    DYLD_LIBRARY_PATH: prepend(postgresLibDir, process.env.DYLD_LIBRARY_PATH),
    LD_LIBRARY_PATH: prepend(postgresLibDir, process.env.LD_LIBRARY_PATH),
  };
}

function runPgCtl(args: string[]): SpawnSyncReturns<string> {
  const result = spawnSync(pgCtl, args, {
    encoding: 'utf8',
    env: postgresCommandEnvironment(),
  });
  if (result.error) throw result.error;
  return result;
}

function pgCtlFailure(result: SpawnSyncReturns<string>): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function shutdownServer(child: ChildProcess): Promise<void> {
  const exitedBeforeShutdown = child.exitCode !== null || child.signalCode !== null;
  let gracefulTimeout = false;
  let shutdownRequestError: unknown;
  if (!exitedBeforeShutdown) {
    try {
      if (process.platform === 'win32')
        await requestServerShutdown(baseUrl, shutdownToken, process.env.SNAGLET_AUTH_TOKEN);
      else child.kill('SIGTERM');
    } catch (error: unknown) {
      shutdownRequestError = error;
      child.kill('SIGKILL');
    }
    if (!(await waitForExit(child, 45_000))) {
      gracefulTimeout = true;
      child.kill('SIGKILL');
      if (!(await waitForExit(child, 5_000))) {
        throw new Error(
          `Browser preview server death is unconfirmed; preserving ${runtime} and PostgreSQL`
        );
      }
    }
  }

  let ownershipLeak = false;
  if (existsSync(path.join(postgresDataDir, 'PG_VERSION'))) {
    const status = runPgCtl(['status', '-D', postgresDataDir]);
    if (status.status === 0) {
      ownershipLeak = true;
      const cleanup = runPgCtl([
        'stop',
        '-D',
        postgresDataDir,
        '-m',
        'immediate',
        '-w',
        '-t',
        '30',
      ]);
      if (cleanup.status !== 0) {
        throw new Error(
          `Browser preview leaked its owned PostgreSQL cluster and exact cleanup failed; preserving ${runtime}: ${pgCtlFailure(cleanup)}`
        );
      }
    } else if (status.status !== 3) {
      throw new Error(
        `Could not prove the browser preview PostgreSQL cluster stopped; preserving ${runtime}: ${pgCtlFailure(status)}`
      );
    }
  }

  if (shutdownRequestError) {
    throw new Error('Browser preview graceful shutdown request failed', {
      cause: shutdownRequestError,
    });
  }
  if (gracefulTimeout) {
    throw new Error('Browser preview server did not exit within 45 seconds after shutdown request');
  }
  if (exitedBeforeShutdown) {
    throw new Error(
      `Browser preview server exited before teardown (${child.signalCode ?? `code ${String(child.exitCode)}`})`
    );
  }
  if (ownershipLeak) {
    throw new Error('Browser preview server exited without stopping its owned PostgreSQL cluster');
  }
}

verifyManifest();
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: app,
  stdio: 'inherit',
  env: serverEnvironment(),
});

let verificationError: unknown;
try {
  console.log(`[preview] starting ${browserPreview.productName} at ${baseUrl}`);
  await waitForHealth(child);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[preview] page error: ${message.text()}`);
    });
    page.on('pageerror', (error) => console.log(`[preview] page crash: ${error.message}`));
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    try {
      await page.getByTestId('build-profile-banner').waitFor();
    } catch (error: unknown) {
      // Keep what the page looked like: without it a missing banner is a guess.
      await page.screenshot({ path: screenshot, fullPage: true }).catch((shot: unknown) => {
        console.log(`[preview] could not save a screenshot: ${String(shot)}`);
      });
      throw error;
    }
    await page
      .getByRole('button', { name: /skip|continue|next|get started/i })
      .first()
      .click({ timeout: 10_000 })
      .catch((error: unknown) => {
        console.log(
          `[preview] optional onboarding action was unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    await page.screenshot({ path: screenshot, fullPage: true });
  } finally {
    await browser.close();
  }
  console.log(
    `[preview] verified health, hashed assets, browser rendering, manifest, and screenshot ${screenshot}`
  );
} catch (error: unknown) {
  verificationError = error;
}

let shutdownError: unknown;
try {
  await shutdownServer(child);
  rmSync(runtime, { force: true, recursive: true });
} catch (error: unknown) {
  shutdownError = error;
}

if (verificationError && shutdownError) {
  throw new AggregateError(
    [verificationError, shutdownError],
    'Browser preview verification and managed PostgreSQL teardown both failed'
  );
}
if (verificationError) throw verificationError;
if (shutdownError) throw shutdownError;
