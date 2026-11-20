/**
 * The dedicated file lane for workspace_search: project scoping for the `file`
 * kind, the grep fallback when the vector index is unusable, and the labeled
 * file section composed alongside the shared pool — kept out of the fused pool
 * so file hits can't flood it.
 */

import path from 'node:path';
import type { SearchHit } from './types';
import { resolveScope } from '@server/services/search/searchPolicy';
import { Projects } from '@snaglet/db/tables/projects';
import type { NormalizedSearchTimeRange } from '@server/services/search/timeRange';
import { renderFileLane, renderResults, type SearchCardMap } from './formatters';
import { searchLexicalWorkspace } from './lexical';
import { searchSemanticWorkspace } from './semantic';
import { getFileSearchScope } from '@server/services/fileIndexing';
import { getProjectFileEmbeddingCoverage } from '@server/services/embedding/fileEmbeddingCoverage';
import {
  grepFileFallback,
  type GrepFileSearchResult,
} from '@server/services/ToolService/lib/grepFileFallback';
import {
  MockEmbeddingProvider,
  resolveEmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';
import { resolveAbsoluteFilePathsByNodeIds } from '@server/services/search/fileNodeSearch';
import type { FileHit, SearchableKind } from './types';

/** Resolved file-kind scope: the project whose index to search, plus an optional
 * SQL LIKE pattern narrowing to a satellite's subtree of the owner. */
export interface FileSearchScope {
  /** Requested project identity (before owner/satellite redirect). */
  requestedProjectId: string;
  /** Real project folder used by the disk fallback. */
  projectRoot: string;
  /** Project owning the indexed file rows. */
  projectId: string;
  /** LIKE pattern (e.g. 'apps/server/%') or null for the owner's whole tree. */
  pathPrefix: string | null;
}

/** Escape LIKE metacharacters in a path segment, then append the subtree glob. */
function subtreeLikePattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`;
}

// Resolve the file-kind scope, shared by both the semantic and lexical channels
// so `scope_files: 'project'` is enforced consistently. Returns null (=>
// workspace-wide file search) unless:
//   - scope_files === 'project' AND 'file' is among the requested kinds, AND
//   - a project resolves (explicit project_id or thread context), AND
//   - that project has a folder_path configured (else no files exist to scope).
//
// When the resolved project shares a folder tree with another project (a
// satellite of an owner), the scope is redirected to the OWNER's project id and
// narrowed to the satellite's subtree — because only the owner actually indexes
// the tree (see fileIndexing/ownership). Falls back to scoping to the project
// itself when ownership isn't known (e.g. a worker-less instance with a cold map).
export async function resolveFileProjectId(args: {
  scopeFiles: 'project' | 'workspace';
  wantsFiles: boolean;
  fileProjectArg: string | null | undefined;
  threadId: string | null | undefined;
}): Promise<FileSearchScope | null> {
  const { scopeFiles, wantsFiles, fileProjectArg, threadId } = args;
  if (scopeFiles !== 'project' || !wantsFiles) return null;
  const scope = await resolveScope({
    explicit: { project_id: fileProjectArg ?? undefined },
    callerContext: { thread_id: threadId ?? undefined },
  });
  if (scope.mode === 'project' && scope.project_id) {
    const project = await Projects.findById(scope.project_id);
    if (project?.folderPath) {
      const redirect = getFileSearchScope(scope.project_id);
      if (redirect) {
        return {
          requestedProjectId: scope.project_id,
          projectRoot: path.resolve(project.folderPath),
          projectId: redirect.projectId,
          pathPrefix: redirect.pathPrefix ? subtreeLikePattern(redirect.pathPrefix) : null,
        };
      }
      return {
        requestedProjectId: scope.project_id,
        projectRoot: path.resolve(project.folderPath),
        projectId: scope.project_id,
        pathPrefix: null,
      };
    }
  }
  return null;
}

/** Modest cap on the file lane — enough to answer "where does X live" without
 *  re-flooding the output that the lane exists to keep files out of. */
const FILE_LANE_LIMIT = 5;

export interface FileFallbackSection {
  matchedOn: 'grep' | 'unavailable';
  result: GrepFileSearchResult | null;
  note: string;
}

export interface FileLaneOutput {
  hits: FileHit[];
  fallback: FileFallbackSection | null;
}

async function hasUsableEmbeddingProvider(): Promise<boolean> {
  try {
    const provider = await resolveEmbeddingProvider();
    return provider !== null && !(provider instanceof MockEmbeddingProvider);
  } catch {
    return false;
  }
}

function unavailableFallbackNote(reason: GrepFileSearchResult['unavailableReason']): string {
  switch (reason) {
    case 'project-folder-unavailable':
      return 'The resolved project folder is missing or is not a directory; filesystem grep was not run.';
    case 'search-path-unavailable':
      return 'The requested project search path is missing or is not a directory; filesystem grep was not run.';
    case 'outside-project':
      return 'The requested search path resolves outside the project folder; filesystem grep was not run.';
    case 'empty-query':
      return 'The grep query is empty; filesystem grep was not run.';
    default:
      return 'No real project folder could be resolved; filesystem grep was not run.';
  }
}

/** Return null only when the scoped vector index is genuinely usable. */
export async function fileFallbackForScope(args: {
  query: string;
  limit: number;
  channel: 'semantic' | 'lexical';
  scopeFiles: 'project' | 'workspace';
  scope: FileSearchScope | null;
  excludeIds: Set<string>;
}): Promise<FileFallbackSection | null> {
  // A workspace-wide vector search has no single authoritative project folder
  // to grep. Keep its existing index behavior; never invent a process cwd.
  if (args.scopeFiles === 'workspace') return null;
  if (!args.scope) {
    return {
      matchedOn: 'unavailable',
      result: null,
      note: 'No real project folder could be resolved; filesystem grep was not run.',
    };
  }

  const coverage = await getProjectFileEmbeddingCoverage(args.scope.requestedProjectId);
  const providerAvailable = args.channel === 'semantic' ? await hasUsableEmbeddingProvider() : true;
  if (providerAvailable && coverage.embeddedFiles > 0) return null;

  const fallback = await grepFileFallback({
    projectRoot: args.scope.projectRoot,
    searchPath: args.scope.projectRoot,
    query: args.query,
    limit: args.limit,
  });
  if (fallback.unavailableReason) {
    return {
      matchedOn: 'unavailable',
      result: fallback,
      note: unavailableFallbackNote(fallback.unavailableReason),
    };
  }

  const excludedPaths = await resolveAbsoluteFilePathsByNodeIds(args.excludeIds);
  if (excludedPaths.size > 0) {
    fallback.hits = fallback.hits.filter((hit) => !excludedPaths.has(path.resolve(hit.path)));
  }
  const cause = !providerAvailable
    ? 'The built-in embedding model is not available.'
    : `No files in this project are indexed yet (coverage 0/${coverage.totalFiles}).`;
  return {
    matchedOn: 'grep',
    result: fallback,
    note: `${cause} Results below are bounded filesystem grep, not semantic matches.`,
  };
}

function renderFileFallback(section: FileFallbackSection): string {
  const result = section.result;
  const hits = result?.hits ?? [];
  const lines = [
    `Files (${hits.length}) — matchedOn: ${section.matchedOn} · indexed: false`,
    `Note: ${section.note}`,
  ];
  if (result) {
    lines.push(
      `Scan: ${result.scannedFiles} file(s), ${result.scannedBytes} byte(s)` +
        `${result.truncated ? ' · truncated: true' : ' · truncated: false'}`
    );
  }
  for (const hit of hits) {
    const line = hit.line ? `:${hit.line}` : '';
    lines.push(`- ${hit.path}${line} · ${hit.matchSource} · score ${hit.score.toFixed(4)}`);
  }
  return lines.join('\n');
}

export function appendFileFallback(
  body: string | null,
  section: FileFallbackSection | null
): string {
  const fallback = section ? renderFileFallback(section) : '';
  if (!body) return fallback;
  return fallback ? `${body}\n\n${fallback}` : body;
}

/**
 * The dedicated FILE LANE. Files are excluded from the shared default pool (see
 * DEFAULT_SEARCH_KINDS), so a code-ish query (isCodeishQuery) with no explicit
 * `kinds` fires this ADDITIONAL, file-only search. Its hits merge as a separate
 * labeled section (renderFileLane) — the shared pool itself never contains files
 * (pool flooding is the disease). Mirrors thread_recall's "own channel for a kind
 * that would otherwise drown" precedent, but keeps files out of the fused pool.
 *
 * The lane matches the caller's channel: semantic/hybrid callers get the semantic
 * file channel (chunk-offset "grep with semantics"); default (keyword) callers get
 * the lexical file channel (path FTS). File scoping resolves exactly the way the
 * inline `file` kind does (project folder, satellite subtree).
 */
export async function runFileLane(args: {
  query: string;
  channel: 'semantic' | 'hybrid' | 'lexical';
  limit: number;
  allowedContainerIds: string[] | null;
  scopeFiles: 'project' | 'workspace';
  fileProjectArg: string | null | undefined;
  threadId: string | null;
  timeRange: NormalizedSearchTimeRange | null;
  includeArchived: boolean;
  excludeIds: Set<string>;
}): Promise<FileLaneOutput> {
  const laneLimit = Math.min(args.limit, FILE_LANE_LIMIT);
  const fileScope = await resolveFileProjectId({
    scopeFiles: args.scopeFiles,
    wantsFiles: true,
    fileProjectArg: args.fileProjectArg,
    threadId: args.threadId,
  });

  const fallback = await fileFallbackForScope({
    query: args.query,
    limit: laneLimit,
    channel: args.channel === 'lexical' ? 'lexical' : 'semantic',
    scopeFiles: args.scopeFiles,
    scope: fileScope,
    excludeIds: args.excludeIds,
  });
  if (fallback) return { hits: [], fallback };

  let hits: SearchHit[];
  if (args.channel === 'lexical') {
    const lexical = await searchLexicalWorkspace({
      query: args.query,
      kinds: new Set<SearchableKind>(['file']),
      limit: laneLimit,
      allowedContainerIds: args.allowedContainerIds,
      containerRowsCache: null,
      timeRange: args.timeRange,
      fileProjectId: fileScope?.projectId ?? null,
      filePathPrefix: fileScope?.pathPrefix ?? null,
      includeArchived: args.includeArchived,
    });
    hits = lexical.hits;
  } else {
    hits = await searchSemanticWorkspace({
      query: args.query,
      kinds: ['file'],
      mode: args.channel,
      limit: laneLimit,
      allowedContainerIds: args.allowedContainerIds,
      threadId: args.threadId,
      graphDepth: 0,
      timeRange: args.timeRange,
      fileProjectId: fileScope?.projectId ?? null,
      filePathPrefix: fileScope?.pathPrefix ?? null,
      rerank: true,
      includeArchived: args.includeArchived,
    });
  }
  return {
    hits: hits.filter((h): h is FileHit => h.kind === 'file' && !args.excludeIds.has(h.id)),
    fallback: null,
  };
}

/**
 * Compose the shared-pool results with the (optional) file-lane section. When the
 * shared pool is empty but the lane found files, the lane still shows (noting the
 * pool had nothing) — a code-ish query should never swallow its file hits.
 *
 * `emptyPoolNote` overrides the generic "no shared-pool matches" line for that
 * case — the semantic committed path passes the honest-empty message (or a
 * one-line weak-matches note) when the pool emptied because hits fell below the
 * relevance floor, not because nothing matched, so the agent isn't misled into
 * thinking the pool was genuinely empty.
 */
export function composeWithFileLane(
  query: string,
  mainHits: SearchHit[],
  threadEnrichment: Parameters<typeof renderResults>[2],
  fileLaneHits: FileHit[],
  cardById?: SearchCardMap,
  emptyPoolNote?: string
): string {
  const fileBlock = renderFileLane(fileLaneHits);
  if (mainHits.length === 0) {
    if (!fileBlock) return emptyPoolNote ?? `No results for "${query}".`;
    return [emptyPoolNote ?? `No shared-pool matches for "${query}".`, '', fileBlock].join('\n');
  }
  const mainBlock = renderResults(query, mainHits, threadEnrichment, cardById);
  return fileBlock ? `${mainBlock}\n\n${fileBlock}` : mainBlock;
}
