import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import path from 'node:path';

const searchFileNodes = jest.fn();
const findProjectAncestor = jest.fn();
const grepFileFallback = jest.fn();
const getProjectFileEmbeddingCoverage = jest.fn();
const resolveEmbeddingProvider = jest.fn();
const projectsFindById = jest.fn();

// A stand-in for the "embeddings not configured" sentinel. The tool treats a
// MockEmbeddingProvider instance as "no real index", same as the runtime.
class MockEmbeddingProvider {}

jest.mock('@server/services/search/fileNodeSearch', () => ({
  searchFileNodes: (...args: unknown[]) => searchFileNodes(...args),
}));

jest.mock('@server/services/ToolService/lib/findProjectAncestor', () => ({
  findProjectAncestor: (...args: unknown[]) => findProjectAncestor(...args),
}));

jest.mock('@server/services/ToolService/lib/grepFileFallback', () => ({
  grepFileFallback: (...args: unknown[]) => grepFileFallback(...args),
}));

jest.mock('@server/services/embedding/fileEmbeddingCoverage', () => ({
  getProjectFileEmbeddingCoverage: (...args: unknown[]) => getProjectFileEmbeddingCoverage(...args),
}));

jest.mock('@server/services/embedding/EmbeddingProvider', () => ({
  resolveEmbeddingProvider: (...args: unknown[]) => resolveEmbeddingProvider(...args),
  MockEmbeddingProvider,
}));

jest.mock('@snaglet/db', () => ({
  Projects: {
    findById: (...args: unknown[]) => projectsFindById(...args),
  },
}));

import semanticFileSearchTool from '@server/services/ToolService/handlers/search/semanticFileSearch';

interface SemanticResponse {
  basePath: string;
  query: string;
  indexed: boolean;
  matchedOn: 'semantic' | 'grep' | 'unavailable';
  count: number;
  note?: string;
  files: Array<{
    path: string;
    score: number;
    matchedOn?: string;
    indexed?: boolean;
    paths?: string[];
  }>;
}

const PROJECT_ROOT = path.resolve('fixture-project');
const SECOND_WORKTREE = path.resolve('fixture-worktree-2');

const PROJECT = {
  projectId: 'project-1',
  projectName: 'Snaglet',
  projectDescription: null,
  folderPath: PROJECT_ROOT,
  githubUrl: null,
};

async function run(input: Record<string, unknown>, threadId?: string): Promise<SemanticResponse> {
  const raw = await semanticFileSearchTool(input, {}, threadId ? { threadId } : undefined);
  return JSON.parse(raw as string) as SemanticResponse;
}

