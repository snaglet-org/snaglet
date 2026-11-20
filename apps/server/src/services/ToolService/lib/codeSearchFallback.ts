/** Bounded no-rg code-search enumeration. Ignore rules follow listFilesByGlob. */
import { constants } from 'node:fs';
import { open, opendir, lstat } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { minimatch } from 'minimatch';
type IgnoreMatcher = ReturnType<typeof ignore>;
interface IgnoreLayer {
  baseDirectory: string;
  matcher: IgnoreMatcher;
}

async function readIgnoreLayers(absoluteDirectory: string): Promise<IgnoreLayer[]> {
  const layers: IgnoreLayer[] = [];
  for (const fileName of ['.gitignore', '.ignore']) {
    try {
      const handle = await open(
        path.join(absoluteDirectory, fileName),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      let patterns: string;
      try {
        const buffer = Buffer.alloc(64 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 64 * 1024) throw new Error('Ignore file exceeds fallback byte limit');
        patterns = buffer.subarray(0, bytesRead).toString('utf8');
        if (patterns.split('\n').some((line) => line.length > 4096)) {
          throw new Error('Ignore pattern exceeds fallback length limit');
        }
      } finally {
        await handle.close();
      }
      layers.push({
        baseDirectory: absoluteDirectory,
        matcher: ignore({ ignorecase: false }).add(patterns),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
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

export async function listFilesWithoutRipgrep(
  root: string,
  glob: string | null,
  entryLimit: number
): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  const checkDeadline = () => {
    if (Date.now() > deadline) throw new Error('File enumeration exceeded fallback time limit');
  };
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error('Fallback search root must not be a symlink');
  if (rootStat.isFile()) return [root];
  const files: string[] = [];
  const directories: Array<{ absolutePath: string; relativePath: string; layers: IgnoreLayer[] }> =
    [{ absolutePath: root, relativePath: '', layers: await readAncestorIgnoreLayers(root) }];
  let entriesSeen = 0;

  while (directories.length > 0) {
    const current = directories.pop();
    if (!current) break;
    checkDeadline();
    const layers = [...current.layers, ...(await readIgnoreLayers(current.absolutePath))];
    const entries = await opendir(current.absolutePath);
    for await (const entry of entries) {
      checkDeadline();
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

/**
 * Literal-only, case-INSENSITIVE fallback. Never evaluate user input as JS regex.
 * Known difference: `rg` as called has no `-i`, so it is case-sensitive; the search tool
 * has no case option, so this fallback defaults to insensitive.
 */
export async function searchContentWithoutRipgrep(root: string, query: string, limit: number) {
  const files = await listFilesWithoutRipgrep(root, null, 10_000);
  const results: Array<{ path: string; line: number; snippet: string }> = [];
  const needle = query.toLowerCase();
  let skippedOversizedFiles = 0;
  const deadline = Date.now() + 10_000;
  let bytes = 0;
  for (const file of files) {
    if (Date.now() > deadline) throw new Error('Content fallback exceeded time limit');
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) continue;
      if (stat.size > 1024 * 1024) {
        skippedOversizedFiles += 1;
        continue;
      }
      content = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await handle.read(content, 0, content.length, 0);
      bytes += bytesRead;
      if (bytes > 16 * 1024 * 1024)
        throw new Error('Content fallback exceeds 16MiB total read limit');
      // Count bytes actually read even when growth makes this file too large.
      if (bytesRead > 1024 * 1024) {
        skippedOversizedFiles += 1;
        continue;
      }
      content = content.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    if (content.includes(0)) continue;
    const lines = content.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        results.push({ path: file, line: i + 1, snippet: lines[i].trimEnd() });
        if (results.length >= limit) return { results, skippedOversizedFiles };
      }
    }
  }
  return { results, skippedOversizedFiles };
}
