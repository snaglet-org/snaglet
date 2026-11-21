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

import { EMBEDDER_MODEL_MANIFEST } from '../../apps/server/src/services/embedding/embedderModelManifest';
import { RERANKER_MODEL_MANIFEST } from '../../apps/server/src/services/reranking/rerankerModelManifest';
import { REMINDER_SOUNDS } from '../../packages/shared/types/reminders';
import { desktopProduction } from '../profiles/desktop-production';
import {
  assertNativeHelpers,
  assertPackagedFsevents,
  describeSdkSkippedHelpers,
} from './native-helpers';
import {
  checkAuthenticatedWorkspace,
  readCliSessionIfPresent,
  readProcessEnvironment,
  packagedLaunchEnvironment,
} from './packaged-app';
import { assertMachOSupportsMacOSVersion } from './macos-deployment-target';
import { verifyPackagedPostgres } from './postgres-artifact';

interface ArtifactManifest {
  applicationId: string;
  executable: string;
  executableSha256: string;
  executableSize: number;
  files: Array<{ path: string; sha256: string; size: number }>;
  minimumMacOSVersion: string | null;
  notarized: boolean;
  productName: string;
  profile: string;
  releaseEligible: boolean;
  schemaVersion: number;
  signed: boolean;
  signingRequired: boolean;
  sourceIdentifier: string;
  sourceMaps: string;
  toolVersions: { cargo: string; node: string; pnpm: string; rustc: string };
  totalBytes: number;
  updatesEnabled: boolean;
}

const output = path.resolve(desktopProduction.outputDirectory);
const artifacts = path.join(output, 'artifacts');
const app = path.join(artifacts, 'Snaglet.app');
const plist = path.join(app, 'Contents/Info.plist');
const manifest = JSON.parse(
  readFileSync(path.join(artifacts, 'artifact-manifest.json'), 'utf8')
) as ArtifactManifest;
const stagingManifest = JSON.parse(
  readFileSync(path.join(output, 'staging-manifest.json'), 'utf8')
) as { files: Array<{ path: string }> };
const runtime = mkdtempSync(path.join(os.tmpdir(), 'snaglet-production-candidate-'));
const productionHome = path.join(runtime, '.snaglet');
const postgresRoot = path.join(app, 'Contents', 'Resources', 'pg');
const postgresData = path.join(productionHome, 'postgres');
const pgCtl = path.join(postgresRoot, 'bin', 'pg_ctl');

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const forbiddenArtifact = /^(?:\.env(?:\..*)?|plans?|tests?|test-results|coverage)$/i;

// Scan the packaged artifacts for forbidden names at every depth. The original
// guard only looked at the top level of `artifacts`, so a forbidden file nested
// inside Snaglet.app/ slipped past. Recurse into real subdirectories only (never
// follow symlinks — matches the walkFiles semantics used elsewhere in staging),
// testing each entry basename exactly as the top-level check did.
function assertNoForbiddenArtifacts(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (forbiddenArtifact.test(entry.name))
      throw new Error(`Forbidden production artifact: ${path.relative(artifacts, absolute)}`);
    if (entry.isDirectory()) assertNoForbiddenArtifacts(absolute);
  }
}

function plistValue(key: string): string {
  const result = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`Unable to read ${key} from packaged Info.plist`);
  return result.stdout.trim();
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<number> {
  const log = path.join(productionHome, 'logs/server.log');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`Production candidate exited before readiness with code ${child.exitCode}`);
    if (existsSync(log)) {
      const match = readFileSync(log, 'utf8').match(/Server running on 127\.0\.0\.1:(\d+)/);
      if (match) return Number(match[1]);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Production candidate backend did not reach readiness within 120 seconds');
}

const homeModelDir = (dir: string): string =>
  path.join(productionHome, dir.replace(/^~\/\.snaglet\/?/, ''));

const automaticModelFiles = EMBEDDER_MODEL_MANIFEST.files.map((file) => ({
  bytes: file.bytes,
  path: path.join(homeModelDir(EMBEDDER_MODEL_MANIFEST.dir), file.localPath),
}));

