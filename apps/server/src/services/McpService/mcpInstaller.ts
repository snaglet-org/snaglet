/**
 * mcpInstaller — "install once" for MCP servers configured as
 * `npx [-y] <pkg>[@ver] [args…]`.
 *
 * Instead of letting npx resolve (and wrap in an `npm exec` process) the
 * package on every start, Snaglet installs it one time into its own folder and
 * starts the package's bin directly with `node`:
 *
 *   <SNAGLET_HOME>/mcp/<serverId>/
 *     install.json     what is installed (package, requested + installed
 *                      version, when) and the last install error. No env,
 *                      no args, no headers: nothing that can hold a secret.
 *     pkg-<stamp>/     the npm prefix of the live copy (package.json,
 *                      package-lock.json, node_modules/). An Update installs
 *                      into a new pkg-<stamp>/ and the previous one is
 *                      removed once nothing runs from it.
 *
 * The folder name comes from the server id alone (validated, and checked to
 * stay under the root); the package spec only ever travels as one argv entry
 * to npm, never through a shell and never into a path.
 *
 * Fallback: when the command isn't a plain registry package, npm is missing,
 * the install fails, or the package's bin can't be started with node, the
 * server runs through npx with its configured command exactly as written —
 * the same package and version as before, never a substitute — and the
 * reason is recorded for the MCP pane.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, type Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import { logger } from '@server/config/logger';
import { shellPath } from '@server/services/ToolService/lib/loginShellPath';
import type { McpServerConfig } from './mcpTypes';
import {
  installSpecOf,
  isInside,
  parseNpxCommand,
  resolveInstalledBin,
  sameVersion,
  type NpxPackageLaunch,
} from './mcpNpx';

/** A first install or an Update gives up (and the server runs through npx) after this long. */
const MCP_INSTALL_TIMEOUT_MS = 5 * 60_000;
/** After a failed install (network, registry, npm error) a start retries it only after this long. */
const INSTALL_RETRY_MS = 60 * 60_000;
/** After an install whose package can't be started with node, a start retries only after this long. */
const UNUSABLE_RETRY_MS = 24 * 60 * 60_000;

const SERVER_ID_RE = /^[A-Za-z0-9_-]+$/;
const PREFIX_DIR_RE = /^pkg-[A-Za-z0-9-]+$/;
const RECORD_FILE = 'install.json';
const NOT_INSTALLED = 'not installed yet';
const WINDOWS_REASON = "install-once isn't supported on Windows yet";

/** What is installed for one server. Persisted as install.json; never holds env, args or headers. */
interface McpInstallRecord {
  schema: 1;
  packageName: string;
  /** The version/range/tag the command asked for when it was installed; null = latest. */
  requested: string | null;
  installedVersion: string | null;
  installedAt: string | null;
  /** The pkg-<stamp> folder holding the live copy. */
  dir: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** `<name>@<requested|latest>` the last failed attempt was for. */
  lastErrorSpec: string | null;
  /** A start retries a failed install only after this time; Update always tries. */
  retryAfter: string | null;
  /**
   * The installed version that failed to start while the configured npx
   * command worked: starts use npx until retryAfter or a new install.
   */
  setAsideVersion: string | null;
}

/** How McpService starts a stdio server. */
export type McpLaunchPlan =
  /** Not an npx command: run the configured command as written. */
  | { mode: 'configured' }
  /** An npx command Snaglet doesn't (or couldn't) install: run it as written, for this reason. */
  | { mode: 'npx'; reason: string }
  /** Start Snaglet's installed copy with node. */
  | { mode: 'direct'; command: string; args: string[]; binDir: string; version: string };

/** The MCP pane's view of a server's install. Null for servers that don't use npx. */
export interface McpInstallInfo {
  /**
   * installed: starts from Snaglet's copy with node · pending: installs on its next
   * start · installing: an install is running · npx: runs through npx (reason).
   */
  state: 'installed' | 'pending' | 'installing' | 'npx';
  packageName: string | null;
  requested: string | null;
  installedVersion: string | null;
  installedAt: string | null;
  reason: string | null;
  /** The last install error for the configured package, even while an older copy still runs. */
  lastError: string | null;
  /** Whether Update can install this server's package. */
  updatable: boolean;
}

type McpInstallOutcome =
  | { ok: true; version: string; previousVersion: string | null }
  | { ok: false; reason: string; previousVersion: string | null };

