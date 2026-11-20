#!/usr/bin/env tsx
/**
 * `pnpm install:app`: build the production desktop app and install it.
 *
 * macOS: runs `pnpm build:desktop`, copies the Snaglet.app it writes into
 * /Applications (or `--dest`), quits a copy of Snaglet running from there first,
 * and opens the new one. Other platforms: builds, then prints where the
 * installer is and how to run it; nothing is installed for you there.
 *
 * The swap never leaves the destination without an app. The new copy is made
 * next to the old one under a hidden name, then two renames on the same volume
 * trade them, and the old copy is deleted last. A run that stops partway
 * leaves hidden leftovers that the next run removes or puts back.
 */

import { spawnSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '@snaglet/shared/utils';
import { desktopProduction } from '../build/profiles/desktop-production';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DEFAULT_DEST = '/Applications';
const APP_NAME = `${desktopProduction.productName}.app`;
const MAIN_EXECUTABLE = 'Contents/MacOS/desktop';
/** The shell's quit drains the server (up to 35 s), then stops PostgreSQL (up to 20 s). */
const QUIT_TIMEOUT_MS = 90_000;

export interface InstallAppOptions {
  skipBuild: boolean;
  launch: boolean;
  destDir: string;
  help: boolean;
}

export type InstallStep = 'check' | 'build' | 'install' | 'launch' | 'show-installer';

export type LeftoverAction = 'remove-staging' | 'restore-previous' | 'remove-previous';

export interface InstallPaths {
  app: string;
  /** The new copy while it is being made. */
  staging: string;
  /** The old copy between the two renames of the swap. */
  previous: string;
}

export interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

function usage(): string {
  return `Usage: pnpm install:app [options]

Build the Snaglet desktop app from this checkout and install it.

macOS: builds with pnpm build:desktop, installs Snaglet.app into /Applications and
opens it. A copy of Snaglet running from there is asked to quit first. Other
platforms: builds, then prints where the installer is and how to run it.

Options:
  --dest <folder>  Install into this folder instead of /Applications (macOS)
  --skip-build     Install the app the last build made instead of building again
  --no-launch      Do not open Snaglet after installing (macOS)
  --help           Show this help`;
}

export function parseInstallAppArgs(
  args: readonly string[],
  cwd: string = process.cwd(),
  home: string = homedir()
): InstallAppOptions {
  const options: InstallAppOptions = {
    skipBuild: false,
    launch: true,
    destDir: DEFAULT_DEST,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--') continue;
    if (argument === '--skip-build') options.skipBuild = true;
    else if (argument === '--no-launch') options.launch = false;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--dest' || argument.startsWith('--dest=')) {
      const value = argument === '--dest' ? args[++index] : argument.slice('--dest='.length);
      if (!value || value.startsWith('-')) {
        throw new Error('--dest needs a folder, for example --dest ~/Applications');
      }
      options.destDir = resolve(cwd, value.replace(/^~(?=$|\/)/, home));
    } else {
      throw new Error(
        `Unknown option ${JSON.stringify(argument)}. Run with --help for the options.`
      );
    }
  }
  return options;
}

export function planInstall(
  platform: NodeJS.Platform,
  options: Pick<InstallAppOptions, 'skipBuild' | 'launch'>
): InstallStep[] {
  const build: InstallStep[] = options.skipBuild ? [] : ['build'];
  if (platform !== 'darwin') return ['check', ...build, 'show-installer'];
  return ['check', ...build, 'install', ...(options.launch ? (['launch'] as const) : [])];
}

/** Where `pnpm build:desktop` writes its output (see build/scripts/package-desktop.ts). */
export function builtArtifacts(repoRoot: string): { dir: string; macApp: string } {
  const dir = join(repoRoot, desktopProduction.outputDirectory, 'artifacts');
  return { dir, macApp: join(dir, APP_NAME) };
}

