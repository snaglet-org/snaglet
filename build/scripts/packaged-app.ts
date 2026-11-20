/**
 * Packaged macOS app helpers shared by the launch-and-health smoke
 * (`smoke-packaged-app.ts`, `pnpm test:e2e:app`).
 *
 * Everything that makes a decision is a pure function of its inputs (paths,
 * parsed text, env maps) so `tests/build/packaged-app-smoke.test.ts` can prove
 * the contract without a built .app. The process-touching helpers at the
 * bottom (spawn, ps, kill, pg_ctl) are thin and take the pure results as input.
 *
 * Security notes the smoke relies on:
 *   - The CLI session file carries the sidecar token. `readCliSessionPort`
 *     returns only the port; the token is read separately by `readCliSession`
 *     and must never be logged or included in an error message.
 *   - `ps -E` output contains every sidecar env value (tokens included). The
 *     raw line is parsed in memory and never printed; only key names appear in
 *     diagnostics.
 *   - The app is launched by executable path, never through LaunchServices or
 *     AppleScript, so a user's live Snaglet instance can never receive the launch
 *     or the teardown.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import type { BuildProfile } from '../profiles/schema';

export interface PackagedApp {
  profile: string;
  productName: string;
  /** `<artifacts>/<productName>.app` */
  app: string;
  /** `Contents/MacOS/desktop` */
  executable: string;
  /** `Contents/Resources` */
  resources: string;
  /** `Contents/Resources/server` — the staged server bundle (server.mjs, migrations/, native/) */
  serverDir: string;
  /** `Contents/Resources/pg/bin` */
  pgBinDir: string;
  pgCtl: string;
}

/**
 * Resolve the packaged app for a profile, or an explicit `.app` override.
 * Throws with an actionable message when the artifact is missing so the smoke
 * reports "not built" rather than a confusing ENOENT deep inside launch.
 */
export function locatePackagedApp(
  profile: Pick<BuildProfile, 'name' | 'productName' | 'outputDirectory'>,
  override?: string,
  repoRoot = process.cwd()
): PackagedApp {
  const app = override
    ? path.resolve(override)
    : path.resolve(repoRoot, profile.outputDirectory, 'artifacts', `${profile.productName}.app`);
  if (!existsSync(app) || !statSync(app).isDirectory()) {
    throw new Error(
      `Packaged app not found at ${app}. Build it first (pnpm build:desktop for ${profile.name}) or pass --app=<path to .app>.`
    );
  }
  const executable = path.join(app, 'Contents', 'MacOS', 'desktop');
  const resources = path.join(app, 'Contents', 'Resources');
  const serverDir = path.join(resources, 'server');
  const pgBinDir = path.join(resources, 'pg', 'bin');
  const pgCtl = path.join(pgBinDir, 'pg_ctl');
  for (const [label, file] of [
    ['desktop executable', executable],
    ['server bundle', path.join(serverDir, 'server.mjs')],
    ['bundled migrations', path.join(serverDir, 'migrations', '0001_init.sql')],
    ['native helper manifest', path.join(serverDir, 'native', 'helpers.json')],
    ['bundled pg_ctl', pgCtl],
  ] as const) {
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new Error(`Packaged app is incomplete: ${label} missing at ${file}`);
    }
  }
  return {
    profile: profile.name,
    productName: profile.productName,
    app,
    executable,
    resources,
    serverDir,
    pgBinDir,
    pgCtl,
  };
}

/** Env vars that must never leak from the developer shell into a packaged launch. */
export const STRIPPED_LAUNCH_ENV = [
  'SNAGLET_APP_VERSION',
  'DATABASE_URL',
  'SNAGLET_DATABASE_URL',
  'SNAGLET_DB_CONFIG_PATH',
  'SNAGLET_DB_MODE',
  'SNAGLET_PG_BINDIR',
  'SNAGLET_PG_DATA_DIR',
  'SNAGLET_PG_OWNED',
  'SNAGLET_RIPGREP_PATH',
  'SNAGLET_AUTH_TOKEN',
  'SNAGLET_PANEL_TOKEN',
  'SNAGLET_SHUTDOWN_TOKEN',
  'SNAGLET_HOME_POINTER_FILE',
  'SNAGLET_LOCAL_INTELLIGENCE',
  'NODE_ENV',
  'PORT',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPORT',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGUSER',
] as const;

