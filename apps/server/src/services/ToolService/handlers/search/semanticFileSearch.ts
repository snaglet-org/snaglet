import path from 'path';
import { minimatch } from 'minimatch';
import type { ToolHandler } from '@server/services/ToolService/types';
import { clamp } from '@snaglet/shared/utils';
import { Projects } from '@snaglet/db';
import { resolveToolCwd } from '@server/services/ToolService/lib/resolveToolCwd';
import { findProjectAncestor } from '@server/services/ToolService/lib/findProjectAncestor';
import { grepFileFallback } from '@server/services/ToolService/lib/grepFileFallback';
import { searchFileNodes, type FileNodePaletteHit } from '@server/services/search/fileNodeSearch';
import { getProjectFileEmbeddingCoverage } from '@server/services/embedding/fileEmbeddingCoverage';
import {
  resolveEmbeddingProvider,
  MockEmbeddingProvider,
} from '@server/services/embedding/EmbeddingProvider';

const VECTOR_OVERFETCH_MULTIPLIER = 4;
// Semantic hits below this cosine-similarity score are noise, not weaker
// matches — drop them so the tool returns signal, not a token bomb.
const SEMANTIC_SCORE_FLOOR = 0.38;
type MatchedOn = 'semantic' | 'grep';

interface SemanticFileResult {
  path: string;
  score: number;
  matchedOn: MatchedOn;
  indexed: boolean;
  /** Every absolute path sharing this hit's content (embeddings are
   * content-addressed — same bytes in N projects/worktrees = one hit).
   * Present on semantic hits only; `path` mirrors paths[0]. */
  paths?: string[];
  relativePath?: string;
  matchSource?: 'content' | 'path';
  line?: number;
}

function matchesGlob(filePath: string, searchPath: string, glob: string | null): boolean {
  if (!glob) return true;
  const relative = path.relative(searchPath, filePath).split(path.sep).join('/');
  const normalized = filePath.split(path.sep).join('/');
  return (
    minimatch(relative, glob, { dot: true, nocase: false }) ||
    minimatch(normalized, glob, { dot: true, nocase: false })
  );
}

/**
 * Map a content-deduped hit to the tool shape, keeping only paths that pass
 * the glob mask. A hit survives as long as any of its owning paths matches;
 * the primary `path` becomes the first surviving one.
 */
function semanticHitToResult(
  hit: FileNodePaletteHit,
  searchPath: string,
  glob: string | null
): SemanticFileResult | null {
  const allPaths = hit.paths?.length ? hit.paths.map((p) => p.absolutePath) : [hit.absolutePath];
  const paths = allPaths.filter((p) => p && matchesGlob(p, searchPath, glob));
  if (paths.length === 0) return null;
  return {
    path: paths[0],
    score: hit.score,
    matchedOn: 'semantic',
    indexed: true,
    paths,
  };
}

/** Root local paths once; keep outside owning paths absolute and unambiguous. */
function compactResults(results: SemanticFileResult[], basePath: string) {
  const displayPath = (filePath: string) => {
    const relative = path.relative(basePath, filePath);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? relative || '.'
      : filePath;
  };
  return results.map(({ path: filePath, paths, score, matchSource, line }) => ({
    path: displayPath(filePath),
    score,
    ...(paths ? { paths: paths.map(displayPath) } : {}),
    ...(matchSource ? { matchSource } : {}),
    ...(line != null ? { line } : {}),
  }));
}

/** Vector search runs only on the built-in local embedder (never the test mock). */
async function embeddingsAvailable(): Promise<boolean> {
  try {
    const provider = await resolveEmbeddingProvider();
    return provider !== null && !(provider instanceof MockEmbeddingProvider);
  } catch {
    return false;
  }
}

interface ResolvedProject {
  projectId: string | null;
  root: string | null;
}

async function resolveProject(
  projectIdInput: string | null,
  threadId: string | undefined
): Promise<ResolvedProject> {
  if (projectIdInput) {
    const project = await Projects.findById(projectIdInput);
    return {
      projectId: project?.id ?? null,
      root: project?.folderPath ? path.resolve(project.folderPath) : null,
    };
  }
  const ancestor = threadId ? await findProjectAncestor(threadId) : null;
  return {
    projectId: ancestor?.projectId ?? null,
    root: ancestor?.folderPath ? path.resolve(ancestor.folderPath) : null,
  };
}

/**
 * semantic_file_search — retrieval-by-meaning over a project's indexed files.
 * Embeds the query and runs vector search against file-node embeddings,
 * scoped to the resolved project. When embeddings/index are unavailable it
 * degrades to bounded content/path grep inside a resolved project folder and
 * reports `indexed: false` — it never silently presents grep hits as semantic.
 */