/**
 * The working copies sit in the destination folder itself, so each swap step
 * is a rename on one volume. Their names do not end in `.app`, so macOS never
 * treats them as apps.
 */
export function installPaths(destDir: string): InstallPaths {
  return {
    app: join(destDir, APP_NAME),
    staging: join(destDir, `.${APP_NAME}.installing`),
    previous: join(destDir, `.${APP_NAME}.previous`),
  };
}

/**
 * What to do with copies an interrupted run left behind. A staged copy only
 * becomes the app through a rename, so it is never the only copy. A previous
 * copy with no app beside it is the only copy, so it goes back into place.
 */
export function leftoverActions(present: {
  app: boolean;
  staging: boolean;
  previous: boolean;
}): LeftoverAction[] {
  const actions: LeftoverAction[] = [];
  if (present.staging) actions.push('remove-staging');
  if (present.previous) actions.push(present.app ? 'remove-previous' : 'restore-previous');
  return actions;
}

/** Parses `ps -axww -o pid=,ppid=,command=` output. */
export function parseProcessTable(output: string): ProcessEntry[] {
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}

/** Processes started from inside the bundle: the shell, its Node server and PostgreSQL. */
export function bundleProcesses(table: readonly ProcessEntry[], appPath: string): ProcessEntry[] {
  return table.filter((entry) => entry.command.startsWith(`${appPath}/`));
}

/** True when `pid` or one of its ancestors runs from the bundle. */
export function runsInside(table: readonly ProcessEntry[], pid: number, appPath: string): boolean {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const inside = new Set(bundleProcesses(table, appPath).map((entry) => entry.pid));
  const seen = new Set<number>();
  let current = byPid.get(pid);
  while (current && !seen.has(current.pid)) {
    if (inside.has(current.pid)) return true;
    seen.add(current.pid);
    current = byPid.get(current.ppid);
  }
  return false;
}

/** Bundles of Snaglet copies running from anywhere other than `appPath`. */
export function otherRunningCopies(table: readonly ProcessEntry[], appPath: string): string[] {
  const suffix = `/${APP_NAME}/${MAIN_EXECUTABLE}`;
  const bundles = new Set<string>();
  for (const { command } of table) {
    const end = command.indexOf(suffix);
    if (end === -1) continue;
    const after = command.charAt(end + suffix.length);
    if (after !== '' && after !== ' ') continue;
    const bundle = command.slice(0, end + APP_NAME.length + 1);
    if (bundle !== appPath) bundles.add(bundle);
  }
  return [...bundles];
}

/** What to tell someone on a platform this script does not install on. */
export function installerInstructions(
  platform: NodeJS.Platform,
  artifactsDir: string,
  files: readonly string[]
): string[] {
  if (platform === 'win32') {
    const installers = files.filter((file) => /-setup\.exe$/i.test(file));
    if (installers.length === 0) throw new Error(missingBuild(artifactsDir));
    return [
      'Windows support is still in progress; see docs/windows-development.md.',
      'To install Snaglet, run the installer:',
      ...installers.map((file) => `  ${join(artifactsDir, file)}`),
    ];
  }
  if (platform === 'linux') {
    const packages = files.filter((file) => file.endsWith('.deb'));
    if (packages.length === 0) throw new Error(missingBuild(artifactsDir));
    return [
      'Snaglet does not work on Linux yet; see docs/linux-development.md.',
      'The build wrote a Debian package. To install it anyway:',
      ...packages.map((file) => `  sudo apt install ${join(artifactsDir, file)}`),
    ];
  }
  throw new Error(`Snaglet has no desktop build for ${platform}.`);
}

function missingBuild(artifactsDir: string): string {
  return `No build found in ${artifactsDir}. Run without --skip-build to build it first.`;
}

interface SpawnResult {
  error?: Error;
  status: number | null;
  stderr: string | null;
}

/** The most useful line about why a command failed. */
function failureDetail(result: SpawnResult): string {
  if (result.error) return getErrorMessage(result.error);
  return result.stderr?.trim() || `exit status ${String(result.status ?? 'unknown')}`;
}

