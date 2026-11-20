/**
 * mcpNpx — recognize a stdio server configured as `npx [-y] <pkg>[@ver] [args…]`
 * and work out how to start an installed copy of that package with `node`.
 *
 * The parsing half is pure. The bin half only reads the installed package's
 * own files (its package.json and the head of its bin file). Nothing here
 * spawns anything or touches the server's env/args beyond splitting them.
 *
 * The rules mirror what npx itself does (libnpmexec), so a server started
 * from Snaglet's install runs the same program npx would have run:
 *   - the package is the first argument after npx's own options;
 *   - its bin is the package's only bin, or the one named after the package
 *     (scope dropped); several bins with none matching is ambiguous.
 */

import { open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { safeJsonParse } from '@snaglet/shared/utils';

/** An npx launch Snaglet can install once and start directly. */
export interface NpxPackageLaunch {
  /** Registry package name, e.g. `@modelcontextprotocol/server-github`. */
  packageName: string;
  /** Version, range or dist-tag written in the command; null when unpinned (or `@latest`). */
  requested: string | null;
  /** True when `requested` names one exact version (`1.2.3`). */
  exact: boolean;
  /** Arguments after the package — passed to the server unchanged. */
  serverArgs: string[];
}

type NpxCommand =
  | { kind: 'not-npx' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'npx'; launch: NpxPackageLaunch };

/** npx options that change nothing about which package runs or how. */
const PASSIVE_NPX_FLAGS = new Set(['-y', '--yes', '-q', '--quiet', '--silent']);

/**
 * npm package names: lowercase, optional `@scope/`, no leading dot or
 * underscore, no path separators beyond the scope's one slash. This (with the
 * tarball check below) is what keeps URLs, git specs, `file:` specs, local
 * paths and tarballs out of install-once: none of them can match.
 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const TARBALL_RE = /\.(?:tgz|tar|tar\.gz)$/i;
const MAX_PACKAGE_NAME = 214;
/** A semver version, range (`^1.2`, `>=1 <2`, `1.x`) or dist-tag (`next`). No `:`, `/`, `@`, `#`. */
const VERSION_SPEC_RE = /^[A-Za-z0-9.^~<>=|*+ _-]+$/;
const MAX_VERSION_SPEC = 100;
const EXACT_VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const UNSUPPORTED_PACKAGE_SPEC = 'unsupported package spec';

/** `latest` and no version both mean "whatever is newest at install time". */
function parsePackageSpec(
  token: string
): Pick<NpxPackageLaunch, 'packageName' | 'requested' | 'exact'> | null {
  const at = token.indexOf('@', 1);
  const name = at === -1 ? token : token.slice(0, at);
  const version = at === -1 ? null : token.slice(at + 1);
  if (name.length > MAX_PACKAGE_NAME || !PACKAGE_NAME_RE.test(name) || TARBALL_RE.test(name)) {
    return null;
  }
  if (version !== null) {
    if (version.length === 0 || version.length > MAX_VERSION_SPEC) return null;
    if (!VERSION_SPEC_RE.test(version) || version.trim() !== version) return null;
  }
  const requested = version === null || version === 'latest' ? null : version;
  return {
    packageName: name,
    requested,
    exact: requested !== null && EXACT_VERSION_RE.test(requested),
  };
}

function commandBaseName(command: string): string {
  const base = command.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(?:cmd|exe)$/, '');
}

/** Only an option's name ever goes into a reason — never a value that may follow `=`. */
function optionName(arg: string): string {
  return arg.split('=')[0] ?? arg;
}

/**
 * Classify a stdio command. `not-npx` and `unsupported` both mean "run the
 * configured command exactly as written"; `unsupported` carries the reason
 * shown in the MCP pane.
 */
export function parseNpxCommand(command: string | null, args: readonly string[]): NpxCommand {
  if (!command || commandBaseName(command) !== 'npx') return { kind: 'not-npx' };
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    if (arg === '--') {
      i += 1;
      break;
    }
    if (!arg.startsWith('-')) break;
    if (!PASSIVE_NPX_FLAGS.has(arg)) {
      return { kind: 'unsupported', reason: `it uses the npx option ${optionName(arg)}` };
    }
    i += 1;
  }
  const token = args[i];
  if (token === undefined) return { kind: 'unsupported', reason: 'no package is named' };
  const spec = parsePackageSpec(token);
  if (!spec) return { kind: 'unsupported', reason: UNSUPPORTED_PACKAGE_SPEC };
  return { kind: 'npx', launch: { ...spec, serverArgs: args.slice(i + 1) } };
}

/** `<name>@<requested|latest>` — the one argv entry handed to npm. */
export function installSpecOf(launch: Pick<NpxPackageLaunch, 'packageName' | 'requested'>): string {
  return `${launch.packageName}@${launch.requested ?? 'latest'}`;
}

