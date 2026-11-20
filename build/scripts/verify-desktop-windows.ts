import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { resolveBuildProfile } from '../profiles';
import { verifyPackagedPostgres } from './postgres-artifact';
import { nsisExecutableSha256 } from './windows-executable';
import { sanitizeScratchPreviewEnvironment } from '../../scripts/preview-scratch';
import { requestWindowsClose } from '../../scripts/lib/child-shutdown';

interface ArtifactManifest {
  schemaVersion: number;
  profile: string;
  platform: string;
  applicationId: string;
  executable: string;
  executableSha256: string;
  nsisExecutableSha256?: string;
  installers: string[];
  files: Array<{ path: string; size: number; sha256: string }>;
}

interface DesktopSession {
  serverUrl: string;
  sidecarToken: string;
  pid: number;
}

interface WindowsProcess {
  pid: number;
  executablePath?: string;
}

if (process.platform !== 'win32') throw new Error('Windows desktop verification requires Windows');
const profile = resolveBuildProfile(process.env.SNAGLET_BUILD_PROFILE ?? 'desktop-preview');
const output = path.resolve(profile.outputDirectory);
const artifacts = path.join(output, 'artifacts');
const manifest = JSON.parse(
  readFileSync(path.join(artifacts, 'artifact-manifest.json'), 'utf8')
) as ArtifactManifest;
assert.equal(manifest.schemaVersion, 3);
assert.equal(manifest.profile, profile.name);
assert.equal(manifest.platform, 'win32-x64');
assert.equal(manifest.applicationId, profile.applicationId);
assert.ok(manifest.installers.length > 0, 'NSIS installer is required');

function artifactPath(relative: string): string {
  const absolute = path.resolve(artifacts, relative);
  const within = path.relative(artifacts, absolute);
  assert.ok(
    within && within !== '..' && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within)
  );
  return absolute;
}