function readProcessTable(): ProcessEntry[] {
  const result = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not list running processes: ${failureDetail(result)}`);
  }
  return parseProcessTable(result.stdout);
}

function checkToolchain(platform: NodeJS.Platform): void {
  // Run where rustup reads the pinned toolchain, as the build does.
  const cargo = crossSpawn.sync('cargo', ['--version'], {
    cwd: join(REPO_ROOT, 'apps', 'desktop', 'src-tauri'),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (cargo.error) {
    throw new Error(
      'Rust is not installed, or `cargo` is not on your PATH. Install Rust from ' +
        'https://rustup.rs, open a new terminal (or run `source ~/.cargo/env`), and try again.'
    );
  }
  if (cargo.status !== 0) throw new Error(`\`cargo --version\` failed: ${failureDetail(cargo)}`);
  if (platform !== 'darwin') return;
  const tools = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' });
  if (tools.error || tools.status !== 0) {
    throw new Error(
      "Apple's Command Line Tools are missing. Install them with `xcode-select --install`, then try again."
    );
  }
}

/** Returns the destination's real path, so it matches the paths `ps` reports. */
function checkDestination(destDir: string): string {
  if (!existsSync(destDir) || !statSync(destDir).isDirectory()) {
    throw new Error(`${destDir} does not exist. Create the folder, or choose another with --dest.`);
  }
  try {
    accessSync(destDir, fsConstants.W_OK);
  } catch (error: unknown) {
    throw new Error(
      `You can't write to ${destDir}. Use an administrator account, or install into a folder ` +
        'you own, for example --dest ~/Applications.',
      { cause: error }
    );
  }
  return realpathSync(destDir);
}

function bundleIdentifier(appPath: string): string | null {
  const result = spawnSync(
    'plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')],
    { encoding: 'utf8' }
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

function checkBuiltApp(appPath: string, skipBuild: boolean): void {
  if (!existsSync(join(appPath, MAIN_EXECUTABLE))) {
    throw new Error(
      skipBuild
        ? `No built app at ${appPath}. Run without --skip-build to build it first.`
        : `The build finished, but ${appPath} is missing or incomplete.`
    );
  }
  const identifier = bundleIdentifier(appPath);
  if (identifier !== desktopProduction.applicationId) {
    throw new Error(
      `${appPath} is not the production Snaglet app (bundle id ${identifier ?? 'unreadable'}).`
    );
  }
}

/** Replacing an app is only safe when it is Snaglet; anything else under that name stays put. */
function checkReplaceable(appPath: string): void {
  if (!existsSync(appPath)) return;
  const identifier = bundleIdentifier(appPath);
  if (identifier !== desktopProduction.applicationId) {
    throw new Error(
      `${appPath} is not Snaglet (bundle id ${identifier ?? 'unreadable'}), so it was left alone. ` +
        'Move it out of the way, or choose another folder with --dest.'
    );
  }
}

export function cleanLeftovers(paths: InstallPaths, log: (line: string) => void): void {
  const actions = leftoverActions({
    app: existsSync(paths.app),
    staging: existsSync(paths.staging),
    previous: existsSync(paths.previous),
  });
  for (const action of actions) {
    if (action === 'remove-staging') {
      log(`Removing an unfinished copy from an earlier run: ${paths.staging}`);
      rmSync(paths.staging, { recursive: true, force: true });
    } else if (action === 'restore-previous') {
      log(`Putting back the app an earlier run moved aside: ${paths.app}`);
      renameSync(paths.previous, paths.app);
    } else {
      log(`Removing the old copy an earlier run left behind: ${paths.previous}`);
      rmSync(paths.previous, { recursive: true, force: true });
    }
  }
}

