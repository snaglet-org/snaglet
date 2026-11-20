import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { getErrorMessage, safeJsonParse } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { validatePathConstraint } from '@server/services/ToolService/handlers/_shared';
import { buildCommandEnv } from '@server/services/ToolService/lib/buildSafeEnv';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { ripgrepExecutable } from '@server/services/ToolService/lib/ripgrepExecutable';

import {
  listFilesWithoutRipgrep,
  searchContentWithoutRipgrep,
} from '@server/services/ToolService/lib/codeSearchFallback';

const execFileAsync = promisify(execFile);

/**
 * ripgrep reads extra flags from the file RIPGREP_CONFIG_PATH names, which an agent can
 * edit to add `--pre=<program>` or `--search-zip`: every run passes `--no-config` and gets
 * buildCommandEnv(), never the server's own environment.
 */
const RG_NO_CONFIG = '--no-config';

interface SearchResult {
  path: string;
  line: number | null;
  snippet?: string;
}

const tool: ToolHandler = async (input, settings, context) => {
  const query = String(input.query ?? '');
  const cwd = resolveToolCwd(input.path ? String(input.path) : undefined, context);
  const searchPath = input.path ? String(input.path) : cwd;
  const mode = String(input.mode ?? 'both') as 'name' | 'content' | 'both';
  const maxResults = Math.min(Number(input.max_results ?? 50), 200);

  if (!query) throw new Error('query is required');
  validatePathConstraint(searchPath, settings);

  const timeout = Number(settings?.timeoutMs ?? 15000);
  const results: SearchResult[] = [];
  let notice: string | undefined;
  let failure: string | undefined;
  const basePath = path.resolve(searchPath);
  const render = () =>
    JSON.stringify({
      basePath,
      ...(notice ? { notice } : {}),
      ...(failure ? { error: failure } : {}),
      files: results.slice(0, maxResults).map((result) => {
        const relative = path.relative(basePath, path.resolve(result.path));
        const inside =
          relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        return { ...result, path: inside ? relative || '.' : result.path };
      }),
    });

  // Name mode: list files (respecting .gitignore) and filter by basename or any path-segment
  // substring (relative to the search root).
  // - Respecting .gitignore keeps stdout well under maxBuffer (skips node_modules/, dist/, .git/)
  //   and matches what agents actually want (no node_modules hits). Without it, stdout can
  //   exceed maxBuffer and get truncated, missing files at deep paths.
  // - Matching basename OR any segment under the search root (rather than the full path)
  //   avoids the false-positive case where the query appears in the parent prefix of the
  //   search root itself (e.g. searching 'tools' under apps/server/src/services/ToolService
  //   would match every file because 'tools' is in the root prefix).
  // - maxBuffer is bumped to 16MB as defense for very large repos with deep roots.
  if (mode === 'name' || mode === 'both') {
    let listed: string[];
    try {
      const { stdout } = await execFileAsync(
        ripgrepExecutable(),
        [RG_NO_CONFIG, '--files', '--', searchPath],
        { timeout, env: buildCommandEnv(), maxBuffer: 16 * 1024 * 1024 }
      );
      listed = stdout.split('\n').filter(Boolean);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          listed = await listFilesWithoutRipgrep(basePath, null, 10_000);
        } catch (fallbackError) {
          listed = [];
          failure = `Name fallback failed: ${getErrorMessage(fallbackError).slice(0, 300)}`;
        }
      } else {
        listed = [];
        if ((error as { code?: unknown }).code !== 1)
          failure = `Name search failed: ${getErrorMessage(error).slice(0, 300)}`;
      }
    }
    {
      const queryLower = query.toLowerCase();
      const rootResolved = path.resolve(searchPath);
      // Rank all name candidates before limiting: traversal order is not relevance.
      // Exact paths and basename/stem matches beat prefixes, then substrings.
      const candidates = listed.map((filePath) => {
        const rel = path.relative(rootResolved, path.resolve(filePath));
        const normalized = rel.split(path.sep).join('/').toLowerCase();
        const segments = normalized.split('/');
        const basename = segments[segments.length - 1];
        const stem = basename.slice(0, basename.length - path.extname(basename).length);
        const score =
          normalized === queryLower
            ? 6
            : normalized.endsWith(`/${queryLower}`)
              ? 5
              : basename === queryLower || stem === queryLower
                ? 4
                : basename.startsWith(queryLower)
                  ? 3
                  : segments.some((segment) => segment === queryLower)
                    ? 2
                    : segments.some((segment) => segment.includes(queryLower))
                      ? 1
                      : 0;
        return { filePath, rel, score };
      });
      candidates.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
      for (const candidate of candidates) {
        if (results.length >= maxResults) break;
        if (candidate.score > 0) results.push({ path: candidate.filePath, line: null });
      }
    }
  }

  // Content mode: search file contents using rg --json.
  if (mode === 'content' || mode === 'both') {
    const remaining = maxResults - results.length;
    if (remaining <= 0) {
      return render();
    }
    try {
      const { stdout } = await execFileAsync(
        ripgrepExecutable(),
        // `-e` binds the query as the pattern even when it starts with `-`
        // (e.g. `--pre=<cmd>`, which would run <cmd> on every file).
        [RG_NO_CONFIG, '--json', `--max-count=${remaining}`, '-e', query, '--', searchPath],
        { timeout, maxBuffer: 8 * 1024 * 1024, env: buildCommandEnv() }
      );
      for (const rawLine of stdout.split('\n')) {
        if (!rawLine.trim()) continue;
        // A malformed line is skipped.
        const parsed = safeJsonParse<{
          type: string;
          data: {
            path?: { text: string };
            line_number?: number;
            lines?: { text: string };
          };
        }>(rawLine);
        if (parsed?.type === 'match' && parsed.data?.path?.text) {
          results.push({
            path: parsed.data.path.text,
            line: parsed.data.line_number ?? null,
            snippet: (parsed.data.lines?.text ?? '').trimEnd(),
          });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        notice =
          "ripgrep isn't installed, so this was searched as plain text; regex needs ripgrep.";
        try {
          const fallback = await searchContentWithoutRipgrep(basePath, query, remaining);
          results.push(...fallback.results);
          if (fallback.skippedOversizedFiles > 0) {
            const count = fallback.skippedOversizedFiles;
            notice += ` Skipped ${count} oversized file${count === 1 ? '' : 's'} (over 1MiB).`;
          }
        } catch (fallbackError) {
          failure = `Content fallback failed: ${getErrorMessage(fallbackError).slice(0, 300)}`;
        }
      } else if ((error as { code?: unknown }).code !== 1) {
        failure = `Content search failed: ${getErrorMessage(error).slice(0, 300)}`;
      }
    }
  }

  if (results.length === 0 && !notice && !failure) return `No matches found for query: ${query}`;
  return render();
};

export default tool;
