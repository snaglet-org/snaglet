import { readdir, stat } from 'fs/promises';
import path from 'path';
import type { ToolHandler } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import findFiles from '@server/services/ToolService/handlers/files/findFiles';
import repoTree from '@server/services/ToolService/handlers/files/repoTree';

async function listRecursive(dir: string, maxDepth: number, depth = 0): Promise<string[]> {
  if (depth >= maxDepth) return [`[dir] ${dir}/...`];

  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(`[dir] ${fullPath}`);
      const sub = await listRecursive(fullPath, maxDepth, depth + 1);
      results.push(...sub);
    } else {
      results.push(`[file] ${fullPath}`);
    }
  }

  return results;
}

const tool: ToolHandler = async (input, settings, context) => {
  if (input.mode === 'find') {
    return findFiles(
      { ...input, nameContains: input.name_contains, maxResults: input.limit },
      settings,
      context
    );
  }
  if (input.mode === 'tree') return repoTree(input, settings, context);

  const cwd = resolveToolCwd(input.path ? String(input.path) : undefined, context);
  const dirPath = input.path ? path.resolve(String(input.path)) : cwd;
  const recursive = input.recursive === true;
  validatePathConstraint(dirPath, settings);

  if (recursive) {
    const maxDepth = Number(input.max_depth ?? 3);
    const entries = await listRecursive(dirPath, maxDepth);
    return entries.join('\n');
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const withSizes = input.sizes === true;
  if (!withSizes) {
    return entries.map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`).join('\n');
  }

  const lines = await Promise.all(
    entries.map(async (e) => {
      const tag = e.isDirectory() ? '[dir]' : '[file]';
      if (e.isDirectory()) return `${tag} ${e.name}`;
      try {
        const { size } = await stat(path.join(dirPath, e.name));
        return `${tag} ${e.name} (${size} bytes)`;
      } catch {
        return `${tag} ${e.name}`;
      }
    })
  );
  return lines.join('\n');
};

export default tool;
