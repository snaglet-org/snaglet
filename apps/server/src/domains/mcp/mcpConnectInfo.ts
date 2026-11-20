/**
 * What an external MCP client needs to reach THIS Snaglet, for
 * the Settings pane's ready-to-paste setup: the home, whether it is the
 * default one, production or dev, the `snaglet` command that runs the CLI for this
 * home, and the port. Served by GET /api/mcp-keys/connect-info behind the app
 * session (never the MCP key). No secret is ever part of it.
 *
 * Finding the CLI. The Snaglet-managed launcher (Settings → Command line,
 * apps/desktop/src-tauri/src/cli_install.rs) exports the SNAGLET_HOME of the app
 * that installed it, overriding any SNAGLET_HOME a client passes, so a launcher
 * for another home (the installed app's, seen from a dev server) cannot reach
 * this one. In order:
 *  1. `snaglet` on the user's PATH (the login-shell PATH), when it is this home's
 *     launcher, or the Snaglet CLI itself (which honors SNAGLET_HOME);
 *  2. the launcher at its install path, when it is this home's;
 *  3. on a dev server, this checkout's `packages/snaglet-cli/bin/snaglet.mjs`.
 */
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveSnagletEnvMode } from '@snaglet/db/runtime/snaglet-env';
import type { McpConnectInfo } from '@snaglet/shared/types';
import { serverConfig } from '@server/config';
import { SNAGLET_HOME } from '@server/services/snagletHome';
import { shellPath } from '@server/services/ToolService/lib/loginShellPath';

/** The launcher's marker line (cli_install.rs LAUNCHER_MARKER). */
const LAUNCHER_MARKER = 'Snaglet CLI launcher — managed by Snaglet Desktop';
/** A line of the Snaglet CLI's own usage text (packages/snaglet-cli/bin/snaglet.mjs). */
const CLI_MARKER = 'snaglet mcp bridges a stdio MCP client';
/** Enough of a launcher or the CLI script to find its markers. */
const READ_LIMIT = 64 * 1024;
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '[::]']);
/** This module's checkout: apps/server/src/domains/mcp → the repository root. */
const REPO_CLI = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/snaglet-cli/bin/snaglet.mjs'
);

interface ConnectInfoInputs {
  snagletHome: string;
  userHome: string;
  /** The user's PATH (the login-shell PATH once resolved). */
  pathValue: string | undefined;
  platform: NodeJS.Platform;
  /** The packaged app's server (SNAGLET_BUNDLED=1). */
  bundled: boolean;
  /** SNAGLET_ENV: dev and preview are dev servers. */
  envMode: string | null;
  port: number;
  bindHost: string;
  /** Windows: %LOCALAPPDATA%. */
  localAppData: string | undefined;
  repoCli: string;
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function readHead(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').slice(0, READ_LIMIT);
  } catch {
    return null;
  }
}

/** The SNAGLET_HOME a launcher exports, or null when it names none. */
function launcherHome(body: string): string | null {
  const posix = /^export SNAGLET_HOME='((?:[^']|'\\'')*)'$/m.exec(body);
  if (posix) return posix[1].replace(/'\\''/g, "'");
  const windows = /^set "SNAGLET_HOME=(.*)"\r?$/m.exec(body);
  return windows ? windows[1].replace(/%%/g, '%') : null;
}

/** Whether running `file` reaches the Snaglet CLI for `snagletHome`. */
function runsCliFor(file: string, snagletHome: string): boolean {
  const body = readHead(file);
  if (body === null) return false;
  if (body.includes(LAUNCHER_MARKER)) {
    const home = launcherHome(body);
    return home !== null && canonical(home) === canonical(snagletHome);
  }
  return body.includes(CLI_MARKER);
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first `snaglet` on `pathValue`, as a shell would run it. */
function snagletOnPath(inputs: ConnectInfoInputs): string | null {
  if (!inputs.pathValue) return null;
  const names =
    inputs.platform === 'win32' ? ['snaglet.cmd', 'snaglet.exe', 'snaglet.bat'] : ['snaglet'];
  const separator = inputs.platform === 'win32' ? ';' : ':';
  for (const dir of inputs.pathValue.split(separator)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate, inputs.platform)) return candidate;
    }
  }
  return null;
}

/** Where Settings → Command line installs the launcher. */
function launcherInstallPath(inputs: ConnectInfoInputs): string {
  if (inputs.platform === 'win32') {
    const base = inputs.localAppData ?? path.join(inputs.userHome, 'AppData', 'Local');
    return path.join(base, 'Snaglet', 'bin', 'snaglet.cmd');
  }
  return path.join(inputs.userHome, '.local', 'bin', 'snaglet');
}

function currentInputs(): ConnectInfoInputs {
  return {
    snagletHome: SNAGLET_HOME,
    userHome: homedir(),
    pathValue: shellPath(),
    platform: process.platform,
    bundled: process.env.SNAGLET_BUNDLED === '1',
    envMode: resolveSnagletEnvMode(),
    port: serverConfig.port,
    bindHost: process.env.SNAGLET_BIND_HOST?.trim() ?? '',
    localAppData: process.env.LOCALAPPDATA,
    repoCli: REPO_CLI,
  };
}

/** This Snaglet's connect info; `overrides` replace the environment's values (tests). */
export function mcpConnectInfo(overrides: Partial<ConnectInfoInputs> = {}): McpConnectInfo {
  const inputs: ConnectInfoInputs = { ...currentInputs(), ...overrides };
  const snagletHome = path.resolve(inputs.snagletHome);
  const dev = !inputs.bundled || inputs.envMode === 'dev' || inputs.envMode === 'preview';

  const onPath = snagletOnPath(inputs);
  const cliOnPath = onPath !== null && runsCliFor(onPath, snagletHome);
  let cliPath: string | null = cliOnPath ? onPath : null;
  if (cliPath === null) {
    const launcher = launcherInstallPath(inputs);
    if (isExecutableFile(launcher, inputs.platform) && runsCliFor(launcher, snagletHome))
      cliPath = launcher;
  }
  if (cliPath === null && !inputs.bundled && isExecutableFile(inputs.repoCli, inputs.platform))
    cliPath = inputs.repoCli;

  const host = WILDCARD_HOSTS.has(inputs.bindHost) ? '127.0.0.1' : inputs.bindHost;
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return {
    snagletHome,
    isDefaultHome: canonical(snagletHome) === canonical(path.join(inputs.userHome, '.snaglet')),
    profile: dev ? 'dev' : 'production',
    cliPath,
    cliOnPath,
    port: inputs.port,
    mcpUrl: `http://${urlHost}:${inputs.port}/mcp`,
  };
}
