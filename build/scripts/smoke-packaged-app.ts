/**
 * test:e2e:app — packaged macOS app launch-and-health smoke.
 *
 * Launches the built Snaglet.app by executable path in a throwaway HOME/SNAGLET_HOME
 * (never a live home), proves the sidecar boots to `/health/ready`, that the
 * Dashboard renders, and that the sidecar runs under the env contract
 * `apps/desktop/src-tauri/src/sidecar.rs` promises. Then terminates the shell
 * and proves the Node sidecar and its owned PostgreSQL stop.
 *
 * Second phase (skip with --skip-upgrade): existing-home upgrade. The home the
 * app just created is rewound to the `0001_init.sql` schema using the app's
 * own bundled PostgreSQL, a canary doc is written, and the app is relaunched. That launch must take the packaged
 * upgrade path (`packages/db/runtime/postgres/startup-upgrade.ts`): a verified
 * pre-migration checkpoint listing every later migration, the migrations
 * applied, readiness green, and the canary intact. A bundle with no migration
 * after 0001_init.sql has nothing to upgrade across, so the phase is skipped.
 *
 *   pnpm test:e2e:app                       # dist/desktop-production/artifacts/Snaglet.app
 *   pnpm test:e2e:app --profile=preview     # dist/desktop-preview/artifacts/Snaglet Preview.app
 *   pnpm test:e2e:app --app=/path/To.app    # explicit bundle
 *   pnpm test:e2e:app --skip-upgrade        # first-launch smoke only
 *   pnpm test:e2e:app --keep                # retain the throwaway runtime dir
 *
 * Requires a packaged app (pnpm build:desktop). Runs on macOS only. Never uses
 * LaunchServices or AppleScript, so a user's live Snaglet is never touched; it also
 * refuses to start while any copy of the product is running.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PostgresAdapter } from '../../packages/db/adapters/postgres';
import { migrationFiles } from '../../packages/db/migration-files';
import { pendingMigrationCount } from '../../packages/db/migrations';
import { ensurePostgresBinaries } from '../../packages/db/runtime/postgres/binaries';
import { PostgresRuntime, stampPostgresDataDir } from '../../packages/db/runtime/postgres/runtime';
import { desktopPreview } from '../profiles/desktop-preview';
import { desktopProduction } from '../profiles/desktop-production';
import { assertNativeHelpers, assertPackagedFsevents } from './native-helpers';
import {
  assertNoRunningApp,
  assertSidecarEnvContract,
  checkAuthenticatedWorkspace,
  findSidecarNodePid,
  FRESH_HOME_ARTIFACTS,
  isReadyBody,
  launchPackagedApp,
  locatePackagedApp,
  packagedLaunchEnvironment,
  parseCheckpointManifest,
  pidAlive,
  postgresStopped,
  readCliSessionIfPresent,
  readProcessEnvironment,
  waitFor,
  type CliSession,
  type PackagedApp,
  type ReadyBody,
} from './packaged-app';

interface Args {
  profile: 'production' | 'preview';
  app?: string;
  skipUpgrade: boolean;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { profile: 'production', skipUpgrade: false, keep: false };
  for (const arg of argv) {
    if (arg === '--skip-upgrade') args.skipUpgrade = true;
    else if (arg === '--keep') args.keep = true;
    else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (value !== 'production' && value !== 'preview')
        throw new Error(`Unknown profile ${value}`);
      args.profile = value;
    } else if (arg.startsWith('--app=')) args.app = arg.slice('--app='.length);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: pnpm test:e2e:app [--profile=production|preview] [--app=<path.app>] [--skip-upgrade] [--keep]\n'
      );
      process.exit(0);
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return args;
}

const LAUNCH_TIMEOUT_MS = 180_000;
const SHUTDOWN_TIMEOUT_MS = 90_000;
const CANARY_ID = 'doc-1111111111111-upgrade1';

const steps: string[] = [];
function pass(step: string, detail?: string): void {
  steps.push(step);
  console.log(`[app-smoke] ✓ ${step}${detail ? ` — ${detail}` : ''}`);
}

/** Best-effort teardown for a launch that failed before it was proven ready. */
async function abandonLaunch(
  child: ReturnType<typeof launchPackagedApp>,
  app: PackagedApp,
  dataDir: string
): Promise<void> {
  const shellPid = child.pid;
  const nodePid = shellPid ? findSidecarNodePid(shellPid) : undefined;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await waitFor(
    'abandoned shell exit',
    () => child.exitCode !== null || child.signalCode !== null,
    15_000,
    250
  ).catch(() => child.kill('SIGKILL'));
  if (nodePid)
    await waitFor(
      `abandoned sidecar ${nodePid} exit`,
      () => !pidAlive(nodePid),
      SHUTDOWN_TIMEOUT_MS,
      500
    ).catch((error: unknown) =>
      console.warn(`[app-smoke] ${error instanceof Error ? error.message : String(error)}`)
    );
  if (postgresStopped(app.pgCtl, dataDir) !== true) {
    spawnSync(app.pgCtl, ['stop', '-D', dataDir, '-m', 'fast', '-w'], { stdio: 'ignore' });
  }
}