/**
 * The reranker sits behind the `reranker` feature flag, which is off in a
 * fresh home, so first launch must not fetch its model.
 */
function assertRerankerNotDownloaded(): void {
  const dir = homeModelDir(RERANKER_MODEL_MANIFEST.dir);
  if (existsSync(dir))
    throw new Error(
      `Production candidate downloaded the reranker model with its feature flag off: ${path.relative(productionHome, dir)}`
    );
}

async function waitForAutomaticModels(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Production candidate exited during automatic model bootstrap with code ${child.exitCode}`
      );
    }
    if (
      automaticModelFiles.every(
        (file) => existsSync(file.path) && statSync(file.path).size === file.bytes
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const missing = automaticModelFiles
    .filter((file) => !existsSync(file.path) || statSync(file.path).size !== file.bytes)
    .map((file) => path.relative(productionHome, file.path));
  const logPath = path.join(productionHome, 'logs', 'server.log');
  const logTail = existsSync(logPath) ? readFileSync(logPath, 'utf8').slice(-8_000) : '(missing)';
  throw new Error(
    `Production automatic model bootstrap did not finish within 240 seconds. Missing: ${missing.join(', ')}\n--- server.log tail ---\n${logTail}`
  );
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
  if (result.status !== 0) throw new Error('Could not inspect production candidate children');
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

async function stopPackagedApp(child: ChildProcess): Promise<void> {
  if (!child.pid) throw new Error('Production candidate PID is unavailable');
  const nodePid = sidecarNodePid(child.pid);
  if (!nodePid) throw new Error('Could not identify the production candidate Node sidecar');
  // Production shares the real Snaglet bundle identifier. Never use LaunchServices
  // or AppleScript for teardown: an external live Snaglet instance could receive it.
  child.kill('SIGKILL');
  if (!(await waitForExit(child, 90_000))) {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000);
    throw new Error('Production candidate exceeded its shutdown budget');
  }
  if (!(await waitForPidExit(nodePid, 90_000))) {
    throw new Error(
      `Production Node sidecar ${nodePid} did not exit; preserving ${runtime} and PostgreSQL`
    );
  }
  if (!existsSync(path.join(postgresData, 'PG_VERSION'))) {
    return;
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const status = spawnSync(pgCtl, ['status', '-D', postgresData], { stdio: 'ignore' });
    if (status.status === 3) return;
    if (status.status !== 0) {
      throw new Error(`Could not prove production PostgreSQL stopped; preserving ${runtime}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Production PostgreSQL did not stop; preserving ${runtime}`);
}

function assertNoRunningProductionApp(): void {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not inspect running Snaglet applications');
  const matches = result.stdout
    .split('\n')
    .filter((line) => line.includes('/Snaglet.app/Contents/MacOS/desktop'));
  if (matches.length > 0) {
    throw new Error(
      `Refusing production verification while another Snaglet desktop app is running:\n${matches.join('\n')}`
    );
  }
}

function packagedEnvironment(): NodeJS.ProcessEnv {
  // Same allowlisted launch env as the packaged smoke (build/scripts/packaged-app.ts).
  return packagedLaunchEnvironment(runtime, productionHome);
}

if (process.platform !== 'darwin')
  throw new Error('Desktop production verification currently supports macOS only');
if (manifest.schemaVersion !== 3 || manifest.profile !== desktopProduction.name)
  throw new Error('Production manifest identity is invalid');
if (
  manifest.productName !== desktopProduction.productName ||
  manifest.applicationId !== desktopProduction.applicationId
)
  throw new Error('Production identity is invalid');
if (manifest.minimumMacOSVersion !== desktopProduction.minimumMacOSVersion)
  throw new Error('Production minimum macOS version is invalid');
if (
  !manifest.updatesEnabled ||
  desktopProduction.updateChannel !== 'stable' ||
  !manifest.signingRequired ||
  manifest.sourceMaps !== 'none'
)
  throw new Error('Production policy metadata is invalid');
if (manifest.releaseEligible || manifest.signed || manifest.notarized)
  throw new Error('Unsigned local candidate must not claim release eligibility');
if (
  !manifest.sourceIdentifier ||
  !manifest.toolVersions.rustc.includes('1.94.0') ||
  manifest.toolVersions.pnpm !== '10.12.1'
)
  throw new Error('Pinned tool provenance is invalid');
const executable = path.join(artifacts, manifest.executable);
if (
  hash(executable) !== manifest.executableSha256 ||
  statSync(executable).size !== manifest.executableSize
)
  throw new Error('Production executable does not match its manifest');
// The shell embeds its Tauri config as string literals. Without the updater
// key and endpoint, installs of this build could never take the next update.
const updaterConfig = (
  JSON.parse(readFileSync(path.resolve('apps/desktop/src-tauri/tauri.conf.json'), 'utf8')) as {
    plugins: { updater: { endpoints: string[]; pubkey: string } };
  }
).plugins.updater;
const releaseRepository = (
  JSON.parse(readFileSync(path.resolve('packages/shared/constants/release.json'), 'utf8')) as {
    repository: string;
  }
).repository;
const shellBytes = readFileSync(executable);
if (
  !updaterConfig.pubkey ||
  updaterConfig.endpoints.length !== 1 ||
  updaterConfig.endpoints[0] !==
    `https://github.com/${releaseRepository}/releases/latest/download/latest.json` ||
  !shellBytes.includes(updaterConfig.pubkey) ||
  !shellBytes.includes(updaterConfig.endpoints[0])
)
  throw new Error('Production shell does not carry the updater public key and release endpoint');
