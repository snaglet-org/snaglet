#!/usr/bin/env tsx

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresRuntime } from '@snaglet/db/runtime/postgres/runtime';
import { runScratchPreview, sanitizeScratchPreviewEnvironment } from './preview-scratch';
import { requestWindowsClose } from './lib/child-shutdown';

/**
 * `pnpm simulate:first-run` — first-install production simulation.
 *
 * Launches the packaged desktop artifact exactly as a brand-new user's first
 * run: a pristine throwaway Snaglet home, a sanitized environment, and everything
 * else left to the app itself — managed-PostgreSQL self-init (initdb), fresh-db
 * auto-migration, per-install credential key minting, first-run onboarding.
 *
 * Isolation knob: the packaged Rust shell resolves its home as `SNAGLET_HOME` env →
 * `~/.snaglet.json` pointer → profile default, and it does not read
 * `SNAGLET_HOME_POINTER_FILE`. So the one redirection this script sets is
 * `SNAGLET_HOME=<temp>/home` (which also makes the shell skip the real `~/.snaglet.json`
 * entirely); `SNAGLET_HOME_POINTER_FILE` is pointed at a temp file as
 * defense-in-depth for Node-side pointer reads. Every other variable a real
 * install would not have is removed. `~/.snaglet` and `~/.snaglet.json` are never
 * touched — their timestamps are verified before and after.
 *
 * Artifact: the desktop-preview package (Snaglet Preview.app). It is the closest
 * runnable stand-in for the production install — same shell, sidecar,
 * bundled Node + PostgreSQL, and first-run flow — while its distinct bundle
 * identifier keeps it from colliding with a genuinely installed Snaglet app.
 *
 * `--browser` falls back to the browser-preview build via the existing
 * preview:scratch isolation (clearly a near-equivalent, not the packaged app).
 */

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const RELEASE_DIR = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'target', 'release');
// The throwaway runtime lives outside the repository on purpose: the bundled
// server's env-file loader walks up from wherever the artifact runs, and a
// first-install user's app never sits above a checkout's .env. The artifact is
// copied here before launch — the moral equivalent of installing to
// /Applications.
const RUNTIME_PARENT = join(tmpdir(), 'snaglet-simulate-first-run');
const RUNTIME_PREFIX = 'snaglet-simulate-first-run-';
const READY_TIMEOUT_MS = 240_000;
const pnpm = 'pnpm';

interface ProdInstallOptions {
  reuseBuild: boolean;
  browser: boolean;
  exitAfterReady: boolean;
  keepRuntime: boolean;
  help: boolean;
}

interface ArtifactPaths {
  binary: string;
  resourcesDir: string;
  pgBinDir: string;
}

function usage(): string {
  return `Usage: pnpm simulate:first-run -- [options]

Launch the packaged desktop app against a pristine throwaway Snaglet home,
simulating a brand-new user's first install: managed PostgreSQL initdb,
fresh-database migration bootstrap, and first-run onboarding. Never touches
~/.snaglet or ~/.snaglet.json.

Options:
  --reuse-build       Reuse the existing desktop-preview artifact instead of rebuilding
  --browser           Use the browser-preview build via preview:scratch isolation
                      (clearly labeled near-equivalent, not the packaged app)
  --exit-after-ready  Stop immediately after the health check (automation)
  --keep-runtime      Preserve the throwaway home instead of deleting it on exit
  --help              Show this help`;
}

