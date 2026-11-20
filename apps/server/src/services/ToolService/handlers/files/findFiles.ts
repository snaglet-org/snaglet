import path from 'path';
import type { ToolHandler } from '@server/services/ToolService/types';
import { clamp } from '@snaglet/shared/utils';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { listFilesByGlob } from '@server/services/ToolService/lib/listFilesByGlob';

function matchesNameContains(filePath: string, nameContains: string | null): boolean {
  return !nameContains || path.basename(filePath).toLowerCase().includes(nameContains);
}

function response(searchPath: string, files: string[], total: number, maxResults: number): string {
  return JSON.stringify(
    {
      basePath: searchPath,
      count: files.length,
      truncated: total > maxResults,
      files,
    },
    null,
    2
  );
}

/**
 * find_files — deterministic filesystem locator. Returns matching paths by
 * name/glob via a bounded native filesystem walk. No content search, no semantic/vector search: this
 * tool never pretends to understand meaning. For files-by-meaning use
 * semantic_file_search; for content/symbol search use code_search.
 */
const tool: ToolHandler = async (input, _settings, context) => {
  const searchPath = resolveToolCwd(input.path ? String(input.path) : undefined, context);
  const glob = input.glob ? String(input.glob) : null;
  const maxResults = clamp(Number(input.maxResults ?? 50), 1, 200);
  const nameContains = input.nameContains ? String(input.nameContains).toLowerCase() : null;

  const listed = await listFilesByGlob(searchPath, glob);
  const filtered = nameContains
    ? listed.filter((line) => matchesNameContains(line, nameContains))
    : listed;
  const limited = filtered.slice(0, maxResults);
  return response(searchPath, limited, filtered.length, maxResults);
};

export default tool;