/** One launch of the packaged app against `snagletHome`; resolves once ready. */
async function launchUntilReady(
  app: PackagedApp,
  runtimeDir: string,
  snagletHome: string,
  label: string
): Promise<{
  child: ReturnType<typeof launchPackagedApp>;
  session: CliSession;
  nodePid: number;
  ready: ReadyBody;
}> {
  // A shell that was terminated (phase 1 teardown) never removes its CLI
  // session file; the next shell overwrites it. Clear it so a stale session
  // can never be mistaken for this launch, and additionally accept only a
  // session whose pid is the shell we just spawned.
  rmSync(path.join(snagletHome, 'runtime', 'desktop-cli-session.json'), { force: true });
  const child = launchPackagedApp(app, packagedLaunchEnvironment(runtimeDir, snagletHome));
  const exitedEarly = (): boolean => child.exitCode !== null || child.signalCode !== null;
  try {
    let session: CliSession | undefined;
    await waitFor(
      `${label}: desktop CLI session file for shell ${child.pid}`,
      () => {
        if (exitedEarly())
          throw new Error(
            `${label}: app exited before publishing its CLI session (code ${child.exitCode})`
          );
        const candidate = readCliSessionIfPresent(snagletHome);
        if (candidate && candidate.shellPid === child.pid) session = candidate;
        return session !== undefined;
      },
      LAUNCH_TIMEOUT_MS
    );
    if (!session) throw new Error('unreachable');
    pass(`${label}: shell published CLI session`, `port ${session.port}`);

    let ready: ReadyBody = {};
    const port = session.port;
    await waitFor(
      `${label}: /health/ready`,
      async () => {
        if (exitedEarly())
          throw new Error(`${label}: app exited before readiness (code ${child.exitCode})`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) return false;
          ready = (await response.json()) as ReadyBody;
          return isReadyBody(ready);
        } catch {
          return false;
        }
      },
      LAUNCH_TIMEOUT_MS,
      1_000
    );
    pass(`${label}: /health/ready database+schema ok`, `status=${ready.status}`);

    const nodePid = findSidecarNodePid(child.pid!);
    if (!nodePid)
      throw new Error(`${label}: could not identify the Node sidecar under shell pid ${child.pid}`);
    return { child, session, nodePid, ready };
  } catch (error: unknown) {
    await abandonLaunch(child, app, path.join(snagletHome, 'postgres'));
    throw error;
  }
}

/**
 * Desktop log contract for one launch: the shell captures the sidecar's own
 * stdout/stderr in `logs/sidecar.console.log` (fresh per launch), and the
 * server's winston file `logs/server.log` must not carry a doubled copy of
 * every line, which is what happened when the shell piped the console output
 * into it. Lines carry second-resolution timestamps, so a doubled file shows
 * as the majority of lines repeating their predecessor exactly.
 */
function assertLaunchLogs(snagletHome: string, label: string): void {
  const consoleLog = path.join(snagletHome, 'logs', 'sidecar.console.log');
  if (!existsSync(consoleLog) || !statSync(consoleLog).isFile())
    throw new Error(`${label}: ${consoleLog} is missing`);
  if (statSync(consoleLog).size === 0) throw new Error(`${label}: sidecar.console.log is empty`);
  const serverLog = path.join(snagletHome, 'logs', 'server.log');
  const lines = readFileSync(serverLog, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error(`${label}: server.log is empty`);
  let repeated = 0;
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === lines[i - 1]) repeated += 1;
  if (repeated * 2 >= lines.length) {
    throw new Error(
      `${label}: server.log looks doubled (${repeated} of ${lines.length} lines repeat the previous line)`
    );
  }
  pass(
    `${label}: sidecar.console.log captured and server.log has no doubled lines`,
    `${lines.length} server.log line(s), ${repeated} repeated`
  );
}

