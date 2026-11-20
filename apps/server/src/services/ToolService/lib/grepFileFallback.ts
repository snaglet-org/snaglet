/**
 * Bounded, deterministic filesystem fallback for file search.
 *
 * This is deliberately not called "semantic": it performs case-insensitive
 * token matching over eligible file contents and paths when a usable vector
 * index is absent. The walk shares the indexer's hard exclusions and the
 * project's snaglet.config.json rules, and it caps entries, files, and bytes read so
 * a stale search call cannot turn into an unbounded repository crawl.
 */

import path from 'node:path';
import { readdir, realpath, stat } from 'node:fs/promises';
import { minimatch } from 'minimatch';
import { readEmbeddableFileBody } from '@server/services/embedding/fileSource';
import { compileIgnoreRules, shouldExcludePath } from '@server/services/fileIndexing/exclusions';
import { readWatchConfig } from '@server/services/fileIndexing/watchConfig';

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_MATCHES = 200;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with',
]);

interface GrepFileHit {
  path: string;
  relativePath: string;
  score: number;
  matchedOn: 'grep';
  indexed: false;
  matchSource: 'content' | 'path';
  /** First content line containing a query token. Absent for path-only hits. */
  line?: number;
}

export interface GrepFileSearchResult {
  hits: GrepFileHit[];
  scannedEntries: number;
  scannedFiles: number;
  scannedBytes: number;
  truncated: boolean;
  unavailableReason?:
    | 'empty-query'
    | 'project-folder-unavailable'
    | 'search-path-unavailable'
    | 'outside-project';
}

export interface GrepFileSearchOptions {
  /** Directory to search. */
  searchPath: string;
  /** Resolved project folder used for snaglet.config.json and project-relative ignores. */
  projectRoot: string;
  query: string;
  glob?: string | null;
  limit: number;
  /** Test/diagnostic overrides; production callers use the bounded defaults. */
  maxEntries?: number;
  maxFiles?: number;
  maxBytes?: number;
  maxMatches?: number;
}

function tokenizeQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token));
  return [...new Set(meaningful.length > 0 ? meaningful : tokens)];
}

function tokenHits(value: string, tokens: string[]): number {
  const normalized = value.toLowerCase();
  return tokens.reduce((count, token) => count + (normalized.includes(token) ? 1 : 0), 0);
}