const tool: ToolHandler = async (input, _settings, context) => {
  const query = input.query ? String(input.query).trim() : '';
  if (!query) {
    return 'semantic_file_search requires a non-empty `query`.';
  }

  const glob = input.glob ? String(input.glob) : null;
  const maxResults = clamp(Number(input.maxResults ?? 20), 1, 200);
  const projectIdInput = input.project_id ? String(input.project_id) : null;
  const cwd = resolveToolCwd(input.path ? String(input.path) : undefined, context);

  const { projectId, root } = await resolveProject(projectIdInput, context?.threadId);

  let searchPath: string;
  if (input.path == null) {
    searchPath = root ?? cwd;
  } else if (root) {
    searchPath = path.resolve(root, String(input.path));
  } else {
    searchPath = cwd;
  }

  const rel = root ? path.relative(root, searchPath) : null;
  const inProject = rel === '' || (rel != null && !rel.startsWith('..') && !path.isAbsolute(rel));
  const relativePathPrefix = inProject && rel != null ? rel.split(path.sep).join('/') : null;

  const hasProvider = await embeddingsAvailable();
  const scopedCoverage =
    hasProvider && root && projectId && inProject
      ? await getProjectFileEmbeddingCoverage(projectId, relativePathPrefix)
      : null;
  const canVector = Boolean(hasProvider && scopedCoverage && scopedCoverage.embeddedFiles > 0);

  if (canVector) {
    // A glob mask filters semantic hits after ranking, which can shrink results
    // below maxResults — over-fetch so the mask has headroom.
    const fetchLimit = glob ? maxResults * VECTOR_OVERFETCH_MULTIPLIER : maxResults;
    const hits = await searchFileNodes(query, fetchLimit, { projectId, relativePathPrefix });
    const results = hits
      .map((hit) => semanticHitToResult(hit, searchPath, glob))
      .filter((result): result is SemanticFileResult => Boolean(result))
      .filter((result) => result.score >= SEMANTIC_SCORE_FLOOR)
      .slice(0, maxResults);

    return JSON.stringify({
      basePath: searchPath,
      query,
      indexed: true,
      matchedOn: 'semantic',
      count: results.length,
      files: compactResults(results, searchPath),
    });
  }

  // A filesystem fallback must have a real project folder and stay inside it.
  // Never substitute process.cwd(): that would search an invented scope while
  // claiming it represented the requested project.
  if (!root || !projectId || !inProject) {
    const note =
      !root || !projectId
        ? 'File search unavailable — no resolved project folder exists, so neither a scoped index nor filesystem grep can run.'
        : 'File search unavailable — the requested path is outside the resolved project folder, so scoped filesystem grep was not run.';
    return JSON.stringify({
      basePath: searchPath,
      query,
      indexed: false,
      matchedOn: 'unavailable',
      note,
      count: 0,
      files: [],
    });
  }

  const reason = !hasProvider
    ? 'The built-in embedding model is not available, so the vector index cannot be searched.'
    : `No files in this scope are indexed yet (coverage 0/${scopedCoverage?.totalFiles ?? 0}).`;
  const fallback = await grepFileFallback({
    projectRoot: root,
    searchPath,
    query,
    glob,
    limit: maxResults,
  });
  if (fallback.unavailableReason) {
    const unavailableDetail =
      fallback.unavailableReason === 'project-folder-unavailable'
        ? 'the resolved project folder is missing or is not a directory'
        : fallback.unavailableReason === 'search-path-unavailable'
          ? 'the requested search path is missing or is not a directory'
          : fallback.unavailableReason === 'outside-project'
            ? 'the requested search path resolves outside the project folder'
            : 'the query is empty';
    return JSON.stringify({
      basePath: searchPath,
      query,
      indexed: false,
      matchedOn: 'unavailable',
      note: `File search unavailable — ${unavailableDetail}; filesystem grep was not run.`,
      count: 0,
      files: [],
    });
  }
  const results: SemanticFileResult[] = fallback.hits;

  return JSON.stringify({
    basePath: searchPath,
    query,
    indexed: false,
    matchedOn: 'grep',
    note: `Semantic search unavailable — ${reason} Results are bounded content/path grep, not retrieval by meaning.${fallback.truncated ? ' The fallback scan was truncated at its safety limit.' : ''}`,
    truncated: fallback.truncated,
    scannedEntries: fallback.scannedEntries,
    scannedFiles: fallback.scannedFiles,
    scannedBytes: fallback.scannedBytes,
    count: results.length,
    files: compactResults(results, searchPath),
  });
};

export default tool;