async function terminate(
  child: ReturnType<typeof launchPackagedApp>,
  nodePid: number,
  app: PackagedApp,
  dataDir: string,
  label: string
): Promise<void> {
  // The Tauri shell installs no signal handlers: SIGTERM ends it immediately
  // and the sidecar's parent watchdog (SNAGLET_PARENT_PID) must notice within its
  // 5 s poll and run the normal graceful shutdown, stopping owned PostgreSQL.
  // That is the same path a force-quit or crash takes, and it is what this
  // step proves. Never LaunchServices/AppleScript (a live Snaglet could receive it).
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await waitFor(
    `${label}: shell exit`,
    () => child.exitCode !== null || child.signalCode !== null,
    15_000,
    250
  ).catch(() => {
    child.kill('SIGKILL');
  });
  await waitFor(
    `${label}: shell exit after SIGKILL`,
    () => child.exitCode !== null || child.signalCode !== null,
    10_000,
    250
  );
  await waitFor(
    `${label}: Node sidecar ${nodePid} exit`,
    () => !pidAlive(nodePid),
    SHUTDOWN_TIMEOUT_MS,
    500
  );
  pass(`${label}: shell terminated and sidecar exited via parent watchdog`);
  await waitFor(
    `${label}: PostgreSQL stop`,
    () => {
      const stopped = postgresStopped(app.pgCtl, dataDir);
      if (stopped === 'unknown')
        throw new Error(`${label}: pg_ctl could not report cluster status for ${dataDir}`);
      return stopped;
    },
    SHUTDOWN_TIMEOUT_MS,
    500
  );
  pass(`${label}: owned PostgreSQL stopped`);
}

/**
 * Rewind the app-created home to the `0001_init.sql` schema using the app's
 * own bundled PostgreSQL, exactly as the sidecar runs it (same SNAGLET_HOME, data
 * dir, binaries, owned mode). Leaves the cluster stopped.
 */