interface NpmRunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

type NpmRunResult = { ok: true } | { ok: false; notFound: boolean; message: string };

/** Runs npm. Injectable so tests never reach a registry. */
type NpmRunner = (command: string, args: string[], opts: NpmRunOptions) => Promise<NpmRunResult>;

interface McpInstallerOptions {
  /** The install root; defaults to `<SNAGLET_HOME>/mcp`. */
  root?: string;
  runNpm?: NpmRunner;
  platform?: NodeJS.Platform;
  now?: () => number;
}

type InstalledCheck =
  | { ok: true; plan: Extract<McpLaunchPlan, { mode: 'direct' }> }
  | { ok: false; reason: string };

/** Credentials in URLs or npmrc-style lines never reach a reason or a log. */
function redactCredentials(text: string): string {
  return text
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***@')
    .replace(/(_auth(?:Token)?\s*[=:]\s*)\S+/gi, '$1***');
}

/** npm's own error lines, short enough for the MCP pane. */
function summarizeNpmOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLines = lines
    .filter((line) => /^npm (?:error|ERR!)/.test(line))
    .map((line) => line.replace(/^npm (?:error|ERR!)\s*/, ''))
    .filter((line) => line && !/complete log of this run|^\S*\.log$/i.test(line));
  const picked = (errorLines.length > 0 ? errorLines : lines).slice(0, 3);
  return redactCredentials(picked.join(' — ')).slice(0, 300);
}

/**
 * The env npm runs with: what the SDK's stdio transport gives npx (HOME,
 * PATH, SHELL, USER…) with the same PATH a server gets. The server's own env
 * is left out: it can hold credentials, and npm needs none of it.
 */
function npmInstallEnv(config: Pick<McpServerConfig, 'env'>): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  const configured = config.env.PATH;
  const pathValue = configured && !configured.includes('${') ? configured : shellPath();
  if (pathValue) env.PATH = pathValue;
  return env;
}

/** The npm that belongs to the configured npx: its sibling for an absolute path, else PATH's. */
function npmCommandFor(npxCommand: string | null): string {
  if (npxCommand && path.isAbsolute(npxCommand)) {
    const sibling = path.join(path.dirname(npxCommand), 'npm');
    if (existsSync(sibling)) return sibling;
  }
  return 'npm';
}

const runNpmProcess: NpmRunner = (command, args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve({ ok: true });
          return;
        }
        const failure = err as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === 'ENOENT') {
          resolve({ ok: false, notFound: true, message: "npm wasn't found on PATH" });
          return;
        }
        if (failure.killed) {
          resolve({
            ok: false,
            notFound: false,
            message: `npm install timed out after ${Math.round(timeoutMs / 60_000)} min`,
          });
          return;
        }
        const summary = summarizeNpmOutput(String(stderr ?? ''));
        resolve({ ok: false, notFound: false, message: summary || getErrorMessage(err) });
      }
    );
  });

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function asRecord(value: unknown): McpInstallRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (r.schema !== 1 || typeof r.packageName !== 'string') return null;
  const nullable = [
    'requested',
    'installedVersion',
    'installedAt',
    'dir',
    'lastError',
    'lastErrorAt',
    'lastErrorSpec',
    'retryAfter',
    'setAsideVersion',
  ] as const;
  if (!nullable.every((key) => isStringOrNull(r[key] ?? null))) return null;
  const dir = (r.dir as string | null | undefined) ?? null;
  return {
    schema: 1,
    packageName: r.packageName,
    requested: (r.requested as string | null | undefined) ?? null,
    installedVersion: (r.installedVersion as string | null | undefined) ?? null,
    installedAt: (r.installedAt as string | null | undefined) ?? null,
    dir: dir !== null && PREFIX_DIR_RE.test(dir) ? dir : null,
    lastError: (r.lastError as string | null | undefined) ?? null,
    lastErrorAt: (r.lastErrorAt as string | null | undefined) ?? null,
    lastErrorSpec: (r.lastErrorSpec as string | null | undefined) ?? null,
    retryAfter: (r.retryAfter as string | null | undefined) ?? null,
    setAsideVersion: (r.setAsideVersion as string | null | undefined) ?? null,
  };
}