function firstMatchingLine(body: string, tokens: string[]): number | undefined {
  const lines = body.split(/\r?\n/);
  const index = lines.findIndex((line) => tokenHits(line, tokens) > 0);
  return index >= 0 ? index + 1 : undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function unavailable(
  unavailableReason: NonNullable<GrepFileSearchResult['unavailableReason']>
): GrepFileSearchResult {
  return {
    hits: [],
    scannedEntries: 0,
    scannedFiles: 0,
    scannedBytes: 0,
    truncated: false,
    unavailableReason,
  };
}

/**
 * Search eligible files by path and content without relying on indexed rows.
 * Unreadable, oversized, and binary files are skipped by readEmbeddableFileBody.
 */
export async function grepFileFallback(
  options: GrepFileSearchOptions
): Promise<GrepFileSearchResult> {
  const searchPath = path.resolve(options.searchPath);
  const projectRoot = path.resolve(options.projectRoot);
  if (!options.query.trim()) return unavailable('empty-query');

  let realProjectRoot: string;
  let realSearchPath: string;
  try {
    const [projectInfo, searchInfo, resolvedProjectRoot, resolvedSearchPath] = await Promise.all([
      stat(projectRoot),
      stat(searchPath),
      realpath(projectRoot),
      realpath(searchPath),
    ]);
    if (!projectInfo.isDirectory()) return unavailable('project-folder-unavailable');
    if (!searchInfo.isDirectory()) return unavailable('search-path-unavailable');
    realProjectRoot = resolvedProjectRoot;
    realSearchPath = resolvedSearchPath;
  } catch {
    try {
      const projectInfo = await stat(projectRoot);
      if (!projectInfo.isDirectory()) return unavailable('project-folder-unavailable');
    } catch {
      return unavailable('project-folder-unavailable');
    }
    return unavailable('search-path-unavailable');
  }
  if (!isWithin(realProjectRoot, realSearchPath)) return unavailable('outside-project');

  const rules = compileIgnoreRules(await readWatchConfig(projectRoot));
  const tokens = tokenizeQuery(options.query);
  const limit = Math.max(1, options.limit);
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxMatches = Math.max(1, options.maxMatches ?? DEFAULT_MAX_MATCHES);

  const hits: GrepFileHit[] = [];
  const stack: string[] = [''];
  let scannedEntries = 0;
  let scannedFiles = 0;
  let scannedBytes = 0;
  let truncated = false;

  walk: while (stack.length > 0) {
    const relativeDir = stack.pop() as string;
    const absoluteDir = relativeDir ? path.join(searchPath, relativeDir) : searchPath;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      continue;
    }

    // readdir ordering is filesystem-dependent. Sort, then push directories in
    // reverse so the LIFO walk visits paths in stable lexical order.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const directories: string[] = [];
    for (const entry of entries) {
      if (scannedEntries >= maxEntries) {
        truncated = true;
        break walk;
      }
      scannedEntries += 1;

      const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
      const absolutePath = path.join(searchPath, relativePath);
      const projectRelativePath = path.relative(projectRoot, absolutePath);
      // Directory junctions and symlinks can escape the selected project or
      // point back into an already visited tree. Never recurse through them.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!shouldExcludePath(projectRelativePath, rules, 'directory')) {
          directories.push(relativePath);
        }
        continue;
      }
      if (!entry.isFile() || shouldExcludePath(projectRelativePath, rules, 'file')) continue;

      const normalizedRelativePath = relativePath.split(path.sep).join('/');
      if (
        options.glob &&
        !minimatch(normalizedRelativePath, options.glob, { dot: true, nocase: false })
      ) {
        continue;
      }
      if (scannedFiles >= maxFiles || scannedBytes >= maxBytes) {
        truncated = true;
        break walk;
      }
      scannedFiles += 1;

      const pathHitCount = tokenHits(normalizedRelativePath, tokens);
      const body = await readEmbeddableFileBody(absolutePath);
      if (body == null) {
        if (pathHitCount > 0) {
          hits.push({
            path: absolutePath,
            relativePath: normalizedRelativePath,
            score: tokens.length > 0 ? pathHitCount / tokens.length : 0,
            matchedOn: 'grep',
            indexed: false,
            matchSource: 'path',
          });
          if (hits.length >= maxMatches) {
            truncated = true;
            break walk;
          }
        }
        continue;
      }

      const bodyBytes = Buffer.byteLength(body, 'utf8');
      if (scannedBytes + bodyBytes > maxBytes) {
        // The body was read to learn its actual UTF-8 cost, but it is outside
        // the admitted byte budget and therefore cannot influence content
        // matching or ranking. A path match remains valid and is labeled as
        // such; then the walk stops because no further content can be admitted.
        if (pathHitCount > 0 && hits.length < maxMatches) {
          hits.push({
            path: absolutePath,
            relativePath: normalizedRelativePath,
            score: tokens.length > 0 ? pathHitCount / tokens.length : 0,
            matchedOn: 'grep',
            indexed: false,
            matchSource: 'path',
          });
        }
        truncated = true;
        break walk;
      }
      scannedBytes += bodyBytes;
      const contentHitCount = tokenHits(body, tokens);
      if (pathHitCount === 0 && contentHitCount === 0) continue;
      const matchedTokenCount = Math.max(pathHitCount, contentHitCount);
      const contentMatch = contentHitCount > 0;
      hits.push({
        path: absolutePath,
        relativePath: normalizedRelativePath,
        score: tokens.length > 0 ? matchedTokenCount / tokens.length : 0,
        matchedOn: 'grep',
        indexed: false,
        matchSource: contentMatch ? 'content' : 'path',
        ...(contentMatch ? { line: firstMatchingLine(body, tokens) } : {}),
      });
      if (hits.length >= maxMatches) {
        truncated = true;
        break walk;
      }
    }

    for (let index = directories.length - 1; index >= 0; index -= 1) {
      stack.push(directories[index]);
    }
  }

  hits.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.matchSource === 'content') - Number(a.matchSource === 'content') ||
      a.relativePath.localeCompare(b.relativePath)
  );

  return {
    hits: hits.slice(0, limit),
    scannedEntries,
    scannedFiles,
    scannedBytes,
    truncated: truncated || hits.length > limit,
  };
}
