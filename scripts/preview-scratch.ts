#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePostgresBinaries } from '@snaglet/db/runtime/postgres/binaries';
import { PostgresRuntime } from '@snaglet/db/runtime/postgres/runtime';
import { loadEnvFile } from '../packages/db/runtime/load-env';
import { requestServerShutdown } from './lib/child-shutdown';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const ARTIFACT_ROOT = join(REPO_ROOT, 'dist', 'browser-preview');
const APP_ROOT = join(ARTIFACT_ROOT, 'app');
const MANIFEST_PATH = join(ARTIFACT_ROOT, 'manifest.json');
const RUNTIME_PARENT = join(REPO_ROOT, 'tmp', 'search-preview');
const RUNTIME_PREFIX = 'snaglet-search-preview-';
const pnpm = 'pnpm';

const DATABASE_ENV_KEYS = [
  'SNAGLET_DB_MODE',
  'SNAGLET_DB_CONFIG_PATH',
  'SNAGLET_DATABASE_URL',
  'DATABASE_URL',
  'SNAGLET_PG_DATA_DIR',
  'SNAGLET_PG_BINDIR',
  'SNAGLET_PG_OWNED',
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSERVICE',
  'PGSERVICEFILE',
] as const;

export const TEST_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_REFRESH_TOKEN',
  'CODEX_ACCOUNT_ID',
  'TOGETHER_API_KEY',
  'MISTRAL_API_KEY',
  'COPILOT_SECRET',
  'COPILOT_TOKEN',
  'COPILOT_BASE_URL',
  'COPILOT_EXPIRES_AT',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
] as const;

// Everything scrubbed from the preview child's environment. A superset of the
// forwarded test credentials: the extra names are known AI-vendor env vars Snaglet
// ships no provider card for. They stay on this DENYLIST precisely because
// nothing consumes them — an ambient key must not leak into the isolated
// preview just because Snaglet has no provider for it.
const CREDENTIAL_ENV_KEYS = [
  ...TEST_CREDENTIAL_ENV_KEYS,
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'GITHUB_COPILOT_TOKEN',
  'COHERE_API_KEY',
] as const;

interface BrowserPreviewManifest {
  schemaVersion: 1;
  profile: 'browser-preview';
  files: Array<{ path: string; sha256: string; size: number }>;
}

export interface ScratchPreviewOptions {
  reuseBuild: boolean;
  port?: number;
  exitAfterReady: boolean;
  cleanupOnExit: boolean;
  help: boolean;
}

interface RuntimePaths {
  runtimeDir: string;
  homeDir: string;
  postgresDir: string;
  pointerFile: string;
  backupsDir: string;
  logsDir: string;
  metadataFile: string;
  credentialKeyFile: string;
}

function usage(): string {
  return `Usage: pnpm preview:scratch -- [options]

Start the production browser-preview artifact against a new isolated
Snaglet-managed PostgreSQL database. The runtime is preserved after Ctrl-C.

Options:
  --reuse-build         Reuse and verify dist/browser-preview instead of rebuilding
  --port <port>         Bind the same-origin built app to a specific safe port
  --exit-after-ready    Stop immediately after the health check (automation)
  --cleanup-on-exit     Delete the newly-created runtime after a successful stop
  --help                Show this help

Ports 3000-3007 and 4000-4007 are reserved for Snaglet dev instances and are rejected.`;
}

export function assertScratchPreviewPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new Error(`Scratch preview port must be an integer from 1024 to 65535; received ${port}`);
  }
  if ((port >= 3000 && port <= 3007) || (port >= 4000 && port <= 4007)) {
    throw new Error(`Scratch preview refuses reserved Snaglet dev port ${port}`);
  }
}

function readPort(raw: string | undefined): number {
  if (!raw) throw new Error('--port requires a value');
  const port = Number(raw);
  assertScratchPreviewPort(port);
  return port;
}

export function parseScratchPreviewArgs(args: ReadonlyArray<string>): ScratchPreviewOptions {
  const options: ScratchPreviewOptions = {
    reuseBuild: false,
    exitAfterReady: false,
    cleanupOnExit: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--reuse-build') options.reuseBuild = true;
    else if (argument === '--exit-after-ready') options.exitAfterReady = true;
    else if (argument === '--cleanup-on-exit') options.cleanupOnExit = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--port') {
      options.port = readPort(args[index + 1]);
      index += 1;
    } else if (argument?.startsWith('--port=')) {
      options.port = readPort(argument.slice('--port='.length));
    } else {
      throw new Error(`Unknown scratch-preview option ${JSON.stringify(argument)}`);
    }
  }

  return options;
}

export function sanitizeScratchPreviewEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...inherited };
  for (const key of DATABASE_ENV_KEYS) delete sanitized[key];
  for (const key of CREDENTIAL_ENV_KEYS) delete sanitized[key];
  delete sanitized.PORT;
  delete sanitized.CLIENT_PORT;
  delete sanitized.API_BASE_URL;
  delete sanitized.CLIENT_BASE_URL;
  delete sanitized.SNAGLET_HOME;
  delete sanitized.SNAGLET_HOME_POINTER_FILE;
  delete sanitized.SNAGLET_BACKUPS_DIR;
  delete sanitized.SNAGLET_LOG_DIR;
  delete sanitized.SNAGLET_ALLOWED_ORIGINS;
  delete sanitized.SNAGLET_API_RATE_LIMIT_MAX;
  delete sanitized.SNAGLET_API_RATE_LIMIT_PER_SECOND;
  delete sanitized.SNAGLET_API_RATE_LIMIT_BURST;
  delete sanitized.CREDENTIAL_ENCRYPTION_KEY;
  return sanitized;
}

/**
 * Pass only the explicitly supported test-credential inputs to the child.
 * Empty overrides for every other known ambient provider variable prevent the
 * bundled server from reloading an unsupported secret from the repository's
 * .env after the scratch sanitizer runs.
 */
export function scratchTestCredentialEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of CREDENTIAL_ENV_KEYS) selected[key] = '';
  for (const key of TEST_CREDENTIAL_ENV_KEYS) {
    const value = inherited[key]?.trim();
    if (value) selected[key] = value;
  }
  return selected;
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else {
          assertScratchPreviewPort(port);
          resolvePort(port);
        }
      });
    });
  });
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