async function rewindHomeToInitialSchema(app: PackagedApp, snagletHome: string): Promise<string[]> {
  const dataDir = path.join(snagletHome, 'postgres');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SNAGLET_HOME: snagletHome,
    SNAGLET_PG_DATA_DIR: dataDir,
    SNAGLET_PG_BINDIR: app.pgBinDir,
    SNAGLET_PG_OWNED: '1',
    SNAGLET_DB_MODE: 'managed',
  };
  for (const key of ['DATABASE_URL', 'SNAGLET_DATABASE_URL', 'SNAGLET_DB_CONFIG_PATH'])
    delete env[key];
  // ensurePostgresBinaries reads the process env for SNAGLET_PG_BINDIR; scope it.
  const priorBinDir = process.env.SNAGLET_PG_BINDIR;
  const priorOwned = process.env.SNAGLET_PG_OWNED;
  process.env.SNAGLET_PG_BINDIR = app.pgBinDir;
  process.env.SNAGLET_PG_OWNED = '1';
  const runtime = new PostgresRuntime({
    snagletHome,
    dataDir,
    env,
    ensureBinaries: () => ensurePostgresBinaries({ buildIfMissing: false }),
    log: () => {},
  });
  let db: PostgresAdapter | undefined;
  try {
    await runtime.start();
    const info = await runtime.connectionInfo();
    db = new PostgresAdapter({
      host: info.host,
      port: info.port,
      database: info.database,
      user: info.user,
      password: info.password,
    });
    const bundledMigrations = migrationFiles(path.join(app.serverDir, 'migrations'));
    const initial = readFileSync(
      path.join(app.serverDir, 'migrations', bundledMigrations[0]),
      'utf8'
    );
    if (bundledMigrations[0] !== '0001_init.sql')
      throw new Error('bundled chain does not start at 0001_init.sql');
    // Everything Snaglet owns lives in `public` (tables, extensions, the ledger).
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.exec(initial);
    await pendingMigrationCount(db); // creates the ledger without applying anything
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM public._migrations');
      await tx.query('INSERT INTO public._migrations (name) VALUES ($1)', [bundledMigrations[0]]);
      await tx.query(`INSERT INTO public.nodes (id, type, container_id) VALUES ($1, 'doc', NULL)`, [
        CANARY_ID,
      ]);
      await tx.query(
        `INSERT INTO public.docs (id, title, content) VALUES ($1, 'Upgrade canary', 'retain across packaged upgrade')`,
        [CANARY_ID]
      );
    });
    await stampPostgresDataDir(dataDir, 1);
    return bundledMigrations.slice(1);
  } finally {
    await db?.end();
    try {
      await runtime.stop('fast');
    } catch (stopError: unknown) {
      // Never leave the throwaway cluster running: fall back to the app's own
      // pg_ctl against the data dir we started, then surface the refusal.
      const forced = spawnSync(app.pgCtl, ['stop', '-D', dataDir, '-m', 'fast', '-w'], {
        stdio: 'ignore',
      });
      if (forced.status !== 0 && postgresStopped(app.pgCtl, dataDir) !== true) {
        throw new Error(
          `rewind cluster could not be stopped: ${stopError instanceof Error ? stopError.message : String(stopError)}`
        );
      }
    }
    if (priorBinDir === undefined) delete process.env.SNAGLET_PG_BINDIR;
    else process.env.SNAGLET_PG_BINDIR = priorBinDir;
    if (priorOwned === undefined) delete process.env.SNAGLET_PG_OWNED;
    else process.env.SNAGLET_PG_OWNED = priorOwned;
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The packaged app smoke runs on macOS only');
  const args = parseArgs(process.argv.slice(2));
  const profile = args.profile === 'preview' ? desktopPreview : desktopProduction;
  const app = locatePackagedApp(profile, args.app);
  const appVersion = execFileSync(
    '/usr/libexec/PlistBuddy',
    ['-c', 'Print :CFBundleShortVersionString', path.join(app.app, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }
  ).trim();
  pass('located packaged app', app.app);
  assertNativeHelpers(
    JSON.parse(readFileSync(path.join(app.serverDir, 'native', 'helpers.json'), 'utf8')) as unknown,
    app.serverDir
  );
  pass('native helper manifest matches the bundle');
  assertPackagedFsevents(app.serverDir);
  pass('packaged server includes fsevents');
  assertNoRunningApp(app.productName);

  // Canonical path: the shell resolves SNAGLET_HOME to its real path before
  // deriving PostgreSQL's socket directory (a hash of the data dir), so every
  // path this process derives must start from the same canonical form.
  const runtimeDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'snaglet-app-smoke-')));
  const snagletHome = path.join(runtimeDir, '.snaglet');
  const dataDir = path.join(snagletHome, 'postgres');
  const screenshotDir = path.resolve(profile.outputDirectory);
  // The upgrade phase needs a migration after the baseline to upgrade across.
  const runUpgrade =
    !args.skipUpgrade && migrationFiles(path.join(app.serverDir, 'migrations')).length > 1;
  if (!args.skipUpgrade && !runUpgrade) {
    console.log(
      '[app-smoke] upgrade phase skipped: no migration after 0001_init.sql to upgrade across'
    );
  }
  let failure: unknown;
  try {
    // Phase 1: fresh launch
    const first = await launchUntilReady(app, runtimeDir, snagletHome, 'fresh launch');
    try {
      const sidecarEnv = readProcessEnvironment(first.nodePid);
      const checked = assertSidecarEnvContract(sidecarEnv, {
        appVersion,
        snagletHome,
        port: first.session.port,
        shellPid: first.child.pid!,
        pgBinDir: app.pgBinDir,
        ripgrepPath: path.join(app.resources, 'rg', 'rg'),
      });
      pass('sidecar env contract holds', `${checked.length} keys checked`);
      for (const relative of FRESH_HOME_ARTIFACTS) {
        const absolute = path.join(snagletHome, relative);
        if (!existsSync(absolute) || !statSync(absolute).isFile())
          throw new Error(`fresh home is missing ${relative}`);
      }
      if (
        existsSync(path.join(snagletHome, 'backups', 'pre-migration')) &&
        readdirSync(path.join(snagletHome, 'backups', 'pre-migration')).length > 0
      ) {
        throw new Error('a fresh install must not create a pre-migration checkpoint');
      }
      pass('fresh home carries the packaged layout and no checkpoint');
      const workspace = await checkAuthenticatedWorkspace({
        port: first.session.port,
        token: first.session.token,
        panelToken: sidecarEnv.get('SNAGLET_PANEL_TOKEN') ?? '',
        appName: app.productName,
        screenshot: path.join(screenshotDir, 'app-smoke-fresh.png'),
      });
      pass(
        'workspace loaded through authenticated API calls',
        `${workspace.apiOk} ok, 0 unauthorized`
      );
      pass('Dashboard rendered on first launch as the desktop shell would');
    } finally {
      await terminate(first.child, first.nodePid, app, dataDir, 'fresh launch');
    }
    assertLaunchLogs(snagletHome, 'fresh launch');

    // Phase 2: existing-home upgrade
    if (runUpgrade) {
      const expectedPending = await rewindHomeToInitialSchema(app, snagletHome);
      pass(
        'home rewound to the 0001 baseline schema with a canary doc',
        `${expectedPending.length} migration(s) now pending`
      );
      const second = await launchUntilReady(app, runtimeDir, snagletHome, 'upgrade launch');
      try {
        const checkpointRoot = path.join(snagletHome, 'backups', 'pre-migration');
        const checkpoints = existsSync(checkpointRoot)
          ? readdirSync(checkpointRoot).filter((name) => !name.startsWith('.'))
          : [];
        if (checkpoints.length !== 1)
          throw new Error(
            `expected exactly one pre-migration checkpoint, found ${checkpoints.length}`
          );
        const checkpoint = path.join(checkpointRoot, checkpoints[0]);
        const manifest = parseCheckpointManifest(
          JSON.parse(readFileSync(path.join(checkpoint, 'manifest.json'), 'utf8')) as unknown
        );
        if (JSON.stringify(manifest.pendingMigrations) !== JSON.stringify(expectedPending)) {
          throw new Error(
            `checkpoint lists ${manifest.pendingMigrations.join(', ')}; expected ${expectedPending.join(', ')}`
          );
        }
        const dump = readFileSync(path.join(checkpoint, 'database.dump'));
        if (dump.subarray(0, 5).toString('ascii') !== 'PGDMP')
          throw new Error('checkpoint dump is not a PostgreSQL custom archive');
        if (
          dump.byteLength !== manifest.byteLength ||
          createHash('sha256').update(dump).digest('hex') !== manifest.sha256
        ) {
          throw new Error('checkpoint dump does not match its manifest');
        }
        pass(
          'packaged upgrade wrote a verified pre-migration checkpoint',
          `${manifest.pendingMigrations.length} migration(s) recorded`
        );
        const canary = await fetch(
          `http://127.0.0.1:${second.session.port}/api/docs/${CANARY_ID}`,
          {
            headers: { 'x-snaglet-token': second.session.token },
            signal: AbortSignal.timeout(15_000),
          }
        );
        const body = (await canary.json()) as { success?: boolean; data?: { content?: string } };
        if (
          !canary.ok ||
          body.success !== true ||
          body.data?.content !== 'retain across packaged upgrade'
        ) {
          throw new Error(`canary doc did not survive the upgrade (HTTP ${canary.status})`);
        }
        pass('workspace data survived the upgrade');
      } finally {
        await terminate(second.child, second.nodePid, app, dataDir, 'upgrade launch');
      }
    }
  } catch (error: unknown) {
    failure = error;
  }

  if (failure) {
    console.error(
      `[app-smoke] FAIL after ${steps.length} step(s): ${failure instanceof Error ? failure.message : String(failure)}`
    );
    console.error(
      `[app-smoke] evidence retained at ${runtimeDir} (server log: ${path.join(snagletHome, 'logs', 'server.log')}; early boot output: ${path.join(snagletHome, 'logs', 'sidecar.console.log')})`
    );
    process.exitCode = 1;
    return;
  }
  if (args.keep) console.log(`[app-smoke] runtime retained at ${runtimeDir}`);
  else rmSync(runtimeDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 250 });
  console.log(
    JSON.stringify({
      result: 'PASS',
      profile: profile.name,
      app: app.app,
      steps,
      upgradePhase: runUpgrade,
    })
  );
}

main().catch((error: unknown) => {
  console.error(`[app-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
