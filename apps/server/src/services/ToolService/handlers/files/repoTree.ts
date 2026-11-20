import { readdir } from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';
import type { ToolHandler } from '@server/services/ToolService/types';
import { clamp } from '@snaglet/shared/utils';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';

interface TreeOptions {
  includeHidden: boolean;
  maxDepth: number;
  maxEntries: number;
  smart: boolean;
  smartExpandThreshold: number;
  smartCollapseThreshold: number;
  smartMaxDepth: number;
}

const SMART_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage', 'out']);

function shouldIncludeEntry(entry: Dirent, options: TreeOptions): boolean {
  if (!options.includeHidden && entry.name.startsWith('.')) return false;
  if (options.smart && entry.isDirectory() && SMART_SKIP_DIRS.has(entry.name)) return false;
  return true;
}

async function listDirectoryEntries(targetPath: string, options: TreeOptions): Promise<Dirent[]> {
  const entries = await readdir(targetPath, { withFileTypes: true });
  return entries
    .filter((entry) => shouldIncludeEntry(entry, options))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function buildTreeLines(
  targetPath: string,
  options: TreeOptions,
  depth = 0,
  prefix = '',
  lines: string[] = [],
  preloadedEntries?: Dirent[]
): Promise<string[]> {
  if (lines.length >= options.maxEntries) return lines;
  if (depth > options.maxDepth && !(options.smart && depth <= options.smartMaxDepth)) return lines;

  const filtered = preloadedEntries ?? (await listDirectoryEntries(targetPath, options));

  for (let i = 0; i < filtered.length; i++) {
    if (lines.length >= options.maxEntries) break;
    const entry = filtered[i];
    const isLast = i === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const fullPath = path.join(targetPath, entry.name);
    const isDirectory = entry.isDirectory();
    let label = isDirectory ? `${entry.name}/` : entry.name;
    let childEntries: Dirent[] | undefined;

    let shouldRecurse = isDirectory && depth < options.maxDepth;
    if (isDirectory && options.smart) {
      childEntries = await listDirectoryEntries(fullPath, options);
      const childCount = childEntries.length;
      const isSmallDirectory = childCount < options.smartExpandThreshold;
      const isLargeDirectory = childCount > options.smartCollapseThreshold;

      if (isLargeDirectory) {
        label = `${entry.name}/ (${childCount} items)`;
        shouldRecurse = false;
      } else {
        shouldRecurse =
          (depth < options.maxDepth || isSmallDirectory) && depth < options.smartMaxDepth;
      }
    }

    lines.push(`${prefix}${connector}${label}`);

    if (shouldRecurse) {
      const childPrefix = `${prefix}${isLast ? '    ' : '│   '}`;
      await buildTreeLines(fullPath, options, depth + 1, childPrefix, lines, childEntries);
    }
  }

  return lines;
}

const tool: ToolHandler = async (input, _settings, context) => {
  const cwd = resolveToolCwd(input.path ? String(input.path) : undefined, context);
  const inputPath = input.path ? String(input.path) : cwd;
  const basePath = path.resolve(inputPath);
  const maxDepth = clamp(Number(input.depth ?? 2), 0, 6);
  const maxEntries = clamp(Number(input.maxEntries ?? 300), 1, 2000);
  const includeHidden = Boolean(input.includeHidden);
  const smart = Boolean(input.smart);

  const lines = await buildTreeLines(
    basePath,
    {
      includeHidden,
      maxDepth,
      maxEntries,
      smart,
      smartExpandThreshold: 5,
      smartCollapseThreshold: 20,
      smartMaxDepth: 12,
    },
    0,
    '',
    [`${basePath}/`]
  );

  if (lines.length >= maxEntries) {
    lines.push(`... truncated at ${maxEntries} entries`);
  }

  return lines.join('\n');
};

export default tool;
