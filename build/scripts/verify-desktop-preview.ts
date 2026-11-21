import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { desktopPreview } from '../profiles/desktop-preview';
import { assertPackagedFsevents } from './native-helpers';
import { assertMachOSupportsMacOSVersion } from './macos-deployment-target';
import { verifyPackagedPostgres } from './postgres-artifact';

interface ArtifactManifest {
  applicationId: string;
  executable: string;
  executableSha256: string;
  files: Array<{ path: string }>;
  minimumMacOSVersion: string | null;
  productName: string;
  profile: string;
  schemaVersion: number;
  updatesEnabled: boolean;
}

const artifacts = path.resolve(desktopPreview.outputDirectory, 'artifacts');
const app = path.join(artifacts, 'Snaglet Preview.app');
const plist = path.join(app, 'Contents/Info.plist');
const manifest = JSON.parse(
  readFileSync(path.join(artifacts, 'artifact-manifest.json'), 'utf8')
) as ArtifactManifest;
const runtime = mkdtempSync(path.join(os.tmpdir(), 'snaglet-packaged-preview-'));
const productionHome = path.join(runtime, '.snaglet');
const previewHome = path.join(runtime, '.snaglet-preview');
const postgresRoot = path.join(app, 'Contents', 'Resources', 'pg');
const postgresData = path.join(previewHome, 'postgres');
const pgCtl = path.join(postgresRoot, 'bin', 'pg_ctl');
const sentinel = path.join(productionHome, 'must-not-touch');

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function plistValue(key: string): string {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Unable to read ${key} from packaged Info.plist`);
  return result.stdout.trim();
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<number> {
  const log = path.join(previewHome, 'logs/server.log');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged preview exited before readiness with code ${child.exitCode}`);
    }
    if (existsSync(log)) {
      const matches = [
        ...readFileSync(log, 'utf8').matchAll(/Server running on 127\.0\.0\.1:(\d+)/g),
      ];
      const port = Number(matches.at(-1)?.[1]);
      if (port) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
            signal: AbortSignal.timeout(1_000),
          });
          if (response.ok) return port;
        } catch {
          // A relaunch may leave an old readiness line in the append-only log.
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Packaged preview backend did not reach readiness within 120 seconds');
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

function sidecarNodePid(parentPid: number): number | undefined {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not inspect packaged preview child processes');
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (Number(match?.[2]) === parentPid && match?.[3].includes('/snaglet-node')) {
      return Number(match[1]);
    }
  }
  return undefined;
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function waitForPostgresStop(timeoutMs: number): Promise<void> {
  if (!existsSync(path.join(postgresData, 'PG_VERSION'))) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = spawnSync(pgCtl, ['status', '-D', postgresData], { stdio: 'ignore' });
    if (status.status === 3) return;
    if (status.status !== 0) {
      throw new Error(`Could not prove packaged preview PostgreSQL stopped; preserving ${runtime}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Packaged preview exceeded its PostgreSQL shutdown budget; preserving ${runtime}`
  );
}

async function stopPackagedApp(child: ChildProcess, force: boolean): Promise<void> {
  if (!child.pid) throw new Error('Packaged preview PID is unavailable');
  const nodePid = sidecarNodePid(child.pid);
  if (!nodePid) throw new Error('Could not identify the packaged preview Node sidecar');
  if (force) {
    child.kill('SIGKILL');
  } else {
    const quit = spawnSync(
      '/usr/bin/osascript',
      ['-e', `tell application ${JSON.stringify(app)} to quit`],
      { encoding: 'utf8' }
    );
    if (quit.status !== 0) {
      throw new Error(`Could not request normal preview quit: ${quit.stderr.trim()}`);
    }
  }
  if (!(await waitForExit(child, 90_000))) {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000);
    throw new Error('Packaged preview exceeded its shutdown budget');
  }
  if (!(await waitForPidExit(nodePid, 90_000))) {
    throw new Error(
      `Packaged preview Node sidecar ${nodePid} did not exit; preserving ${runtime} and PostgreSQL`
    );
  }
  await waitForPostgresStop(90_000);
}

function packagedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'DATABASE_URL',
    'SNAGLET_DATABASE_URL',
    'SNAGLET_DB_CONFIG_PATH',
    'SNAGLET_PG_BINDIR',
    'SNAGLET_PG_DATA_DIR',
    'SNAGLET_PG_OWNED',
    'PGDATABASE',
    'PGHOST',
    'PGPASSWORD',
    'PGPORT',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGUSER',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    HOME: runtime,
    SNAGLET_HOME: previewHome,
    RUN_BACKGROUND_WORKERS: 'false',
  };
}

function spawnPreview(): ChildProcess {
  return spawn(executable, [], {
    env: packagedEnvironment(),
    stdio: 'inherit',
  });
}