export function parseProdInstallArgs(args: ReadonlyArray<string>): ProdInstallOptions {
  const options: ProdInstallOptions = {
    reuseBuild: false,
    browser: false,
    exitAfterReady: false,
    keepRuntime: false,
    help: false,
  };
  for (const argument of args) {
    if (argument === '--') continue;
    else if (argument === '--reuse-build') options.reuseBuild = true;
    else if (argument === '--browser') options.browser = true;
    else if (argument === '--exit-after-ready') options.exitAfterReady = true;
    else if (argument === '--keep-runtime') options.keepRuntime = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown simulate-first-run option ${JSON.stringify(argument)}`);
  }
  return options;
}

/**
 * A first-install user's process environment carries none of a developer
 * checkout's knobs. Start from the scratch-preview sanitizer (database,
 * credential, port, and Snaglet storage vars) and additionally drop build/mode
 * selectors and repo-dev toggles, so the packaged server's own env-file loader
 * finds nothing to change modes with.
 */
export function prodInstallEnvironment(
  inherited: NodeJS.ProcessEnv,
  homeDir: string,
  pointerFile: string
): NodeJS.ProcessEnv {
  const environment = sanitizeScratchPreviewEnvironment(inherited);
  for (const key of Object.keys(environment)) {
    if (key.startsWith('VITE_')) delete environment[key];
  }
  for (const key of [
    'SNAGLET_ENV',
    'NODE_ENV',
    'SNAGLET_BUILD_PROFILE',
    'SNAGLET_DATABASE_NAME',
    'SNAGLET_PG_RUNTIME_DIR',
    'SNAGLET_LOCAL_INTELLIGENCE',
    'RUN_BACKGROUND_WORKERS',
    'COMPACT_CONVERSATIONS',
    'SNAGLET_SEED_TEST_CREDENTIALS',
    'LOG_LEVEL',
    'SNAGLET_LOG_FILE',
    'HOST',
  ]) {
    delete environment[key];
  }
  environment.SNAGLET_HOME = homeDir;
  environment.SNAGLET_HOME_POINTER_FILE = pointerFile;
  return environment;
}

function macAppPaths(appDir: string): ArtifactPaths {
  return {
    binary: join(appDir, 'Contents', 'MacOS', 'desktop'),
    resourcesDir: join(appDir, 'Contents', 'Resources'),
    pgBinDir: join(appDir, 'Contents', 'Resources', 'pg', 'bin'),
  };
}

function builtArtifactPaths(): ArtifactPaths {
  if (process.platform === 'darwin') {
    return macAppPaths(join(RELEASE_DIR, 'bundle', 'macos', 'Snaglet Preview.app'));
  }
  if (process.platform === 'linux') {
    return {
      binary: join(RELEASE_DIR, 'desktop'),
      resourcesDir: join(RELEASE_DIR, 'resources'),
      pgBinDir: join(RELEASE_DIR, 'resources', 'pg', 'bin'),
    };
  }
  if (process.platform === 'win32') {
    const app = join(REPO_ROOT, 'dist', 'desktop-preview', 'artifacts', 'app');
    return {
      binary: join(app, 'desktop.exe'),
      resourcesDir: app,
      pgBinDir: join(app, 'pg', 'bin'),
    };
  }
  throw new Error(`simulate:first-run packaged mode does not support ${process.platform}`);
}

/**
 * Copy the built artifact into the throwaway runtime and return the copy's
 * paths (darwin). On linux the artifact is launched in place — its layout is
 * not a self-contained bundle directory, and the env-file loader concern is
 * mitigated by the sanitized environment alone there.
 */
function stageArtifact(runtimeDir: string, built: ArtifactPaths): ArtifactPaths {
  if (process.platform === 'win32') {
    const app = join(runtimeDir, 'Snaglet Preview');
    cpSync(built.resourcesDir, app, { recursive: true });
    return {
      binary: join(app, 'desktop.exe'),
      resourcesDir: app,
      pgBinDir: join(app, 'pg', 'bin'),
    };
  }
  if (process.platform !== 'darwin') return built;
  const appCopy = join(runtimeDir, 'Snaglet Preview.app');
  const appSource = join(RELEASE_DIR, 'bundle', 'macos', 'Snaglet Preview.app');
  console.log(`[simulate-first-run] staging artifact copy outside the repo: ${appCopy}`);
  cpSync(appSource, appCopy, { recursive: true, verbatimSymlinks: true });
  return macAppPaths(appCopy);
}

function verifyArtifact(paths: ArtifactPaths): void {
  const serverBundle = join(paths.resourcesDir, 'server', 'server.mjs');
  const postgres = join(paths.pgBinDir, process.platform === 'win32' ? 'postgres.exe' : 'postgres');
  for (const required of [paths.binary, serverBundle, postgres]) {
    if (!existsSync(required)) {
      throw new Error(
        `Desktop-preview artifact is incomplete (missing ${required}). Run without --reuse-build.`
      );
    }
  }
}

function assertNoRunningInstance(): void {
  if (process.platform === 'win32') return;
  // Any desktop-preview instance (from any location) shares the bundle
  // identifier, so its single-instance guard would swallow this launch.
  const pattern =
    process.platform === 'darwin'
      ? 'Snaglet Preview.app/Contents/MacOS/desktop'
      : join(RELEASE_DIR, 'desktop');
  const result = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim().length > 0) {
    throw new Error(
      `A desktop-preview app instance is already running (pids ${result.stdout.trim().split('\n').join(', ')}). ` +
        'Its single-instance guard would swallow this launch; quit it first.'
    );
  }
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

function createRuntimeDir(): string {
  mkdirSync(RUNTIME_PARENT, { recursive: true, mode: 0o700 });
  const canonicalParent = realpathSync(RUNTIME_PARENT);
  const runtimeDir = realpathSync(mkdtempSync(join(canonicalParent, RUNTIME_PREFIX)));
  if (!isWithin(canonicalParent, runtimeDir) || !basename(runtimeDir).startsWith(RUNTIME_PREFIX)) {
    throw new Error(`Generated simulate-first-run runtime escaped ${canonicalParent}`);
  }
  return runtimeDir;
}

function removeRuntimeDir(runtimeDir: string): void {
  const canonicalParent = realpathSync(RUNTIME_PARENT);
  const canonicalRuntime = realpathSync(runtimeDir);
  if (
    !isWithin(canonicalParent, canonicalRuntime) ||
    !basename(canonicalRuntime).startsWith(RUNTIME_PREFIX)
  ) {
    throw new Error(`Refusing to remove unexpected simulate-first-run runtime ${canonicalRuntime}`);
  }
  rmSync(canonicalRuntime, { recursive: true, force: true });
}

function protectedPathStamps(): Map<string, number | null> {
  const stamps = new Map<string, number | null>();
  for (const target of [join(homedir(), '.snaglet'), join(homedir(), '.snaglet.json')]) {
    stamps.set(target, existsSync(target) ? statSync(target).mtimeMs : null);
  }
  return stamps;
}

function verifyProtectedPaths(before: Map<string, number | null>): void {
  for (const [target, stamp] of before) {
    const current = existsSync(target) ? statSync(target).mtimeMs : null;
    if (current !== stamp) {
      throw new Error(
        `SAFETY CHECK FAILED: ${target} changed during the simulate-first-run run (mtime ${String(stamp)} -> ${String(current)})`
      );
    }
    console.log(`[simulate-first-run] verified untouched: ${target}`);
  }
}

async function runBuild(): Promise<void> {
  const environment = { ...process.env };
  delete environment.SNAGLET_ENV;
  delete environment.NODE_ENV;
  const child = crossSpawn(pnpm, ['run', 'build:desktop-preview'], {
    cwd: REPO_ROOT,
    env: environment,
    stdio: 'inherit',
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code));
  });
  if (exitCode !== 0) {
    throw new Error(`Desktop-preview build exited with code ${String(exitCode)}`);
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

interface CliSession {
  serverUrl: string;
}

function readCliSession(homeDir: string): CliSession | null {
  const sessionPath = join(homeDir, 'runtime', 'desktop-cli-session.json');
  if (!existsSync(sessionPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionPath, 'utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { serverUrl?: unknown }).serverUrl === 'string'
    ) {
      return { serverUrl: (parsed as { serverUrl: string }).serverUrl };
    }
  } catch {
    // Partially-written session file — poll again.
  }
  return null;
}

async function waitForReady(child: ChildProcess, homeDir: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let serverUrl: string | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Packaged app exited before readiness (${child.signalCode ?? `code ${String(child.exitCode)}`})`
      );
    }
    serverUrl ??= readCliSession(homeDir)?.serverUrl ?? null;
    if (serverUrl) {
      try {
        const response = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) return serverUrl;
      } catch {
        // Expected while the sidecar and its managed PostgreSQL start.
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(
    `Packaged app did not become ready within ${String(READY_TIMEOUT_MS / 1000)} seconds`
  );
}