let totalBytes = 0;
let machOFiles = 0;
for (const file of manifest.files) {
  const absolute = path.join(artifacts, file.path);
  if (hash(absolute) !== file.sha256 || statSync(absolute).size !== file.size)
    throw new Error(`Production artifact does not match its manifest: ${file.path}`);
  if (
    desktopProduction.minimumMacOSVersion &&
    assertMachOSupportsMacOSVersion(absolute, desktopProduction.minimumMacOSVersion)
  ) {
    machOFiles += 1;
  }
  totalBytes += file.size;
}
if (totalBytes !== manifest.totalBytes || manifest.files.length === 0 || machOFiles === 0)
  throw new Error('Production artifact size or native compatibility report is invalid');
// SHA256SUMS lists every bundled file (sha256sum format, manifest order) so a
// download can be checked file by file; it must mirror the manifest exactly.
const sums = readFileSync(path.join(artifacts, 'SHA256SUMS'), 'utf8');
if (sums !== manifest.files.map((file) => `${file.sha256}  ${file.path}\n`).join(''))
  throw new Error('Production checksum file is invalid');
if (
  plistValue('CFBundleDisplayName') !== desktopProduction.productName ||
  plistValue('CFBundleIdentifier') !== desktopProduction.applicationId ||
  plistValue('LSMinimumSystemVersion') !== desktopProduction.minimumMacOSVersion
) {
  throw new Error('Production Info.plist identity or compatibility is invalid');
}
if (stagingManifest.files.some((file) => file.path.endsWith('.map')))
  throw new Error('Production staging contains source maps');
// Native helpers: the server bundle records what it built and staged in
// native/helpers.json (apps/server/scripts/bundle.mjs). The shipped set must be
// Known: every required helper bundled, and every recorded entry matching the
// files actually inside the .app — so a release cannot silently depend on what
// the build machine happened to have compiled earlier.
const helpersManifestPath = path.join(
  app,
  'Contents',
  'Resources',
  'server',
  'native',
  'helpers.json'
);
if (!existsSync(helpersManifestPath))
  throw new Error('Production native helper manifest is missing: server/native/helpers.json');