function createRuntimePaths(): RuntimePaths {
  mkdirSync(RUNTIME_PARENT, { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync(RUNTIME_PARENT);
  const runtimeDir = realpathSync(mkdtempSync(join(canonicalParent, RUNTIME_PREFIX)));
  if (!isWithin(canonicalParent, runtimeDir) || !basename(runtimeDir).startsWith(RUNTIME_PREFIX)) {
    throw new Error(`Generated scratch-preview runtime escaped ${canonicalParent}`);
  }
  const homeDir = join(runtimeDir, 'home');
  const paths: RuntimePaths = {
    runtimeDir,
    homeDir,
    postgresDir: join(homeDir, 'runtime', 'postgres'),
    pointerFile: join(runtimeDir, 'home-pointer.json'),
    backupsDir: join(runtimeDir, 'backups'),
    logsDir: join(runtimeDir, 'logs'),
    metadataFile: join(runtimeDir, 'scratch-preview.json'),
    credentialKeyFile: join(runtimeDir, 'credential-encryption-key'),
  };
  writeFileSync(paths.pointerFile, '{"recentPaths":[]}\n', { encoding: 'utf8', mode: 0o600 });
  writeFileSync(paths.credentialKeyFile, `${randomBytes(32).toString('hex')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return paths;
}

function verifyReusableArtifact(): void {
  if (!existsSync(MANIFEST_PATH) || !existsSync(join(APP_ROOT, 'server.mjs'))) {
    throw new Error(
      'Reusable browser-preview artifact is missing. Run without --reuse-build once.'
    );
  }
  let manifest: BrowserPreviewManifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as BrowserPreviewManifest;
  } catch {
    throw new Error('Reusable browser-preview manifest is unreadable. Rebuild the artifact.');
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.profile !== 'browser-preview' ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error('Reusable browser-preview manifest is invalid. Rebuild the artifact.');
  }
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      typeof entry.size !== 'number' ||
      isAbsolute(entry.path)
    ) {
      throw new Error('Reusable browser-preview manifest contains an invalid entry.');
    }
    const absolutePath = resolve(APP_ROOT, entry.path);
    if (!isWithin(APP_ROOT, absolutePath) || !existsSync(absolutePath)) {
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

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once('exit', onExit);
  });
}

async function runBuild(buildEnvironment: NodeJS.ProcessEnv): Promise<void> {
  const child = crossSpawn(pnpm, ['run', 'build:browser-preview'], {
    cwd: REPO_ROOT,
    env: buildEnvironment,
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  });
  if (exitCode !== 0) {
    throw new Error(`Browser-preview build exited with code ${String(exitCode)}`);
  }
}

async function waitForReady(child: ChildProcess, baseUrl: string): Promise<void> {
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Scratch preview exited before readiness (${child.signalCode ?? `code ${String(child.exitCode)}`})`
      );
    }
    try {
      const response = await fetch(`${baseUrl}/health/ready`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Expected while the built server and its managed PostgreSQL start.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Scratch preview did not become ready at ${baseUrl} within 120 seconds`);
}

async function stopServer(
  child: ChildProcess,
  baseUrl: string,
  shutdownToken: string
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') await requestServerShutdown(baseUrl, shutdownToken);
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  if (await waitForExit(child, 45_000)) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  if (!(await waitForExit(child, 5_000))) {
    throw new Error('Scratch preview server death could not be confirmed');
  }
}

async function stopOwnedPostgres(paths: RuntimePaths, postgresBinDir: string): Promise<void> {
  if (!existsSync(join(paths.postgresDir, 'PG_VERSION'))) return;
  const runtime = new PostgresRuntime({
    snagletHome: paths.homeDir,
    dataDir: paths.postgresDir,
    env: {
      ...process.env,
      SNAGLET_DB_MODE: 'managed',
      SNAGLET_HOME: paths.homeDir,
      SNAGLET_PG_DATA_DIR: paths.postgresDir,
      SNAGLET_PG_BINDIR: postgresBinDir,
      SNAGLET_PG_OWNED: '1',
    },
  });
  await runtime.stop('fast');
}

function removeOwnedRuntime(paths: RuntimePaths): void {
  const canonicalParent = realpathSync(RUNTIME_PARENT);
  const runtimeDir = realpathSync(paths.runtimeDir);
  if (!isWithin(canonicalParent, runtimeDir) || !basename(runtimeDir).startsWith(RUNTIME_PREFIX)) {
    throw new Error(`Refusing to remove unexpected scratch-preview runtime ${runtimeDir}`);
  }
  rmSync(runtimeDir, { recursive: true, force: true });
}

function buildEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = sanitizeScratchPreviewEnvironment(inherited);
  for (const key of Object.keys(environment)) {
    if (key.startsWith('VITE_')) delete environment[key];
  }
  delete environment.SNAGLET_BUILD_PROFILE;
  delete environment.NODE_ENV;
  return {
    ...environment,
    VITE_API_BASE_URL: '/api',
    VITE_APP_NAME: 'Snaglet',
  };
}

export function scratchEmbeddingEnvironment(): Record<
  'SNAGLET_LOCAL_INTELLIGENCE' | 'RUN_BACKGROUND_WORKERS',
  string
> {
  return {
    SNAGLET_LOCAL_INTELLIGENCE: 'true',
    RUN_BACKGROUND_WORKERS: 'true',
  };
}

function serverEnvironment(
  inherited: NodeJS.ProcessEnv,
  paths: RuntimePaths,
  port: number,
  postgresBinDir: string
): NodeJS.ProcessEnv {
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    ...sanitizeScratchPreviewEnvironment(inherited),
    ...scratchTestCredentialEnvironment(inherited),
    NODE_ENV: 'production',
    PORT: String(port),
    API_BASE_URL: baseUrl,
    CLIENT_BASE_URL: baseUrl,
    CREDENTIAL_ENCRYPTION_KEY: readFileSync(paths.credentialKeyFile, 'utf8').trim(),
    SNAGLET_BUILD_PROFILE: 'browser-preview',
    SNAGLET_DB_MODE: 'managed',
    SNAGLET_PG_DATA_DIR: paths.postgresDir,
    SNAGLET_PG_BINDIR: postgresBinDir,
    SNAGLET_PG_OWNED: '1',
    SNAGLET_HOME: paths.homeDir,
    SNAGLET_HOME_POINTER_FILE: paths.pointerFile,
    SNAGLET_BACKUPS_DIR: paths.backupsDir,
    SNAGLET_LOG_DIR: paths.logsDir,
    SNAGLET_ALLOWED_ORIGINS: baseUrl,
    SNAGLET_SEED_TEST_CREDENTIALS: '1',
    ...scratchEmbeddingEnvironment(),
  };
}

export async function runScratchPreview(
  options: ScratchPreviewOptions,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.reuseBuild) verifyReusableArtifact();
  else {
    console.log('[scratch-preview] building production browser-preview artifact');
    await runBuild(buildEnvironment(inheritedEnvironment));
    verifyReusableArtifact();
  }

  const port = options.port ?? (await freePort());
  assertScratchPreviewPort(port);
  const postgresBinaries = await ensurePostgresBinaries({
    buildIfMissing: false,
  });
  const postgresBinDir = postgresBinaries.binDir;
  const paths = createRuntimePaths();
  const baseUrl = `http://127.0.0.1:${port}`;
  const shutdownToken = randomBytes(32).toString('hex');
  writeFileSync(
    paths.metadataFile,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        profile: 'browser-preview',
        baseUrl,
        port,
        homeDir: paths.homeDir,
        postgresDir: paths.postgresDir,
        backupsDir: paths.backupsDir,
        credentialKeyFile: paths.credentialKeyFile,
        localIntelligence: true,
        backgroundWorkers: true,
        localApiRateLimit: 'bypassed',
        remoteApiRateLimit: 'token-bucket-default',
        environmentTestCredentials: true,
      },
      null,
      2
    )}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: APP_ROOT,
    env: {
      ...serverEnvironment(inheritedEnvironment, paths, port, postgresBinDir),
      SNAGLET_SHUTDOWN_TOKEN: shutdownToken,
    },
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });

  let requestStop: (() => void) | undefined;
  const stopRequested = new Promise<void>((resolveStop) => {
    requestStop = resolveStop;
  });
  const onSignal = (): void => requestStop?.();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let runError: unknown;
  try {
    const readiness = await Promise.race([
      waitForReady(child, baseUrl).then(() => 'ready' as const),
      stopRequested.then(() => 'signal' as const),
    ]);
    if (readiness === 'ready') {
      console.log('');
      console.log('[scratch-preview] ready');
      console.log(`[scratch-preview] URL: ${baseUrl}`);
      console.log(`[scratch-preview] runtime: ${paths.runtimeDir}`);
      console.log(`[scratch-preview] SNAGLET_HOME: ${paths.homeDir}`);
      console.log(`[scratch-preview] PostgreSQL: ${paths.postgresDir}`);
      console.log('[scratch-preview] local intelligence and background embedding work are enabled');
      console.log('[scratch-preview] direct loopback API requests are not rate limited');
      console.log('[scratch-preview] recognized environment credentials are seeded as test rows');
      console.log(
        options.exitAfterReady
          ? '[scratch-preview] readiness verified; stopping'
          : '[scratch-preview] populate the workspace, let embeddings settle, then press Ctrl-C; data will be preserved'
      );

      if (!options.exitAfterReady) {
        const stopReason = await Promise.race([
          stopRequested.then(() => 'signal' as const),
          new Promise<'server-exit'>((resolveExit) =>
            child.once('exit', () => resolveExit('server-exit'))
          ),
        ]);
        if (stopReason === 'server-exit') {
          throw new Error(
            `Scratch preview exited unexpectedly (${child.signalCode ?? `code ${String(child.exitCode)}`})`
          );
        }
      }
    }
  } catch (error: unknown) {
    runError = error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  let shutdownError: unknown;
  try {
    await stopServer(child, baseUrl, shutdownToken);
    await stopOwnedPostgres(paths, postgresBinDir);
  } catch (error: unknown) {
    shutdownError = error;
  }

  if (!runError && !shutdownError && options.cleanupOnExit) {
    removeOwnedRuntime(paths);
    console.log('[scratch-preview] clean smoke runtime removed');
  } else {
    console.log(`[scratch-preview] preserved runtime: ${paths.runtimeDir}`);
  }

  if (runError && shutdownError) {
    throw new AggregateError(
      [runError, shutdownError],
      `Scratch preview failed and shutdown was incomplete; runtime preserved at ${paths.runtimeDir}`
    );
  }
  if (runError) throw runError;
  if (shutdownError) throw shutdownError;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === SCRIPT_PATH) {
  try {
    loadEnvFile();
    await runScratchPreview(parseScratchPreviewArgs(process.argv.slice(2)));
  } catch (error: unknown) {
    console.error(`[scratch-preview] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