function emptyRecord(launch: NpxPackageLaunch): McpInstallRecord {
  return {
    schema: 1,
    packageName: launch.packageName,
    requested: launch.requested,
    installedVersion: null,
    installedAt: null,
    dir: null,
    lastError: null,
    lastErrorAt: null,
    lastErrorSpec: null,
    retryAfter: null,
    setAsideVersion: null,
  };
}

/** Versions come from a third-party manifest: keep them plain in reasons. */
function displayVersion(version: string): string {
  return version.replace(/[^\w.+-]/g, '').slice(0, 40);
}

async function removeQuietly(target: string): Promise<void> {
  try {
    await rm(target, { recursive: true, force: true });
  } catch (err: unknown) {
    logger.warn(`[McpService] Couldn't remove ${target}: ${getErrorMessage(err)}`);
  }
}

export class McpInstaller {
  private readonly rootDir: () => Promise<string>;
  private readonly runNpm: NpmRunner;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  /** One install at a time per server; later callers share its outcome. */
  private readonly inflight = new Map<string, Promise<McpInstallOutcome>>();
  private readonly records = new Map<string, McpInstallRecord | null>();

  constructor(opts: McpInstallerOptions = {}) {
    const { root } = opts;
    // SNAGLET_HOME is resolved on first use, so loading McpService stays free of
    // the home module's imports (tests and tools that never install).
    this.rootDir = root
      ? async () => root
      : async () => path.join((await import('@server/services/snagletHome')).SNAGLET_HOME, 'mcp');
    this.runNpm = opts.runNpm ?? runNpmProcess;
    this.platform = opts.platform ?? process.platform;
    this.now = opts.now ?? Date.now;
  }

  /**
   * A server's install folder, `<root>/<serverId>`, derived from the id alone.
   * Throws for an id that isn't plain letters, digits, `-` and `_`, or whose
   * folder would land anywhere but directly under the root.
   */
  async serverDir(serverId: string): Promise<string> {
    if (!SERVER_ID_RE.test(serverId)) {
      throw new Error('unsafe server id for an install folder');
    }
    const root = path.resolve(await this.rootDir());
    const dir = path.resolve(root, serverId);
    if (path.dirname(dir) !== root) throw new Error('unsafe server id for an install folder');
    return dir;
  }

  private async readRecord(serverId: string): Promise<McpInstallRecord | null> {
    if (this.records.has(serverId)) return this.records.get(serverId) ?? null;
    let record: McpInstallRecord | null = null;
    try {
      const text = await readFile(path.join(await this.serverDir(serverId), RECORD_FILE), 'utf8');
      record = asRecord(safeJsonParse<unknown>(text, null));
    } catch {
      record = null;
    }
    this.records.set(serverId, record);
    return record;
  }