describe('semantic_file_search tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: a real (non-mock) embedding provider is available.
    resolveEmbeddingProvider.mockResolvedValue({});
    findProjectAncestor.mockResolvedValue(PROJECT);
    searchFileNodes.mockResolvedValue([]);
    getProjectFileEmbeddingCoverage.mockResolvedValue({ embeddedFiles: 4, totalFiles: 4 });
    grepFileFallback.mockResolvedValue({
      hits: [],
      scannedEntries: 0,
      scannedFiles: 0,
      scannedBytes: 0,
      truncated: false,
    });
    projectsFindById.mockResolvedValue(null);
  });

  it('rejects an empty query without touching search', async () => {
    const raw = await semanticFileSearchTool({ query: '   ' }, {}, { threadId: 'thread-1' });
    expect(raw).toBe('semantic_file_search requires a non-empty `query`.');
    expect(searchFileNodes).not.toHaveBeenCalled();
    expect(grepFileFallback).not.toHaveBeenCalled();
  });

  it('returns scored semantic results when the project is indexed', async () => {
    searchFileNodes.mockResolvedValue([
      { absolutePath: path.join(PROJECT_ROOT, 'src', 'search.ts'), score: 0.71 },
      { absolutePath: path.join(PROJECT_ROOT, 'src', 'index.ts'), score: 0.52 },
    ]);

    const out = await run({ query: 'vector search over files' }, 'thread-1');

    expect(searchFileNodes).toHaveBeenCalledWith(
      'vector search over files',
      20,
      expect.objectContaining({ projectId: 'project-1' })
    );
    expect(out.indexed).toBe(true);
    expect(out.matchedOn).toBe('semantic');
    expect(out.count).toBe(2);
    expect(out.files[0]).toEqual({
      path: 'src/search.ts',
      score: 0.71,
      paths: ['src/search.ts'],
    });
    expect(grepFileFallback).not.toHaveBeenCalled();
  });

  it('lists every owning path of a content-deduped hit', async () => {
    searchFileNodes.mockResolvedValue([
      {
        absolutePath: path.join(PROJECT_ROOT, 'src', 'shared.ts'),
        score: 0.8,
        paths: [
          { absolutePath: path.join(PROJECT_ROOT, 'src', 'shared.ts') },
          { absolutePath: path.join(SECOND_WORKTREE, 'src', 'shared.ts') },
        ],
      },
    ]);

    const out = await run({ query: 'shared bytes' }, 'thread-1');

    expect(out.count).toBe(1);
    expect(out.basePath).toBe(PROJECT_ROOT);
    expect(out.files[0].path).toBe('src/shared.ts');
    expect(out.files[0].paths).toEqual([
      'src/shared.ts',
      path.join(SECOND_WORKTREE, 'src', 'shared.ts'),
    ]);
  });

  it('drops semantic hits below the score floor', async () => {
    searchFileNodes.mockResolvedValue([
      { absolutePath: path.join(PROJECT_ROOT, 'src', 'keep.ts'), score: 0.5 },
      { absolutePath: path.join(PROJECT_ROOT, 'src', 'noise.ts'), score: 0.1 },
    ]);

    const out = await run({ query: 'something' }, 'thread-1');

    expect(out.files.map((f) => f.path)).toEqual(['src/keep.ts']);
  });

  it('honestly reports indexed:false and falls back to bounded grep when the embedder is unavailable', async () => {
    resolveEmbeddingProvider.mockResolvedValue(null);
    grepFileFallback.mockResolvedValue({
      hits: [
        {
          path: path.join(PROJECT_ROOT, 'src', 'auth-token.ts'),
          relativePath: 'src/auth-token.ts',
          score: 1,
          matchedOn: 'grep',
          indexed: false,
          matchSource: 'content',
          line: 4,
        },
      ],
      scannedEntries: 3,
      scannedFiles: 3,
      scannedBytes: 100,
      truncated: false,
    });

    const out = await run({ query: 'auth token' }, 'thread-1');

    expect(searchFileNodes).not.toHaveBeenCalled();
    expect(out.indexed).toBe(false);
    expect(out.matchedOn).toBe('grep');
    expect(out.note).toContain('Semantic search unavailable');
    expect(out.note).toContain('The built-in embedding model is not available');
    expect(out.files[0]).toEqual({
      path: 'src/auth-token.ts',
      score: 1,
      matchSource: 'content',
      line: 4,
    });
    expect(out.files.every((f) => !('matchedOn' in f) && !('indexed' in f))).toBe(true);
    expect(grepFileFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: PROJECT_ROOT,
        searchPath: PROJECT_ROOT,
        query: 'auth token',
      })
    );
  });

  it('treats a MockEmbeddingProvider as no index and falls back', async () => {
    resolveEmbeddingProvider.mockResolvedValue(new MockEmbeddingProvider());
    grepFileFallback.mockResolvedValue({
      hits: [],
      scannedEntries: 0,
      scannedFiles: 0,
      scannedBytes: 0,
      truncated: false,
    });

    const out = await run({ query: 'widget' }, 'thread-1');

    expect(out.indexed).toBe(false);
    expect(searchFileNodes).not.toHaveBeenCalled();
  });

  it('falls back with a project-scope reason when not inside an indexed project', async () => {
    findProjectAncestor.mockResolvedValue(null);

    const out = await run({ query: 'anything' }, 'thread-1');

    expect(out.indexed).toBe(false);
    expect(out.matchedOn).toBe('unavailable');
    expect(out.note).toContain('no resolved project folder');
    expect(searchFileNodes).not.toHaveBeenCalled();
    expect(grepFileFallback).not.toHaveBeenCalled();
  });

  it('falls back to grep when the active model has zero scoped coverage', async () => {
    getProjectFileEmbeddingCoverage.mockResolvedValue({ embeddedFiles: 0, totalFiles: 7 });

    const out = await run({ query: 'needle' }, 'thread-1');

    expect(searchFileNodes).not.toHaveBeenCalled();
    expect(grepFileFallback).toHaveBeenCalled();
    expect(out.matchedOn).toBe('grep');
    expect(out.note).toContain('coverage 0/7');
  });

  it('reports a stale configured folder as unavailable instead of an empty grep', async () => {
    getProjectFileEmbeddingCoverage.mockResolvedValue({ embeddedFiles: 0, totalFiles: 0 });
    grepFileFallback.mockResolvedValue({
      hits: [],
      scannedEntries: 0,
      scannedFiles: 0,
      scannedBytes: 0,
      truncated: false,
      unavailableReason: 'project-folder-unavailable',
    });

    const out = await run({ query: 'needle' }, 'thread-1');

    expect(out.matchedOn).toBe('unavailable');
    expect(out.note).toContain('missing or is not a directory');
  });

  it('resolves an explicit project_id via Projects.findById', async () => {
    const otherProjectRoot = path.resolve('fixture-other-project');
    projectsFindById.mockResolvedValue({ id: 'project-9', folderPath: otherProjectRoot });
    searchFileNodes.mockResolvedValue([
      { absolutePath: path.join(otherProjectRoot, 'a.ts'), score: 0.9 },
    ]);

    const out = await run({ query: 'x', project_id: 'project-9' }, 'thread-1');

    expect(projectsFindById).toHaveBeenCalledWith('project-9');
    expect(findProjectAncestor).not.toHaveBeenCalled();
    expect(searchFileNodes).toHaveBeenCalledWith(
      'x',
      20,
      expect.objectContaining({ projectId: 'project-9' })
    );
    expect(out.files[0].path).toBe('a.ts');
  });
});