function containedPath(root: string, relative: string, label: string): string {
  const absolute = path.resolve(root, relative);
  const within = path.relative(root, absolute);
  assert.ok(
    within && within !== '..' && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within),
    `${label} escapes ${root}`
  );
  return absolute;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function runningDesktopProcesses(): WindowsProcess[] {
  // WMI exposes the executable path, unlike `tasklist`, so this read-only
  // preflight can distinguish Snaglet's bundled `desktop.exe` from another app.
  const query = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
    'Get-CimInstance -ClassName Win32_Process -Filter "Name = \'desktop.exe\'" | ForEach-Object { [PSCustomObject]@{ pid = $_.ProcessId; executablePath = $_.ExecutablePath } } | ConvertTo-Json -Compress',
  ].join('; ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', query],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cannot inspect running desktop processes before verification: ${
        result.error?.message ?? result.stderr.trim() ?? `PowerShell exited ${result.status}`
      }`
    );
  }
  const output = result.stdout.trim();
  if (!output) return [];
  const parsed = JSON.parse(output) as WindowsProcess | WindowsProcess[];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((process): process is WindowsProcess =>
    Number.isInteger(process.pid)
  );
}

function assertApplicationIsNotRunning(executable: string): void {
  const normalizedExecutable = realpathSync(executable).toLowerCase();
  const matches = runningDesktopProcesses().filter((process) => {
    if (!process.executablePath) return false;
    try {
      return realpathSync(process.executablePath).toLowerCase() === normalizedExecutable;
    } catch {
      return false;
    }
  });
  if (matches.length > 0) {
    throw new Error(
      `Snaglet is already running from ${executable} (PID ${matches.map(({ pid }) => pid).join(', ')}). ` +
        'Close that Snaglet window and wait for it to exit, then retry verification. ' +
        'The verifier will not close an existing application.'
    );
  }
}

for (const file of manifest.files) {
  const absolute = artifactPath(file.path);
  assert.equal(statSync(absolute).size, file.size, `size: ${file.path}`);
  assert.equal(sha256(absolute), file.sha256, `hash: ${file.path}`);
}
assert.equal(sha256(artifactPath(manifest.executable)), manifest.executableSha256);
if (manifest.nsisExecutableSha256 !== undefined) {
  assert.equal(
    nsisExecutableSha256(readFileSync(artifactPath(manifest.executable))),
    manifest.nsisExecutableSha256,
    'NSIS executable must match the exact Tauri bundle marker patch'
  );
}
for (const installer of manifest.installers) {
  assert.ok(
    manifest.files.some((file) => file.path === installer),
    'Installer must be hashed'
  );
  assert.ok(installer.endsWith('-setup.exe'));
}

const configuredInstalledApp = process.env.SNAGLET_WINDOWS_INSTALLED_APP?.trim();
const installedApp = configuredInstalledApp
  ? realpathSync(path.resolve(configuredInstalledApp))
  : undefined;
if (installedApp) {
  assert.ok(
    statSync(installedApp).isDirectory(),
    'SNAGLET_WINDOWS_INSTALLED_APP must be a directory'
  );
}
const installedLayout = installedApp !== undefined;
if (installedLayout) {
  assert.ok(
    manifest.nsisExecutableSha256,
    'Installed verification requires the NSIS executable hash'
  );
}
assert.ok(manifest.executable.startsWith('app/'), 'Executable must be in the app directory');
const installedExecutable = installedLayout
  ? realpathSync(
      containedPath(installedApp!, manifest.executable.slice('app/'.length), 'installed executable')
    )
  : undefined;
if (installedExecutable) assertApplicationIsNotRunning(installedExecutable);

// Keep the app outside the checkout and preserve diagnostics in a disposable
// home. No test launch may load a repository .env or the user's existing data.
const runtime = mkdtempSync(path.join(os.tmpdir(), 'snaglet-windows-desktop-'));
const app = installedApp ?? path.join(runtime, 'Application with spaces');
const home = path.join(runtime, 'Home with spaces ü 日本');
const appFiles = manifest.files.filter((file) => file.path.startsWith('app/'));
assert.ok(appFiles.length > 0, 'Artifact manifest contains no app files');
if (installedApp) {
  for (const file of appFiles) {
    const installedFile: string = realpathSync(
      containedPath(installedApp, file.path.slice('app/'.length), `installed ${file.path}`)
    );
    const within = path.relative(installedApp, installedFile);
    assert.ok(
      within && within !== '..' && !within.startsWith(`..${path.sep}`) && !path.isAbsolute(within),
      `installed ${file.path} resolves outside ${installedApp}`
    );
    assert.equal(statSync(installedFile).size, file.size, `installed size: ${file.path}`);
    const expectedHash =
      file.path === manifest.executable ? manifest.nsisExecutableSha256 : file.sha256;
    assert.equal(sha256(installedFile), expectedHash, `installed hash: ${file.path}`);
  }
}
const applicationExecutable = installedExecutable ?? artifactPath(manifest.executable);
assert.equal(
  sha256(applicationExecutable),
  installedLayout ? manifest.nsisExecutableSha256 : manifest.executableSha256,
  'app executable hash'
);
if (!installedApp) cpSync(path.join(artifacts, 'app'), app, { recursive: true });
verifyPackagedPostgres(path.join(app, 'pg'));
mkdirSync(home);
const pgCtl = path.join(app, 'pg', 'bin', 'pg_ctl.exe');
const pgData = path.join(home, 'postgres');
const screenshot = path.join(
  output,
  installedLayout ? 'desktop-windows-installed.png' : 'desktop-windows.png'
);
const report = path.join(
  output,
  installedLayout ? 'windows-installed-acceptance.json' : 'windows-acceptance.json'
);

async function unusedPort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

async function until(
  check: () => Promise<boolean>,
  message: string,
  timeout = 120_000
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`${message}; diagnostics retained at ${runtime}`);
}

let child: ChildProcess | undefined;
async function launch(): Promise<{ session: DesktopSession; cdpPort: number }> {
  const cdpPort = await unusedPort();
  child = spawn(applicationExecutable, [], {
    cwd: app,
    // A visible main window is required to exercise CloseMainWindow on Windows.
    windowsHide: false,
    stdio: 'inherit',
    env: {
      ...sanitizeScratchPreviewEnvironment(process.env),
      SNAGLET_HOME: home,
      SNAGLET_HOME_POINTER_FILE: path.join(runtime, 'home-pointer.json'),
      SNAGLET_ENV: 'prod',
      SNAGLET_BIND_HOST: '127.0.0.1',
      SNAGLET_DATABASE_NAME: 'snaglet',
      WEBVIEW2_USER_DATA_FOLDER: path.join(runtime, 'webview-profile'),
      RUN_BACKGROUND_WORKERS: 'false',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`,
    },
  });
  let session: DesktopSession | undefined;
  let startupError: Error | undefined;
  child.once('error', (error) => {
    startupError = error;
  });
  await until(async () => {
    if (startupError)
      throw new Error(
        `Desktop failed to start: ${startupError.message}; diagnostics retained at ${runtime}`
      );
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Desktop exited during startup (exitCode: ${child?.exitCode ?? 'none'}, signal: ${
          child?.signalCode ?? 'none'
        }); diagnostics retained at ${runtime}`
      );
    }
    try {
      const candidate = JSON.parse(
        readFileSync(path.join(home, 'runtime', 'desktop-cli-session.json'), 'utf8')
      ) as DesktopSession;
      if (candidate.pid !== child.pid) return false;
      const ready = await fetch(`${candidate.serverUrl}/health/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!ready.ok) return false;
      session = candidate;
      return true;
    } catch {
      return false;
    }
  }, 'Desktop did not become ready');
  assert.ok(session);
  return { session, cdpPort };
}