/** Exact-version comparison that ignores a leading `v` and build metadata. */
export function sameVersion(a: string, b: string): boolean {
  const norm = (v: string) => v.replace(/^v/, '').replace(/\+.*$/, '');
  return norm(a) === norm(b);
}

// Installed package → bin

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}

type BinChoice = { ok: true; name: string; relPath: string } | { ok: false; reason: string };

/** Bin names come from a third-party manifest: keep them short and plain in reasons. */
function displayName(name: string): string {
  return name.replace(/[^\w@./-]/g, '').slice(0, 60);
}

/** npx's own choice: the only bin, else the bin named after the package (scope dropped). */
function pickBin(manifest: PackageManifest, packageName: string): BinChoice {
  const unscoped = packageName.replace(/^@[^/]+\//, '');
  let entries: Array<[string, string]> = [];
  if (typeof manifest.bin === 'string') {
    entries = [[unscoped, manifest.bin]];
  } else if (manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)) {
    entries = Object.entries(manifest.bin as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    );
  }
  if (entries.length === 0) return { ok: false, reason: 'the package has no program (bin) to run' };
  const distinct = new Set(entries.map(([, rel]) => path.posix.normalize(rel)));
  const [first] = entries;
  if (distinct.size === 1 && first) return { ok: true, name: first[0], relPath: first[1] };
  const named = entries.find(([name]) => name === unscoped);
  if (named) return { ok: true, name: named[0], relPath: named[1] };
  const names = entries.slice(0, 5).map(([name]) => displayName(name));
  return {
    ok: false,
    reason:
      `the package has several programs (${names.join(', ')}${entries.length > 5 ? ', …' : ''}) ` +
      `and none is named ${displayName(unscoped)}`,
  };
}

/** True when `child` is `parent` or inside it (both already absolute and resolved). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * How to run a bin file with node, from its first line: a `node` shebang
 * (its flags kept), or no shebang on a .js/.cjs/.mjs file. Anything else —
 * a shell script, Python, a native binary — is not a Node program.
 */
function nodeArgsForBin(head: string, file: string): string[] | null {
  if (head.startsWith('#!')) {
    const tokens = (head.slice(2).split(/\r?\n/)[0] ?? '').trim().split(/\s+/);
    const nodeAt = tokens.findIndex((token) => token === 'node' || token.endsWith('/node'));
    if (nodeAt === -1) return null;
    return tokens.slice(nodeAt + 1).filter((token) => token.startsWith('-'));
  }
  return /\.(?:c|m)?js$/i.test(file) ? [] : null;
}

interface InstalledBin {
  version: string;
  binName: string;
  /** Absolute, symlink-resolved path of the bin file inside the package. */
  file: string;
  /** Node flags from the bin's shebang. */
  nodeArgs: string[];
}

type InstalledBinResult = { ok: true; bin: InstalledBin } | { ok: false; reason: string };

async function readHead(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Read an installed package's manifest; null when it is missing or unreadable. */
async function readInstalledManifest(pkgDir: string): Promise<PackageManifest | null> {
  try {
    const parsed = safeJsonParse<unknown>(
      await readFile(path.join(pkgDir, 'package.json'), 'utf8'),
      null
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PackageManifest)
      : null;
  } catch {
    return null;
  }
}

/**
 * The program to start from an installed package: its manifest must name the
 * package, its bin must resolve to a file inside the package, and that file
 * must be a Node program.
 */
export async function resolveInstalledBin(
  pkgDir: string,
  packageName: string
): Promise<InstalledBinResult> {
  const manifest = await readInstalledManifest(pkgDir);
  if (!manifest || manifest.name !== packageName || typeof manifest.version !== 'string') {
    return { ok: false, reason: 'the installed copy is missing or damaged' };
  }
  const choice = pickBin(manifest, packageName);
  if (!choice.ok) return choice;
  let root: string;
  let file: string;
  try {
    root = await realpath(pkgDir);
    file = await realpath(path.resolve(pkgDir, choice.relPath));
  } catch {
    return { ok: false, reason: `its program ${displayName(choice.name)} is missing` };
  }
  if (!isInside(root, file)) {
    return {
      ok: false,
      reason: `its program ${displayName(choice.name)} points outside the package`,
    };
  }
  try {
    if (!(await stat(file)).isFile()) {
      return { ok: false, reason: `its program ${displayName(choice.name)} is not a file` };
    }
    const nodeArgs = nodeArgsForBin(await readHead(file), file);
    if (!nodeArgs) {
      return {
        ok: false,
        reason: `its program ${displayName(choice.name)} isn't a Node.js script`,
      };
    }
    return { ok: true, bin: { version: manifest.version, binName: choice.name, file, nodeArgs } };
  } catch {
    return { ok: false, reason: `its program ${displayName(choice.name)} can't be read` };
  }
}