function verifyFirstInstallMarkers(homeDir: string): void {
  const markers = [
    join(homeDir, 'postgres', 'PG_VERSION'),
    join(homeDir, 'credential.key'),
    join(homeDir, 'logs', 'server.log'),
  ];
  for (const marker of markers) {
    if (!existsSync(marker)) {
      throw new Error(`Expected first-install marker missing: ${marker}`);
    }
    console.log(`[simulate-first-run] first-install marker present: ${marker}`);
  }
}

async function stopApp(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') requestWindowsClose(child);
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
    throw new Error('Packaged app shutdown could not be confirmed');
  }
}

async function stopOwnedPostgres(homeDir: string, pgBinDir: string): Promise<void> {
  const dataDir = join(homeDir, 'postgres');
  if (!existsSync(join(dataDir, 'PG_VERSION'))) return;
  const runtime = new PostgresRuntime({
    snagletHome: homeDir,
    dataDir,
    env: {
      ...process.env,
      SNAGLET_DB_MODE: 'managed',
      SNAGLET_HOME: homeDir,
      SNAGLET_PG_DATA_DIR: dataDir,
      SNAGLET_PG_BINDIR: pgBinDir,
      SNAGLET_PG_OWNED: '1',
    },
  });
  await runtime.stop('fast');
}