async function api(
  session: DesktopSession,
  route: string,
  method = 'GET',
  body?: unknown
): Promise<unknown> {
  const response = await fetch(`${session.serverUrl}/api${route}`, {
    method,
    headers: { 'x-snaglet-token': session.sidecarToken, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return response.json();
}

async function stop(force: boolean): Promise<void> {
  assert.ok(child?.pid);
  if (child.exitCode === null && child.signalCode === null) {
    if (force) child.kill();
    else requestWindowsClose(child);
  }
  await until(
    async () => child?.exitCode !== null || child?.signalCode !== null,
    'Desktop did not exit',
    70_000
  );
  await until(
    async () => {
      if (!existsSync(path.join(pgData, 'PG_VERSION'))) return true;
      const result = spawnSync(pgCtl, ['status', '-D', pgData], {
        windowsHide: true,
        timeout: 2_000,
        stdio: 'ignore',
      });
      return result.status === 3;
    },
    'Owned PostgreSQL outlived desktop shutdown',
    40_000
  );
  child = undefined;
}

try {
  const first = await launch();
  await until(async () => {
    try {
      return (
        await fetch(`http://127.0.0.1:${first.cdpPort}/json/version`, {
          signal: AbortSignal.timeout(1_000),
        })
      ).ok;
    } catch {
      return false;
    }
  }, 'WebView2 debugger unavailable');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${first.cdpPort}`);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().startsWith(first.session.serverUrl));
  assert.ok(page, 'Packaged webview page missing');
  await page.locator('#root').waitFor();
  await page.waitForFunction(
    () => (document.querySelector('#root')?.textContent?.trim().length ?? 0) > 20
  );
  await page.screenshot({ path: screenshot });
  // Disconnect CDP without closing the native app; CloseMainWindow below
  // exercises the real shell shutdown path.
  await browser.close();
  const created = (await api(first.session, '/docs', 'POST', {
    title: 'Windows acceptance fixture',
    content: 'First revision',
  })) as { data: { id: string } };
  assert.ok(created.data.id);
  await api(first.session, `/docs/${created.data.id}`, 'PATCH', {
    content: 'Saved on Windows — second revision',
  });
  await stop(false);
  const second = await launch();
  const reopened = (await api(second.session, `/docs/${created.data.id}`)) as {
    data: { content: string };
  };
  assert.equal(reopened.data.content, 'Saved on Windows — second revision');
  await stop(true);
  const recovered = await launch();
  const afterCrash = (await api(recovered.session, `/docs/${created.data.id}`)) as {
    data: { content: string };
  };
  assert.equal(afterCrash.data.content, reopened.data.content);
  await stop(false);
  writeFileSync(
    report,
    `${JSON.stringify(
      {
        layout: installedLayout ? 'installed-nsis-directory' : 'portable-artifact-copy',
        verified: [
          'artifact hashes',
          ...(installedLayout ? ['installed app file hashes'] : []),
          'native webview',
          'create/edit document',
          'normal quit/reopen',
          'parent crash recovery',
        ],
        runtime,
        screenshot,
        profile: profile.name,
      },
      null,
      2
    )}\n`
  );
  console.log(
    `[windows-desktop] ${installedLayout ? 'installed NSIS layout' : 'portable artifact'} lifecycle and document persistence passed; evidence: ${output}`
  );
} finally {
  if (child) await stop(true);
}