export function stageCopy(sourceApp: string, staging: string): void {
  // ditto keeps the code signature and other extended attributes intact. The
  // app was built on this machine, so the copy drops any quarantine flag, which
  // would make Gatekeeper block it. ditto's --noqtn leaves the flag on a plain
  // copy, so xattr removes it.
  for (const [command, args] of [
    ['ditto', [sourceApp, staging]],
    ['xattr', ['-dr', 'com.apple.quarantine', staging]],
  ] as const) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(
        `Copying the new app failed: ${failureDetail(result)}. ` +
          'The installed app was not changed.'
      );
    }
  }
}

/** Trades the staged copy in for the installed one, then deletes the old copy. */
export function swapStaged(paths: InstallPaths, log: (line: string) => void): void {
  const hadApp = existsSync(paths.app);
  if (hadApp) renameSync(paths.app, paths.previous);
  try {
    renameSync(paths.staging, paths.app);
  } catch (error: unknown) {
    if (!hadApp) throw error;
    try {
      renameSync(paths.previous, paths.app);
    } catch (restoreError: unknown) {
      throw new Error(
        `Could not move the new app into place (${getErrorMessage(error)}) or put the old one ` +
          `back (${getErrorMessage(restoreError)}). The old app is at ${paths.previous}; ` +
          `rename it to ${APP_NAME}, or run this again to restore it.`,
        { cause: error }
      );
    }
    throw new Error(
      `Could not move the new app into place: ${getErrorMessage(error)}. The previous app is back.`,
      { cause: error }
    );
  }
  if (!hadApp) return;
  try {
    rmSync(paths.previous, { recursive: true, force: true });
  } catch (error: unknown) {
    log(
      `Installed, but the old copy at ${paths.previous} could not be deleted ` +
        `(${getErrorMessage(error)}). Delete it yourself; the next run also tries again.`
    );
  }
}

function requestQuit(): void {
  // A quit Apple Event runs the shell's normal exit, which stops the server and
  // PostgreSQL cleanly; a signal would skip that. Only one copy of Snaglet runs at a
  // time, so the bundle id reaches the copy found at the destination.
  const app = `application id "${desktopProduction.applicationId}"`;
  const result = spawnSync(
    'osascript',
    [
      '-e',
      `if ${app} is running then`,
      '-e',
      'ignoring application responses',
      '-e',
      `tell ${app} to quit`,
      '-e',
      'end ignoring',
      '-e',
      'end if',
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not ask Snaglet to quit: ${failureDetail(result)}. ` +
        'Quit Snaglet yourself, then run `pnpm install:app --skip-build`.'
    );
  }
}

async function quitRunningCopy(appPath: string, log: (line: string) => void): Promise<void> {
  let running = bundleProcesses(readProcessTable(), appPath);
  if (running.length === 0) return;
  const describe = (entries: readonly ProcessEntry[]): string =>
    entries
      .map((entry) => {
        const executable = entry.command.slice(appPath.length + 1).split(' ')[0];
        return `${basename(executable)} (pid ${String(entry.pid)})`;
      })
      .join(', ');
  if (!running.some((entry) => entry.command.startsWith(join(appPath, MAIN_EXECUTABLE)))) {
    throw new Error(
      `Programs from ${appPath} are running without Snaglet itself: ${describe(running)}. ` +
        'Stop them, then run `pnpm install:app --skip-build`.'
    );
  }
  log(
    'Snaglet is running from the destination. Asking it to quit; it stops its server and database first.'
  );
  requestQuit();
  const deadline = Date.now() + QUIT_TIMEOUT_MS;
  while (running.length > 0) {
    if (Date.now() > deadline) {
      throw new Error(
        `Snaglet did not quit within ${String(QUIT_TIMEOUT_MS / 1000)} seconds, so nothing was ` +
          `replaced. Still running: ${describe(running)}. Quit Snaglet from its menu, then run ` +
          '`pnpm install:app --skip-build`.'
      );
    }
    await sleep(1_000);
    running = bundleProcesses(readProcessTable(), appPath);
  }
  log('Snaglet quit.');
}

function runBuild(repoRoot: string): void {
  const result = crossSpawn.sync('pnpm', ['run', 'build:desktop'], {
    cwd: repoRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error)
    throw new Error('Could not start `pnpm build:desktop`', { cause: result.error });
  if (result.status !== 0) {
    throw new Error(
      `\`pnpm build:desktop\` failed with status ${String(result.status ?? 'unknown')}. Nothing was installed.`
    );
  }
}