const helpersManifest = assertNativeHelpers(
  JSON.parse(readFileSync(helpersManifestPath, 'utf8')) as unknown,
  path.join(app, 'Contents', 'Resources', 'server')
);
for (const skipped of describeSdkSkippedHelpers(helpersManifest)) {
  console.log(`[desktop-production] ${skipped}`);
}
assertPackagedFsevents(path.join(app, 'Contents', 'Resources', 'server'));
// Native reminder notifications play `<sound>.wav` via UNNotificationSound
// soundNamed:, which searches the main bundle's Contents/Resources; each must be
// the same file the in-app banner plays (bundle.macOS.files in tauri.conf.json).
for (const sound of REMINDER_SOUNDS.filter((id) => id !== 'none')) {
  const packaged = path.join(app, 'Contents', 'Resources', `${sound}.wav`);
  const source = path.resolve('apps/desktop-ui/public/sounds/reminders', `${sound}.wav`);
  if (!existsSync(packaged) || hash(packaged) !== hash(source))
    throw new Error(
      `Production reminder sound is missing or stale: Contents/Resources/${sound}.wav`
    );
}
assertNoForbiddenArtifacts(artifacts);
const postgres = verifyPackagedPostgres(postgresRoot);

assertNoRunningProductionApp();
const child = spawn(executable, [], { env: packagedEnvironment(), stdio: 'inherit' });
let verificationError: unknown;
try {
  const port = await waitForReady(child);
  await waitForAutomaticModels(child);
  assertRerankerNotDownloaded();
  if (!existsSync(path.join(postgresData, 'PG_VERSION')))
    throw new Error('Production candidate did not initialize production PostgreSQL storage');
  const processCheck = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  if (
    processCheck.status !== 0 ||
    !processCheck.stdout.includes('Snaglet.app/Contents/MacOS/desktop')
  )
    throw new Error('Production native process was not running');
  const response = await fetch(`http://127.0.0.1:${port}`);
  const html = await response.text();
  if (
    !response.ok ||
    !html.includes('<div id="root"></div>') ||
    !html.match(/assets\/index-[^"']+\.js/)
  )
    throw new Error('Production UI entry point is invalid');

  // Render the workspace exactly as the desktop shell would: the session token
  // comes from the throwaway home's CLI session file and the panel token from
  // the sidecar's environment (both read privately, never logged), and the
  // check fails unless authenticated /api/ responses succeed — see
  // checkAuthenticatedWorkspace for why an origin-only apiBaseUrl or an empty
  // token would silently pass a broken app.
  const cliSession = readCliSessionIfPresent(productionHome);
  if (!cliSession)
    throw new Error('Production candidate did not publish runtime/desktop-cli-session.json');
  if (cliSession.port !== port)
    throw new Error('Production CLI session port does not match the sidecar log');
  const verifyNodePid = sidecarNodePid(child.pid!);
  if (!verifyNodePid)
    throw new Error('Could not identify the production candidate Node sidecar for its environment');
  const screenshot = path.join(output, 'desktop-production.png');
  await checkAuthenticatedWorkspace({
    port,
    token: cliSession.token,
    panelToken: readProcessEnvironment(verifyNodePid).get('SNAGLET_PANEL_TOKEN') ?? '',
    appName: desktopProduction.productName,
    screenshot,
  });
  console.log(
    `[desktop-production] verified PostgreSQL ${postgres.postgresVersion}, automatic model bootstrap, candidate identity, provenance, no source maps, backend, and authenticated workspace UI: ${app}`
  );
  console.log(
    '[desktop-production] releaseEligible=false: Apple signing and notarization credentials are required before publication'
  );
} catch (error: unknown) {
  verificationError = error;
}

let shutdownError: unknown;
try {
  await stopPackagedApp(child);
  rmSync(runtime, { force: true, maxRetries: 5, recursive: true, retryDelay: 250 });
} catch (error: unknown) {
  shutdownError = error;
}
if (verificationError && shutdownError) {
  throw new AggregateError(
    [verificationError, shutdownError],
    'Desktop production verification and PostgreSQL teardown both failed'
  );
}
if (verificationError) throw verificationError;
if (shutdownError) throw shutdownError;