/**
 * Env vars a packaged launch inherits from the developer shell. Everything
 * else is dropped: the smoke and verifier processes import packages/db, whose
 * load-env hook reads the checkout's .env (LOG_LEVEL, SNAGLET_ENV, ...) into
 * process.env, and a real install never sees any of that — a leaked
 * LOG_LEVEL=error once emptied the candidate's server.log.
 */
export const INHERITED_LAUNCH_ENV = [
  'PATH',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  '__CF_USER_TEXT_ENCODING',
] as const;

/**
 * The environment a packaged launch runs under: only the OS basics from the
 * developer's env (see INHERITED_LAUNCH_ENV; STRIPPED_LAUNCH_ENV documents the
 * overrides that must never reach it), with HOME pointed at the throwaway
 * runtime dir (so `~/.snaglet.json` and any `~/Library` writes stay isolated) and
 * SNAGLET_HOME at the throwaway home inside it.
 */
export function packagedLaunchEnvironment(
  runtimeDir: string,
  snagletHome: string,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_LAUNCH_ENV) {
    if (base[key] !== undefined && !(STRIPPED_LAUNCH_ENV as readonly string[]).includes(key))
      env[key] = base[key];
  }
  return {
    ...env,
    HOME: runtimeDir,
    SNAGLET_HOME: snagletHome,
    RUN_BACKGROUND_WORKERS: 'false',
  };
}

export interface CliSession {
  port: number;
  /** Sidecar API token. Never log this. */
  token: string;
  shellPid: number;
}

/** Parse `<home>/runtime/desktop-cli-session.json` written by the Tauri shell. */
export function parseCliSession(text: string): CliSession {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('desktop CLI session file is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('desktop CLI session file is not an object');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.serverUrl !== 'string') throw new Error('desktop CLI session has no serverUrl');
  let url: URL;
  try {
    url = new URL(record.serverUrl);
  } catch {
    throw new Error('desktop CLI session serverUrl is not a URL');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw new Error('desktop CLI session serverUrl is not a loopback http URL');
  }
  if (typeof record.sidecarToken !== 'string' || record.sidecarToken.length === 0) {
    throw new Error('desktop CLI session has no sidecar token');
  }
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
    throw new Error('desktop CLI session has no shell pid');
  }
  return { port: Number(url.port), token: record.sidecarToken, shellPid: record.pid };
}

/**
 * Parse `ps -E -o command= -p <pid>` (macOS): the command line followed by
 * `KEY=VALUE` pairs. Values containing spaces are truncated at the first
 * space, which is fine for every key the contract checks (paths under a
 * mkdtemp runtime dir and simple flags). Returns a map; the caller must not
 * print it.
 */
export function parseProcessEnvironment(psCommandLine: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const token of psCommandLine.trim().split(/\s+/)) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(token);
    if (match) env.set(match[1], match[2]);
  }
  return env;
}

export interface SidecarContractExpectations {
  appVersion: string;
  snagletHome: string;
  port: number;
  shellPid: number;
  pgBinDir: string;
  /** `Contents/Resources/rg/rg` — the bundled ripgrep code search runs. */
  ripgrepPath: string;
}

/** Keys whose value the contract pins. */
export const SIDECAR_ENV_PINNED = [
  'SNAGLET_APP_VERSION',
  'NODE_ENV',
  'SNAGLET_LOCAL_INTELLIGENCE',
  'SNAGLET_DB_MODE',
  'SNAGLET_PG_OWNED',
  'PORT',
  'API_BASE_URL',
  'SNAGLET_ALLOWED_ORIGINS',
  'SNAGLET_HOME',
  'SNAGLET_PG_DATA_DIR',
  'SNAGLET_PG_BINDIR',
  'SNAGLET_RIPGREP_PATH',
  'SNAGLET_LOG_DIR',
  'SNAGLET_BACKUPS_DIR',
  'SNAGLET_PARENT_PID',
  'RUN_BACKGROUND_WORKERS',
] as const;

/** Keys that must be PRESENT (secrets — values are never compared or printed). */
export const SIDECAR_ENV_SECRETS = [
  'SNAGLET_AUTH_TOKEN',
  'SNAGLET_SHUTDOWN_TOKEN',
  'SNAGLET_PANEL_TOKEN',
  'SNAGLET_EXPORT_GRANT_KEY',
  'CREDENTIAL_ENCRYPTION_KEY',
] as const;