if (process.platform !== 'darwin') {
  throw new Error('Desktop preview verification currently supports macOS only');
}
if (manifest.schemaVersion !== 3 || manifest.profile !== desktopPreview.name) {
  throw new Error('Desktop preview artifact manifest identity is invalid');
}
if (manifest.minimumMacOSVersion !== desktopPreview.minimumMacOSVersion) {
  throw new Error('Desktop preview minimum macOS version is invalid');
}
if (
  manifest.productName !== desktopPreview.productName ||
  manifest.applicationId !== desktopPreview.applicationId
) {
  throw new Error('Desktop preview identity does not match its build profile');
}
if (manifest.updatesEnabled || desktopPreview.updateChannel !== 'disabled') {
  throw new Error('Production updates must be disabled in desktop preview');
}
const executable = path.join(artifacts, manifest.executable);
if (hash(executable) !== manifest.executableSha256) {
  throw new Error('Packaged preview executable hash does not match its manifest');
}
// tauri.preview.conf.json blanks the updater, so the preview shell must not
// embed the production key or endpoint it could install a release with.
const productionUpdater = (
  JSON.parse(readFileSync(path.resolve('apps/desktop/src-tauri/tauri.conf.json'), 'utf8')) as {
    plugins: { updater: { endpoints: string[]; pubkey: string } };
  }
).plugins.updater;
const previewShell = readFileSync(executable);
if (
  [productionUpdater.pubkey, ...productionUpdater.endpoints].some(
    (value) => value && previewShell.includes(value)
  )
) {
  throw new Error('Desktop preview shell embeds the production updater key or endpoint');
}
let machOFiles = 0;
for (const file of manifest.files) {
  if (
    desktopPreview.minimumMacOSVersion &&
    assertMachOSupportsMacOSVersion(
      path.join(artifacts, file.path),
      desktopPreview.minimumMacOSVersion
    )
  ) {
    machOFiles += 1;
  }
}
if (machOFiles === 0) throw new Error('Desktop preview contains no compatible Mach-O files');
if (
  plistValue('CFBundleDisplayName') !== desktopPreview.productName ||
  plistValue('CFBundleIdentifier') !== desktopPreview.applicationId ||
  plistValue('LSMinimumSystemVersion') !== desktopPreview.minimumMacOSVersion
) {
  throw new Error('Packaged preview Info.plist identity or compatibility is invalid');
}
assertPackagedFsevents(path.join(app, 'Contents', 'Resources', 'server'));
const postgres = verifyPackagedPostgres(postgresRoot);

mkdirSync(productionHome, { recursive: true });
writeFileSync(sentinel, 'production storage sentinel\n');
let child: ChildProcess | undefined = spawnPreview();

let verificationError: unknown;
try {
  const port = await waitForReady(child);
  if (!existsSync(path.join(postgresData, 'PG_VERSION'))) {
    throw new Error('Packaged preview did not initialize its isolated PostgreSQL data directory');
  }
  if (
    readFileSync(sentinel, 'utf8') !== 'production storage sentinel\n' ||
    statSync(productionHome).mtimeMs > statSync(sentinel).mtimeMs + 1_000
  ) {
    throw new Error(
      `Packaged preview touched production storage: ${readdirSync(productionHome, { recursive: true }).join(', ')}`
    );
  }
  const processCheck = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  if (
    processCheck.status !== 0 ||
    !processCheck.stdout.includes('Snaglet Preview.app/Contents/MacOS/desktop')
  ) {
    throw new Error('Packaged preview native process was not running');
  }
  const response = await fetch(`http://127.0.0.1:${port}`);
  const html = await response.text();
  if (
    !response.ok ||
    !html.includes('<div id="root"></div>') ||
    !html.match(/assets\/index-[^"']+\.js/)
  ) {
    throw new Error('Packaged preview UI entry point is missing its hashed application bundle');
  }
  const screenshot = path.join(desktopPreview.outputDirectory, 'desktop-preview.png');
  const shot = spawnSync('screencapture', ['-x', screenshot]);
  if (shot.status !== 0) throw new Error('Unable to capture packaged preview UI');
  if (statSync(screenshot).size < 10_000) {
    throw new Error('Packaged preview UI screenshot is unexpectedly small');
  }
  console.log(
    `[desktop-preview] verified PostgreSQL ${postgres.postgresVersion}, packaged backend, isolated storage, visible UI, and disabled updates: ${app}`
  );
  console.log(`[desktop-preview] screenshot ${screenshot}`);

  // The database runtime reports to the console, which the shell captures per boot in
  // sidecar.console.log. The first boot creates the cluster; a restart must reuse it.
  const initializedThisBoot = (): number => {
    const consoleLog = readFileSync(path.join(previewHome, 'logs/sidecar.console.log'), 'utf8');
    return (consoleLog.match(/\[DB\] initialized PostgreSQL 17 cluster/g) ?? []).length;
  };
  const expectInitialized = (boot: string, expected: number): void => {
    const initialized = initializedThisBoot();
    if (initialized !== expected) {
      const logs = readdirSync(path.join(previewHome, 'logs')).join(', ');
      throw new Error(
        `Packaged preview initialized its cluster ${initialized} times on ${boot}, expected ${expected} (logs: ${logs})`
      );
    }
  };
  expectInitialized('the first boot', 1);
  await stopPackagedApp(child, false);
  child = spawnPreview();
  await waitForReady(child);
  expectInitialized('a restart after a clean stop', 0);
  await stopPackagedApp(child, true);
  child = spawnPreview();
  await waitForReady(child);
  expectInitialized('a restart after a forced stop', 0);
  await stopPackagedApp(child, false);
  child = undefined;
  console.log(
    '[desktop-preview] clean boot, normal quit, existing-cluster relaunch, force-quit watchdog, and recovery relaunch passed'
  );
} catch (error: unknown) {
  verificationError = error;
}

let shutdownError: unknown;
try {
  if (child && child.exitCode === null && child.signalCode === null) {
    await stopPackagedApp(child, true);
  } else if (child && verificationError) {
    throw new Error(`Packaged preview sidecar death was not confirmed; preserving ${runtime}`);
  } else {
    await waitForPostgresStop(90_000);
  }
  rmSync(runtime, { force: true, maxRetries: 5, recursive: true, retryDelay: 250 });
} catch (error: unknown) {
  shutdownError = error;
}
if (verificationError && shutdownError) {
  throw new AggregateError(
    [verificationError, shutdownError],
    'Desktop preview verification and PostgreSQL teardown both failed'
  );
}
if (verificationError) throw verificationError;
if (shutdownError) throw shutdownError;