export async function runProdInstall(options: ProdInstallOptions): Promise<void> {
  if (options.help) {
    console.log(usage());
    return;
  }

  if (options.browser) {
    console.log(
      '[simulate-first-run] --browser: running the browser-preview NEAR-EQUIVALENT via preview:scratch isolation (not the packaged desktop app)'
    );
    await runScratchPreview({
      reuseBuild: options.reuseBuild,
      exitAfterReady: options.exitAfterReady,
      cleanupOnExit: !options.keepRuntime,
      help: false,
    });
    return;
  }

  const builtPaths = builtArtifactPaths();
  if (!options.reuseBuild) {
    console.log('[simulate-first-run] building the packaged desktop-preview artifact');
    await runBuild();
  }
  verifyArtifact(builtPaths);

  const protectedBefore = protectedPathStamps();
  const runtimeDir = createRuntimeDir();
  assertNoRunningInstance();
  const paths = stageArtifact(runtimeDir, builtPaths);
  verifyArtifact(paths);
  const homeDir = join(runtimeDir, 'home');
  const pointerFile = join(runtimeDir, 'home-pointer.json');
  writeFileSync(pointerFile, '{}\n', { encoding: 'utf8', mode: 0o600 });

  console.log(
    `[simulate-first-run] pristine Snaglet home: ${homeDir} (not yet created — the app creates it)`
  );
  const child = spawn(paths.binary, [], {
    cwd: runtimeDir,
    env: prodInstallEnvironment(process.env, homeDir, pointerFile),
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
    const serverUrl = await Promise.race([
      waitForReady(child, homeDir),
      stopRequested.then(() => null),
    ]);
    if (serverUrl) {
      console.log('');
      console.log('[simulate-first-run] first-install boot is READY');
      console.log(`[simulate-first-run] server: ${serverUrl}`);
      console.log(`[simulate-first-run] Snaglet home: ${homeDir}`);
      verifyFirstInstallMarkers(homeDir);
      console.log(
        options.exitAfterReady
          ? '[simulate-first-run] readiness verified; stopping'
          : '[simulate-first-run] explore the first-run experience, then press Ctrl-C'
      );
      if (!options.exitAfterReady) {
        const stopReason = await Promise.race([
          stopRequested.then(() => 'signal' as const),
          new Promise<'app-exit'>((resolveExit) =>
            child.once('exit', () => resolveExit('app-exit'))
          ),
        ]);
        if (stopReason === 'app-exit' && child.exitCode !== 0) {
          throw new Error(`Packaged app exited unexpectedly (code ${String(child.exitCode)})`);
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
    await stopApp(child);
    await stopOwnedPostgres(homeDir, paths.pgBinDir);
  } catch (error: unknown) {
    shutdownError = error;
  }

  verifyProtectedPaths(protectedBefore);

  if (!runError && !shutdownError && !options.keepRuntime) {
    removeRuntimeDir(runtimeDir);
    console.log('[simulate-first-run] throwaway home removed');
  } else {
    console.log(`[simulate-first-run] preserved runtime: ${runtimeDir}`);
  }

  if (runError && shutdownError) {
    throw new AggregateError(
      [runError, shutdownError],
      `simulate-first-run failed and shutdown was incomplete; runtime preserved at ${runtimeDir}`
    );
  }
  if (runError) throw runError;
  if (shutdownError) throw shutdownError;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === SCRIPT_PATH) {
  try {
    await runProdInstall(parseProdInstallArgs(process.argv.slice(2)));
  } catch (error: unknown) {
    console.error(`[simulate-first-run] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