  private async writeRecord(serverId: string, record: McpInstallRecord): Promise<void> {
    const dir = await this.serverDir(serverId);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, RECORD_FILE);
    const tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tmp, file);
    this.records.set(serverId, record);
  }

  private packageDir(prefix: string, packageName: string): string {
    const dir = path.join(prefix, 'node_modules', ...packageName.split('/'));
    if (!isInside(prefix, dir)) throw new Error('package path leaves its install folder');
    return dir;
  }

  /**
   * The installed copy for this launch, checked against install.json: same
   * package, same requested version, and the package.json on disk reports the
   * recorded installed version. Any mismatch means "not usable" — a start
   * then reinstalls rather than run a copy that isn't the recorded one.
   */
  private async installedLaunch(
    serverId: string,
    launch: NpxPackageLaunch
  ): Promise<InstalledCheck> {
    const record = await this.readRecord(serverId);
    if (!record?.installedVersion || !record.dir) return { ok: false, reason: NOT_INSTALLED };
    if (record.packageName !== launch.packageName || record.requested !== launch.requested) {
      return { ok: false, reason: 'the installed copy is for a different package or version' };
    }
    const prefix = path.join(await this.serverDir(serverId), record.dir);
    const bin = await resolveInstalledBin(
      this.packageDir(prefix, launch.packageName),
      launch.packageName
    );
    if (!bin.ok) return bin;
    if (!sameVersion(bin.bin.version, record.installedVersion)) {
      return {
        ok: false,
        reason:
          `the installed copy reports ${displayVersion(bin.bin.version)}, ` +
          `not the recorded ${displayVersion(record.installedVersion)}`,
      };
    }
    return {
      ok: true,
      plan: {
        mode: 'direct',
        command: 'node',
        args: [...bin.bin.nodeArgs, bin.bin.file, ...launch.serverArgs],
        binDir: path.join(prefix, 'node_modules', '.bin'),
        version: record.installedVersion,
      },
    };
  }

  private inRetryWait(record: McpInstallRecord | null, launch: NpxPackageLaunch): boolean {
    if (!record?.retryAfter || record.lastErrorSpec !== installSpecOf(launch)) return false;
    return this.now() < Date.parse(record.retryAfter);
  }

  /** The usable copy `version` was set aside after it failed to start (setAside). */
  private isSetAside(
    record: McpInstallRecord | null,
    launch: NpxPackageLaunch,
    version: string
  ): boolean {
    return record?.setAsideVersion === version && this.inRetryWait(record, launch);
  }

  /**
   * How to start this server. With `install`, an npx server with no usable
   * copy is installed first (sharing any install already running), unless an
   * install of the same spec failed recently. Never throws: anything that
   * goes wrong means "run the configured command as written".
   */
  async launchFor(config: McpServerConfig, opts: { install: boolean }): Promise<McpLaunchPlan> {
    const parsed = parseNpxCommand(config.command, config.args);
    if (parsed.kind === 'not-npx') return { mode: 'configured' };
    if (parsed.kind === 'unsupported') return { mode: 'npx', reason: parsed.reason };
    if (this.platform === 'win32') return { mode: 'npx', reason: WINDOWS_REASON };
    const { launch } = parsed;
    try {
      const current = await this.installedLaunch(config.id, launch);
      const record = await this.readRecord(config.id);
      if (current.ok) {
        if (!this.isSetAside(record, launch, current.plan.version)) return current.plan;
        return { mode: 'npx', reason: record?.lastError ?? "the installed copy didn't start" };
      }
      if (!opts.install) return { mode: 'npx', reason: current.reason };
      if (this.inRetryWait(record, launch)) {
        return { mode: 'npx', reason: record?.lastError ?? 'the last install failed' };
      }
      const outcome = await this.install(config, launch);
      if (!outcome.ok) return { mode: 'npx', reason: outcome.reason };
      const installed = await this.installedLaunch(config.id, launch);
      return installed.ok ? installed.plan : { mode: 'npx', reason: installed.reason };
    } catch (err: unknown) {
      return { mode: 'npx', reason: getErrorMessage(err) };
    }
  }

  /**
   * Background install after a server is created or its command changes, so
   * its first start doesn't wait on npm. Does nothing for a server that
   * isn't npx, already has a usable copy, or failed the same install recently.
   */
  async ensureInstalled(config: McpServerConfig): Promise<void> {
    const parsed = parseNpxCommand(config.command, config.args);
    if (parsed.kind !== 'npx' || this.platform === 'win32') return;
    try {
      if ((await this.installedLaunch(config.id, parsed.launch)).ok) return;
      if (this.inRetryWait(await this.readRecord(config.id), parsed.launch)) return;
      await this.install(config, parsed.launch);
    } catch (err: unknown) {
      logger.warn(
        `[McpService] Background install for ${config.id} failed: ${getErrorMessage(err)}`
      );
    }
  }

  /** The server's npx package, or why it has none Snaglet can install. */
  packageFor(
    config: McpServerConfig
  ): { ok: true; launch: NpxPackageLaunch } | { ok: false; reason: string } {
    const parsed = parseNpxCommand(config.command, config.args);
    if (parsed.kind === 'not-npx')
      return { ok: false, reason: "this server isn't started with npx" };
    if (parsed.kind === 'unsupported') return { ok: false, reason: parsed.reason };
    if (this.platform === 'win32') return { ok: false, reason: WINDOWS_REASON };
    return { ok: true, launch: parsed.launch };
  }

  /**
   * Install the package (the pinned version, else the latest) into a fresh
   * pkg-<stamp>/ and record it. With `keepOld`, earlier copies stay until
   * pruneOld — Update keeps the running server's copy until it has stopped.
   * Single-flight per server. Never rejects.
   */
  install(
    config: McpServerConfig,
    launch: NpxPackageLaunch,
    opts: { keepOld?: boolean } = {}
  ): Promise<McpInstallOutcome> {
    const running = this.inflight.get(config.id);
    if (running) return running;
    const attempt = this.runInstall(config, launch, opts.keepOld === true).catch((err: unknown) =>
      this.fail(config.id, launch, getErrorMessage(err), INSTALL_RETRY_MS)
    );
    this.inflight.set(config.id, attempt);
    void attempt.finally(() => {
      if (this.inflight.get(config.id) === attempt) this.inflight.delete(config.id);
    });
    return attempt;
  }

  private async runInstall(
    config: McpServerConfig,
    launch: NpxPackageLaunch,
    keepOld: boolean
  ): Promise<McpInstallOutcome> {
    const previousVersion = (await this.readRecord(config.id))?.installedVersion ?? null;
    const spec = installSpecOf(launch);
    const serverDir = await this.serverDir(config.id);
    await mkdir(serverDir, { recursive: true });
    const dirName = `pkg-${this.now()}-${randomBytes(3).toString('hex')}`;
    const prefix = path.join(serverDir, dirName);
    await mkdir(prefix);
    // Our own manifest, so npm treats the folder as its project root.
    await writeFile(
      path.join(prefix, 'package.json'),
      `${JSON.stringify({ private: true, description: 'Installed by Snaglet for an MCP server.' }, null, 2)}\n`
    );

    logger.info(`[McpService] Installing ${spec} for ${config.id}`);
    // The package's install scripts run, exactly as they do when npx installs
    // it today: install-once must start the same program npx would, and some
    // servers need their postinstall (native builds, downloads). There is no
    // --ignore-scripts here on purpose.
    const result = await this.runNpm(
      npmCommandFor(config.command),
      ['install', '--prefix', prefix, spec, '--no-audit', '--no-fund', '--omit=dev'],
      { cwd: prefix, env: npmInstallEnv(config), timeoutMs: MCP_INSTALL_TIMEOUT_MS }
    );
    if (!result.ok) {
      await removeQuietly(prefix);
      const reason = result.notFound ? result.message : `install failed: ${result.message}`;
      return this.fail(config.id, launch, reason, INSTALL_RETRY_MS);
    }

    const bin = await resolveInstalledBin(
      this.packageDir(prefix, launch.packageName),
      launch.packageName
    );
    if (!bin.ok) {
      await removeQuietly(prefix);
      return this.fail(config.id, launch, bin.reason, UNUSABLE_RETRY_MS);
    }
    const version = bin.bin.version;
    if (launch.exact && launch.requested && !sameVersion(version, launch.requested)) {
      await removeQuietly(prefix);
      return this.fail(
        config.id,
        launch,
        `npm installed ${displayVersion(version)}, not the pinned ${displayVersion(launch.requested)}`,
        UNUSABLE_RETRY_MS
      );
    }

    await this.writeRecord(config.id, {
      ...emptyRecord(launch),
      installedVersion: version,
      installedAt: new Date(this.now()).toISOString(),
      dir: dirName,
    });
    if (!keepOld) await this.pruneCopies(config.id);
    logger.info(
      `[McpService] Installed ${launch.packageName}@${displayVersion(version)} for ${config.id}`
    );
    return { ok: true, version, previousVersion };
  }

  /** Record a failed install; an older working copy, if any, stays recorded and usable. */
  private async fail(
    serverId: string,
    launch: NpxPackageLaunch,
    reason: string,
    retryMs: number
  ): Promise<McpInstallOutcome> {
    const spec = installSpecOf(launch);
    logger.warn(`[McpService] Install of ${spec} for ${serverId} failed: ${reason}`);
    let previous: McpInstallRecord | null = null;
    try {
      previous = await this.readRecord(serverId);
      const now = this.now();
      await this.writeRecord(serverId, {
        ...(previous ?? emptyRecord(launch)),
        lastError: reason,
        lastErrorAt: new Date(now).toISOString(),
        lastErrorSpec: spec,
        retryAfter: new Date(now + retryMs).toISOString(),
      });
    } catch (err: unknown) {
      logger.warn(
        `[McpService] Couldn't record the install error for ${serverId}: ${getErrorMessage(err)}`
      );
    }
    return { ok: false, reason, previousVersion: previous?.installedVersion ?? null };
  }

  /**
   * The installed copy (`version`) failed to start but the configured npx
   * command started: run through npx — and say why in the pane — until a new
   * install (Update, a changed command) or UNUSABLE_RETRY_MS passes. A start
   * must never fail where npx works. Never throws.
   */
  async setAside(config: McpServerConfig, version: string, reason: string): Promise<void> {
    const parsed = parseNpxCommand(config.command, config.args);
    if (parsed.kind !== 'npx') return;
    try {
      const record = await this.readRecord(config.id);
      if (!record || record.installedVersion !== version) return;
      const now = this.now();
      await this.writeRecord(config.id, {
        ...record,
        setAsideVersion: version,
        lastError: reason,
        lastErrorAt: new Date(now).toISOString(),
        lastErrorSpec: installSpecOf(parsed.launch),
        retryAfter: new Date(now + UNUSABLE_RETRY_MS).toISOString(),
      });
      logger.warn(`[McpService] ${config.id} runs through npx for now: ${reason}`);
    } catch (err: unknown) {
      logger.warn(
        `[McpService] Couldn't record that ${config.id}'s install failed: ${getErrorMessage(err)}`
      );
    }
  }

  /**
   * Remove every copy but the recorded one (and stray temp files) — after an
   * Update has stopped the server that ran the previous copy. Skipped while an
   * install for the server runs: that install prunes when it finishes.
   */
  async pruneOld(serverId: string): Promise<void> {
    if (this.inflight.has(serverId)) return;
    await this.pruneCopies(serverId);
  }

  private async pruneCopies(serverId: string): Promise<void> {
    const record = await this.readRecord(serverId);
    const dir = await this.serverDir(serverId);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === record?.dir) continue;
      if (PREFIX_DIR_RE.test(name) || name.endsWith('.tmp'))
        await removeQuietly(path.join(dir, name));
    }
  }

  /** Delete a server's whole install folder (once its delete is past undo). */
  async remove(serverId: string): Promise<void> {
    await this.inflight.get(serverId);
    const dir = await this.serverDir(serverId);
    await rm(dir, { recursive: true, force: true });
    this.records.delete(serverId);
    logger.info(`[McpService] Removed the install folder for ${serverId}`);
  }

  /**
   * Remove install folders of servers that don't exist. Run once at boot:
   * a delete's undo snapshot lives in memory, so after a restart nothing can
   * bring those servers back.
   */
  async pruneOrphans(knownIds: ReadonlySet<string>): Promise<void> {
    let entries: Dirent[];
    let root: string;
    try {
      root = path.resolve(await this.rootDir());
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SERVER_ID_RE.test(entry.name)) continue;
      if (knownIds.has(entry.name) || this.inflight.has(entry.name)) continue;
      await removeQuietly(path.join(root, entry.name));
      this.records.delete(entry.name);
      logger.info(`[McpService] Removed the install folder of deleted server ${entry.name}`);
    }
  }

  /** The MCP pane's install line for a server; null when it doesn't use npx. */
  async describe(config: McpServerConfig): Promise<McpInstallInfo | null> {
    if (config.transport !== 'stdio') return null;
    const parsed = parseNpxCommand(config.command, config.args);
    if (parsed.kind === 'not-npx') return null;
    const none = {
      packageName: null,
      requested: null,
      installedVersion: null,
      installedAt: null,
      lastError: null,
    };
    if (parsed.kind === 'unsupported') {
      return { ...none, state: 'npx', reason: parsed.reason, updatable: false };
    }
    const { launch } = parsed;
    const base = { packageName: launch.packageName, requested: launch.requested };
    if (this.platform === 'win32') {
      return { ...none, ...base, state: 'npx', reason: WINDOWS_REASON, updatable: false };
    }
    try {
      const record = await this.readRecord(config.id);
      const current = await this.installedLaunch(config.id, launch);
      const lastError = record?.lastErrorSpec === installSpecOf(launch) ? record.lastError : null;
      const installed = current.ok
        ? { installedVersion: current.plan.version, installedAt: record?.installedAt ?? null }
        : { installedVersion: null, installedAt: null };
      const info = { ...base, ...installed, lastError, updatable: true };
      if (this.inflight.has(config.id)) return { ...info, state: 'installing', reason: null };
      if (current.ok && this.isSetAside(record, launch, current.plan.version)) {
        return { ...info, state: 'npx', reason: lastError };
      }
      if (current.ok) return { ...info, state: 'installed', reason: null };
      if (lastError) return { ...info, state: 'npx', reason: lastError };
      return {
        ...info,
        state: 'pending',
        reason: current.reason === NOT_INSTALLED ? null : current.reason,
      };
    } catch (err: unknown) {
      return { ...none, ...base, state: 'npx', reason: getErrorMessage(err), updatable: false };
    }
  }
}