/** Keys that must be ABSENT (a packaged sidecar never reads an external database). */
export const SIDECAR_ENV_FORBIDDEN = [
  'DATABASE_URL',
  'SNAGLET_DATABASE_URL',
  'SNAGLET_DB_CONFIG_PATH',
] as const;

function samePath(a: string, b: string): boolean {
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return canonical(a) === canonical(b);
}

/**
 * Assert the sidecar env contract `apps/desktop/src-tauri/src/sidecar.rs`
 * promises. Returns the list of checked key names (for the ledger). Error
 * messages name keys only, never values.
 */
export function assertSidecarEnvContract(
  env: ReadonlyMap<string, string>,
  expected: SidecarContractExpectations
): string[] {
  const failures: string[] = [];
  const pin = (
    key: string,
    want: string,
    compare: (a: string, b: string) => boolean = (a, b) => a === b
  ) => {
    const got = env.get(key);
    if (got === undefined) failures.push(`${key} missing`);
    else if (!compare(got, want)) failures.push(`${key} has an unexpected value`);
  };
  const origin = `http://127.0.0.1:${expected.port}`;
  pin('SNAGLET_APP_VERSION', expected.appVersion);
  pin('NODE_ENV', 'production');
  pin('SNAGLET_LOCAL_INTELLIGENCE', 'true');
  pin('SNAGLET_DB_MODE', 'managed');
  pin('SNAGLET_PG_OWNED', '1');
  pin('PORT', String(expected.port));
  pin('API_BASE_URL', origin);
  pin('SNAGLET_ALLOWED_ORIGINS', origin);
  pin('SNAGLET_HOME', expected.snagletHome, samePath);
  pin('SNAGLET_PG_DATA_DIR', path.join(expected.snagletHome, 'postgres'), samePath);
  pin('SNAGLET_PG_BINDIR', expected.pgBinDir, samePath);
  pin('SNAGLET_RIPGREP_PATH', expected.ripgrepPath, samePath);
  pin('SNAGLET_LOG_DIR', path.join(expected.snagletHome, 'logs'), samePath);
  pin('SNAGLET_BACKUPS_DIR', path.join(expected.snagletHome, 'backups'), samePath);
  pin('SNAGLET_PARENT_PID', String(expected.shellPid));
  pin('RUN_BACKGROUND_WORKERS', 'false');
  for (const key of SIDECAR_ENV_SECRETS) {
    if (!env.get(key)) failures.push(`${key} missing`);
  }
  for (const key of SIDECAR_ENV_FORBIDDEN) {
    if (env.has(key)) failures.push(`${key} must not be set`);
  }
  if (failures.length > 0) {
    throw new Error(`Packaged sidecar environment contract violated: ${failures.join('; ')}`);
  }
  return [...SIDECAR_ENV_PINNED, ...SIDECAR_ENV_SECRETS];
}

/** The readiness body `/health/ready` returns. */
export interface ReadyBody {
  status?: string;
  checks?: Record<string, { status?: string; message?: string }>;
}

/** True when the sidecar reports a usable database with a current schema. */
export function isReadyBody(body: ReadyBody): boolean {
  return body.checks?.database?.status === 'ok' && body.checks?.schema?.status === 'ok';
}

/** Files a healthy packaged home carries after first launch (home-relative). */
export const FRESH_HOME_ARTIFACTS = [
  'postgres/PG_VERSION',
  'logs/server.log',
  'credential.key',
  'runtime/desktop-cli-session.json',
] as const;

export interface CheckpointManifest {
  schemaVersion: number;
  format: string;
  pendingMigrations: string[];
  sha256: string;
  byteLength: number;
}

/** Validate a pre-migration checkpoint manifest (startup-upgrade.ts). */
export function parseCheckpointManifest(value: unknown): CheckpointManifest {
  if (typeof value !== 'object' || value === null)
    throw new Error('checkpoint manifest is not an object');
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) throw new Error('checkpoint manifest schemaVersion is not 1');
  if (record.format !== 'custom') throw new Error('checkpoint manifest format is not custom');
  if (
    !Array.isArray(record.pendingMigrations) ||
    !record.pendingMigrations.every((n) => typeof n === 'string')
  ) {
    throw new Error('checkpoint manifest has no pendingMigrations list');
  }
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)) {
    throw new Error('checkpoint manifest sha256 is invalid');
  }
  if (typeof record.byteLength !== 'number' || record.byteLength <= 0) {
    throw new Error('checkpoint manifest byteLength is invalid');
  }
  return {
    schemaVersion: 1,
    format: 'custom',
    pendingMigrations: record.pendingMigrations as string[],
    sha256: record.sha256,
    byteLength: record.byteLength,
  };
}