function launchApp(appPath: string, log: (line: string) => void): void {
  const others = otherRunningCopies(readProcessTable(), appPath);
  if (others.length > 0) {
    log(
      `Not opening Snaglet: another copy is running from ${others.join(', ')}, and only one copy runs ` +
        `at a time. Quit it, then open ${appPath}.`
    );
    return;
  }
  const result = spawnSync('open', [appPath], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Installed ${appPath}, but could not open it: ${failureDetail(result)}`);
  }
  log(`Opened ${appPath}.`);
}

export interface InstallAppContext {
  repoRoot: string;
  platform: NodeJS.Platform;
  /** The app to install; defaults to the one `pnpm build:desktop` writes. */
  sourceApp?: string;
  log: (line: string) => void;
}

export async function runInstallApp(
  options: InstallAppOptions,
  context: InstallAppContext
): Promise<void> {
  const { repoRoot, platform, log } = context;
  const artifacts = builtArtifacts(repoRoot);
  const sourceApp = context.sourceApp ?? artifacts.macApp;
  let destDir = options.destDir;

  for (const step of planInstall(platform, options)) {
    if (step === 'check') {
      if (platform === 'darwin') {
        destDir = checkDestination(options.destDir);
        if (runsInside(readProcessTable(), process.pid, installPaths(destDir).app)) {
          throw new Error(
            `This terminal runs inside the Snaglet app at ${installPaths(destDir).app}, and quitting Snaglet ` +
              'would stop the installer too. Run it from a separate terminal app.'
          );
        }
        checkReplaceable(installPaths(destDir).app);
        if (options.skipBuild) checkBuiltApp(sourceApp, true);
      } else if (options.destDir !== DEFAULT_DEST || !options.launch) {
        log('--dest and --no-launch apply on macOS only.');
      }
      if (!options.skipBuild) checkToolchain(platform);
    } else if (step === 'build') {
      log('Building the desktop app with `pnpm build:desktop`. The first build takes a while.');
      runBuild(repoRoot);
    } else if (step === 'install') {
      checkBuiltApp(sourceApp, options.skipBuild);
      const paths = installPaths(destDir);
      cleanLeftovers(paths, log);
      log(`Copying ${sourceApp} into ${destDir}`);
      stageCopy(sourceApp, paths.staging);
      try {
        await quitRunningCopy(paths.app, log);
      } catch (error: unknown) {
        rmSync(paths.staging, { recursive: true, force: true });
        throw error;
      }
      swapStaged(paths, log);
      log(`Installed ${paths.app}`);
    } else if (step === 'launch') {
      launchApp(installPaths(destDir).app, log);
    } else {
      const files = existsSync(artifacts.dir) ? readdirSync(artifacts.dir) : [];
      for (const line of installerInstructions(platform, artifacts.dir, files)) log(line);
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === SCRIPT_PATH) {
  try {
    // pnpm runs scripts from the repo root; INIT_CWD is where it was typed.
    const options = parseInstallAppArgs(
      process.argv.slice(2),
      process.env.INIT_CWD ?? process.cwd()
    );
    if (options.help) console.log(usage());
    else {
      await runInstallApp(options, {
        repoRoot: REPO_ROOT,
        platform: process.platform,
        log: (line) => console.log(`[install-app] ${line}`),
      });
    }
  } catch (error: unknown) {
    console.error(`[install-app] ${getErrorMessage(error)}`);
    process.exitCode = 1;
  }
}
