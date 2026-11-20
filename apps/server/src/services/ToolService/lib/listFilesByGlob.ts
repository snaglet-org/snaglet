/**
 * Enumerate files for deterministic file lookup. Ripgrep remains the normal
 * implementation because its ignore and hidden-file behavior is established
 * product behavior. A Node fallback keeps packaged installs useful when rg is
 * unavailable, with the same .gitignore/.ignore and hidden-file rules.
 */

import { execFile, type ExecException } from 'node:child_process';
import { type Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ignore from 'ignore';
import { minimatch } from 'minimatch';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';
import { ripgrepExecutable } from '@server/services/ToolService/lib/ripgrepExecutable';

const execFileAsync = promisify(execFile);
const DEFAULT_FALLBACK_ENTRY_LIMIT = 10_000;
type IgnoreMatcher = ReturnType<typeof ignore>;

interface IgnoreLayer {
  baseDirectory: string;
  matcher: IgnoreMatcher;
}

/** Internal diagnostic seam for the no-rg fallback tests. */
export interface ListFilesByGlobOptions {
  executable?: string;
  fallbackEntryLimit?: number;
}

function isMissingExecutable(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function toAbsolute(root: string, listedPath: string): string {
  return path.isAbsolute(listedPath) ? listedPath : path.resolve(root, listedPath);
}

async function listFilesWithRipgrep(
  root: string,
  glob: string | null,
  executable: string
): Promise<string[] | null> {
  // `--no-config` and buildCommandEnv(): an agent can edit the file RIPGREP_CONFIG_PATH
  // names, and the server's own environment never reaches ripgrep.
  const args = ['--no-config', '--files'];
  if (glob) args.push('--glob', glob);
  args.push('--', root);
  try {
    const { stdout } = await execFileAsync(executable, args, {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      env: buildCommandEnv(),
    });
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => toAbsolute(root, line))
      .sort();
  } catch (error) {
    if (isMissingExecutable(error)) return null;
    const code = (error as ExecException | undefined)?.code;
    const stderr = String((error as { stderr?: unknown } | undefined)?.stderr ?? '');
    if (
      code === 1 ||
      (code === 2 && /permission denied|no such file|not a directory/i.test(stderr))
    ) {
      return [];
    }
    throw error;
  }
}

async function readIgnoreLayers(absoluteDirectory: string): Promise<IgnoreLayer[]> {
  const layers: IgnoreLayer[] = [];
  for (const fileName of ['.gitignore', '.ignore']) {
    try {
      const patterns = await readFile(path.join(absoluteDirectory, fileName), 'utf8');
      layers.push({
        baseDirectory: absoluteDirectory,
        matcher: ignore({ ignorecase: false }).add(patterns),
      });
    } catch {
      // A missing or unreadable ignore file does not make file lookup fail.
    }
  }
  return layers;
}

async function readAncestorIgnoreLayers(root: string): Promise<IgnoreLayer[]> {
  const directories: string[] = [];
  let current = path.dirname(root);
  for (;;) {
    directories.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const layers: IgnoreLayer[] = [];
  for (const directory of directories.reverse()) {
    layers.push(...(await readIgnoreLayers(directory)));
  }
  return layers;
}

function isIgnored(
  layers: readonly IgnoreLayer[],
  absolutePath: string,
  isDirectory: boolean
): boolean {
  let ignored = false;
  for (const layer of layers) {
    const fromLayer = path.relative(layer.baseDirectory, absolutePath).split(path.sep).join('/');
    if (!fromLayer || fromLayer === '..' || fromLayer.startsWith('../')) continue;
    const result = layer.matcher.test(isDirectory ? `${fromLayer}/` : fromLayer);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

async function listFilesWithoutRipgrep(
  root: string,
  glob: string | null,
  entryLimit: number
): Promise<string[]> {
  const files: string[] = [];
  const directories: Array<{ absolutePath: string; relativePath: string; layers: IgnoreLayer[] }> =
    [{ absolutePath: root, relativePath: '', layers: await readAncestorIgnoreLayers(root) }];
  let entriesSeen = 0;

  while (directories.length > 0) {
    const current = directories.pop();
    if (!current) break;
    let entries: Dirent[];
    try {
      entries = await readdir(current.absolutePath, { withFileTypes: true });
    } catch {
      continue;
    }
    const layers = [...current.layers, ...(await readIgnoreLayers(current.absolutePath))];
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > entryLimit) {
        throw new Error(
          `File enumeration reached its ${entryLimit}-entry fallback limit. Narrow the search path and retry.`
        );
      }
      // rg --files omits hidden paths unless --hidden is requested. Ignore
      // files were already loaded for this directory and are not listed.
      if (entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(current.absolutePath, entry.name);
      if (isIgnored(layers, absolutePath, entry.isDirectory())) continue;
      if (entry.isDirectory()) {
        directories.push({ absolutePath, relativePath, layers });
        continue;
      }
      if (!entry.isFile()) continue;
      if (!glob || minimatch(relativePath, glob, { dot: false, nocase: false })) {
        files.push(absolutePath);
      }
    }
  }

  return files.sort();
}

export async function listFilesByGlob(
  searchPath: string,
  glob: string | null,
  options: ListFilesByGlobOptions = {}
): Promise<string[]> {
  const root = path.resolve(searchPath);
  const listed = await listFilesWithRipgrep(root, glob, options.executable ?? ripgrepExecutable());
  if (listed) return listed;
  return listFilesWithoutRipgrep(
    root,
    glob,
    options.fallbackEntryLimit ?? DEFAULT_FALLBACK_ENTRY_LIMIT
  );
}