// Process helpers (thin; not unit-tested)

/** Refuse to run while any copy of this product is open (a real user's Snaglet). */
export function assertNoRunningApp(productName: string): void {
  const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not inspect running Snaglet applications');
  const marker = `/${productName}.app/Contents/MacOS/desktop`;
  const matches = result.stdout.split('\n').filter((line) => line.includes(marker));
  if (matches.length > 0) {
    throw new Error(
      `Refusing the packaged smoke while ${productName} is already running (pids ${matches
        .map((line) => line.trim().split(/\s+/)[0])
        .join(', ')})`
    );
  }
}

export function launchPackagedApp(app: PackagedApp, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(app.executable, [], { env, stdio: 'ignore' });
}

/** The Node sidecar spawned by the shell (`snaglet-node server.mjs`). */
export function findSidecarNodePid(shellPid: number): number | undefined {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not inspect packaged app children');
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match && Number(match[2]) === shellPid && match[3].includes('/snaglet-node'))
      return Number(match[1]);
  }
  return undefined;
}

/** Read one process's environment via `ps -E` (own processes only; macOS). */
export function readProcessEnvironment(pid: number): Map<string, string> {
  const result = spawnSync('ps', ['-E', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not read the environment of pid ${pid}`);
  }
  return parseProcessEnvironment(result.stdout);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

/** pg_ctl status exit 3 = no server running; 0 = running; anything else = cannot tell. */
export function postgresStopped(pgCtl: string, dataDir: string): boolean | 'unknown' {
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) return true;
  const status = spawnSync(pgCtl, ['status', '-D', dataDir], { stdio: 'ignore' });
  if (status.status === 3) return true;
  if (status.status === 0) return false;
  return 'unknown';
}

export function readCliSessionIfPresent(snagletHome: string): CliSession | undefined {
  const file = path.join(snagletHome, 'runtime', 'desktop-cli-session.json');
  if (!existsSync(file)) return undefined;
  try {
    return parseCliSession(readFileSync(file, 'utf8'));
  } catch {
    // The shell publishes the file atomically, but tolerate a race anyway.
    return undefined;
  }
}

// Browser acceptance (shared by the smoke and the production verifier)

export interface DesktopRuntimeInjection {
  appName: string;
  /** Sidecar session token. Never logged. */
  token: string;
  /** Panel token. Never logged. */
  panelToken: string;
}

/**
 * The page-side init script that mirrors the Tauri shell's injection
 * (`apps/desktop/src-tauri/src/main.rs`): `window.__SNAGLET_DESKTOP__ = { apiBaseUrl:
 * '<origin>/api', appName, token, panelToken }` plus a `__TAURI_INTERNALS__`
 * stub so the UI believes it runs inside the shell.
 *
 * Returned as source text, never as a function: these scripts run under
 * tsx/esbuild, which decorates nested functions with a `__name` helper that
 * does not exist inside the page. A serialized callback then throws
 * `ReferenceError: __name is not defined` before the global is set and the UI
 * silently runs unauthenticated (every /api call 401). The private config is
 * embedded as a JSON literal; tests/build/packaged-app-smoke.test.ts evaluates
 * the generated source in a bare VM to pin this.
 */
export function desktopRuntimeInitScript(config: DesktopRuntimeInjection): string {
  // JSON is a JS literal except for U+2028/U+2029, which are escaped so a
  // token containing them can never break out of the string.
  const literal = JSON.stringify(config)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `(function () {
  var cfg = ${literal};
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: { invoke: function () { return Promise.resolve(null); } },
  });
  window.__SNAGLET_DESKTOP__ = {
    apiBaseUrl: window.location.origin + '/api',
    appName: cfg.appName,
    token: cfg.token,
    panelToken: cfg.panelToken,
  };
})();`;
}

export interface WorkspaceCheckOptions {
  port: number;
  /** Sidecar session token — injected as `window.__SNAGLET_DESKTOP__.token`; never logged. */
  token: string;
  /** Panel token — injected as `window.__SNAGLET_DESKTOP__.panelToken`; never logged. */
  panelToken: string;
  appName: string;
  screenshot: string;
  /** Per-step UI timeout. */
  timeoutMs?: number;
}

export interface WorkspaceCheckResult {
  apiOk: number;
}

/**
 * Render the workspace in headless Chromium as the desktop shell would.
 *
 * The globals mirror `apps/desktop/src-tauri/src/main.rs` exactly:
 * `window.__SNAGLET_DESKTOP__ = { apiBaseUrl: '<origin>/api', appName, token,
 * panelToken }`. `apiBaseUrl` must carry the `/api` suffix: the UI's fetch
 * wrapper (apps/desktop-ui/src/config.ts) attaches `x-snaglet-token` only to
 * requests whose URL starts with that absolute base, so an origin-only base
 * renders the shell chrome while every API call is rejected with 401. The
 * check therefore fails unless authenticated `/api/` responses succeed and
 * workspace content (Workspace tab + the detail pane) renders.
 */
export async function checkAuthenticatedWorkspace(
  options: WorkspaceCheckOptions
): Promise<WorkspaceCheckResult> {
  const { chromium } = await import('@playwright/test');
  const timeout = options.timeoutMs ?? 30_000;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const api = { ok: 0, unauthorized: 0, failed: [] as string[] };
    page.on('response', (pageResponse) => {
      const url = new URL(pageResponse.url());
      if (!url.pathname.startsWith('/api/')) return;
      const status = pageResponse.status();
      if (status === 401 || status === 403) api.unauthorized += 1;
      else if (status >= 400) api.failed.push(`${status} ${url.pathname}`);
      else api.ok += 1;
    });
    await page.addInitScript(
      desktopRuntimeInitScript({
        appName: options.appName,
        token: options.token,
        panelToken: options.panelToken,
      })
    );
    const injected = { failed: [] as string[] };
    page.on('pageerror', (error) => injected.failed.push(error.message.slice(0, 200)));
    const response = await page.goto(`http://127.0.0.1:${options.port}`, {
      waitUntil: 'networkidle',
    });
    if (!response?.ok())
      throw new Error(`UI entry point returned HTTP ${response?.status() ?? 'none'}`);
    const globals = await page.evaluate(() => {
      const runtime = (
        window as unknown as { __SNAGLET_DESKTOP__?: { apiBaseUrl?: string; token?: string } }
      ).__SNAGLET_DESKTOP__;
      return {
        present: runtime != null,
        apiBaseUrl: runtime?.apiBaseUrl ?? '',
        tokenPresent: !!runtime?.token,
      };
    });
    if (!globals.present || !globals.tokenPresent || !globals.apiBaseUrl.endsWith('/api')) {
      throw new Error(
        `desktop runtime globals were not injected (present=${globals.present}, token=${globals.tokenPresent}, apiBaseUrl=${globals.apiBaseUrl || 'missing'})`
      );
    }
    if (injected.failed.length > 0)
      throw new Error(`page errors during load: ${injected.failed.join(' | ')}`);
    await page.locator('#root').waitFor({ state: 'visible', timeout });
    await page.getByRole('tab', { name: 'Workspace' }).waitFor({ state: 'visible', timeout });
    // A fresh workspace opens Home with Get started beside it, both loaded
    // over the authenticated API.
    await page
      .getByRole('heading', { name: 'Welcome to Snaglet' })
      .first()
      .waitFor({ state: 'visible', timeout });
    if ((await page.getByRole('dialog', { name: 'Set up Snaglet' }).count()) > 0) {
      throw new Error('First launch showed the retired "Set up Snaglet" wizard');
    }
    if (api.unauthorized > 0) {
      throw new Error(`${api.unauthorized} /api/ response(s) were rejected as unauthenticated`);
    }
    if (api.failed.length > 0)
      throw new Error(`/api/ responses failed: ${api.failed.slice(0, 5).join(', ')}`);
    if (api.ok === 0)
      throw new Error('the workspace rendered without any successful /api/ response');
    mkdirSync(path.dirname(options.screenshot), { recursive: true });
    await page.screenshot({ fullPage: true, path: options.screenshot });
    if (statSync(options.screenshot).size < 10_000)
      throw new Error('Workspace screenshot is unexpectedly small');
    return { apiOk: api.ok };
  } finally {
    await browser.close();
  }
}
