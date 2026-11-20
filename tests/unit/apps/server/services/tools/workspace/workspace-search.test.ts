import { beforeEach, describe, expect, it } from '@jest/globals';
import path from 'node:path';

// Mocks (hoisted before module imports)

const mockPoolQuery = jest.fn();
const mockGetPool = jest.fn(() => ({ query: mockPoolQuery }));

jest.mock('@snaglet/db', () => ({
  getPool: () => mockGetPool(),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: () => mockGetPool(),
}));

const mockResolveCallerProject = jest.fn();
jest.mock('@server/services/ToolService/handlers/search/findConversation/projectScope', () => ({
  resolveCallerProject: (...args: unknown[]) => mockResolveCallerProject(...args),
  mapThreadsToProjects: jest.fn(),
}));

const mockListAllOrderedContainers = jest.fn();
const mockMessagesListRecentByThreadId = jest.fn();
const mockThreadParticipantsListByThread = jest.fn();
const mockAgentsFindByIds = jest.fn();
const mockSearchNodes = jest.fn();
const mockCreateQueryEmbedding = jest.fn();
const mockReadSearchPreferences = jest.fn();
const mockProjectsFindById = jest.fn();
const mockGetProjectFileEmbeddingCoverage = jest.fn();
const mockGrepFileFallback = jest.fn();
const mockResolveEmbeddingProvider = jest.fn();

jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: {
    listAllOrdered: (...args: unknown[]) => mockListAllOrderedContainers(...args),
  },
}));
jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    listRecentByThreadId: (...args: unknown[]) => mockMessagesListRecentByThreadId(...args),
  },
}));
jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    listByThread: (...args: unknown[]) => mockThreadParticipantsListByThread(...args),
  },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    findByIds: (...args: unknown[]) => mockAgentsFindByIds(...args),
  },
}));

jest.mock('@server/services/search/nodeSearch.js', () => ({
  workspaceSearchNodes: (...args: unknown[]) => mockSearchNodes(...args),
  createQueryEmbedding: (...args: unknown[]) => mockCreateQueryEmbedding(...args),
}));

// Thread hits render an opening summary when one exists; without this mock the
// enrichment path reaches the real thread-summary model (and a real pg pool).
jest.mock('@snaglet/db/tables/thread_summaries', () => ({
  ThreadSummaries: {
    getByThread: jest.fn(async () => null),
  },
}));

// The tool still imports Projects (for file-kind project scoping via findById);
// stub it so no branch reaches a real pool.
jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: {
    findById: (...args: unknown[]) => mockProjectsFindById(...args),
  },
}));

jest.mock('@server/services/embedding/fileEmbeddingCoverage', () => ({
  getProjectFileEmbeddingCoverage: (...args: unknown[]) =>
    mockGetProjectFileEmbeddingCoverage(...args),
}));

jest.mock('@server/services/ToolService/lib/grepFileFallback', () => ({
  grepFileFallback: (...args: unknown[]) => mockGrepFileFallback(...args),
}));

class MockEmbeddingProvider {}
jest.mock('@server/services/embedding/EmbeddingProvider', () => ({
  resolveEmbeddingProvider: (...args: unknown[]) => mockResolveEmbeddingProvider(...args),
  MockEmbeddingProvider,
}));

// Semantic search reads preferences through settingsService.read; mock the
// registry read so it doesn't hit a real settings row (and pg pool).
jest.mock('@server/services/settings/index.js', () => ({
  settingsService: {
    read: (...args: unknown[]) => mockReadSearchPreferences(...args),
  },
}));
jest.mock('@server/services/settings/categories/search.js', () => ({
  searchSettings: { preferences: { category: 'search', key: 'preferences' } },
}));

// The cross-encoder floor needs real scores to threshold on; onnxruntime is
// stubbed suite-wide (it SIGABRTs jest workers), so the reranker always
// degrades to "no scores" and the floor never fires under the real module.
// Mock the scored reranker used by the finish pipeline so committed-search
// tests can force scores below the floor; default to an identity reorder with
// no scores (matching the real degraded behavior) so every other test in this
// file is unaffected. The non-scored variant (used by the file lane's
// internal rerank) stays an identity passthrough always.
let scoreById = new Map<string, number>();
jest.mock('@server/services/ToolService/handlers/search/workspaceSearch/rerankHits', () => {
  const actual = jest.requireActual(
    '@server/services/ToolService/handlers/search/workspaceSearch/rerankHits'
  ) as Record<string, unknown>;
  return {
    ...actual,
    rerankSearchHits: jest.fn(async (_q: string, hits: unknown[]) => hits),
    rerankSearchHitsScored: jest.fn(async (_q: string, hits: unknown[]) => ({
      items: hits,
      scoreById,
    })),
  };
});

import tool from '@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch';
import { COMMITTED_RERANK_FLOOR } from '@server/services/ToolService/handlers/search/workspaceSearch/committedSearch';
import { invokeTool, toolOutputText } from '../../../../../../support/toolHarness';

const NOW = '2025-01-01T00:00:00.000Z';
const PROJECT_ROOT = path.resolve('fixture-project');

// Route pool.query by SQL substring → rows. The `nodes` route is the bare-id
// resolver shortcut; default empty so any single-token query that passes the
// regex gate falls through to normal search.
function routeQuery(routes: Record<string, unknown[]>) {
  return async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM public.nodes WHERE id = $1')) return { rows: routes.nodes ?? [] };
    if (sql.includes('FROM public.docs')) return { rows: routes.docs ?? [] };
    if (sql.includes('FROM public.threads')) return { rows: routes.threads ?? [] };
    // No `FROM public.projects` branch: a project is a container with
    // category='project'; the search tool never queries a projects table.
    if (sql.includes('FROM public.containers')) return { rows: routes.containers ?? [] };
    if (sql.includes('FROM public.messages')) return { rows: routes.messages ?? [] };
    if (sql.includes('FROM public.tasks')) return { rows: routes.tasks ?? [] };
    if (sql.includes('FROM public.memories')) return { rows: routes.memories ?? [] };
    if (sql.includes('FROM public.thread_summaries')) return { rows: routes.threadSummaries ?? [] };
    if (sql.includes('FROM public.tools')) return { rows: routes.tools ?? [] };
    if (sql.includes('FROM public.files')) return { rows: routes.files ?? [] };
    return { rows: [] };
  };
}

// True for the lightweight `SELECT type FROM public.nodes WHERE id = $1`
// fired by the bare-id resolver. Limit-checking tests skip it since its
// param tuple is `[id]`, not `[..., limit]`.
function isNodesLookup(sql: string): boolean {
  return sql.includes('FROM public.nodes WHERE id = $1');
}

async function call(input: Record<string, unknown> = {}) {
  const explicitInput =
    input.mode === undefined && typeof input.query === 'string' && input.query.trim()
      ? { ...input, mode: 'keyword' }
      : input;
  return toolOutputText(await invokeTool(tool, explicitInput));
}

async function callWithDefaults(input: Record<string, unknown> = {}) {
  return toolOutputText(await invokeTool(tool, input));
}

beforeEach(() => {
  mockPoolQuery.mockReset();
  mockGetPool.mockClear();
  mockListAllOrderedContainers.mockReset();
  mockResolveCallerProject.mockReset();
  mockResolveCallerProject.mockResolvedValue(null);
  mockMessagesListRecentByThreadId.mockReset();
  mockThreadParticipantsListByThread.mockReset();
  mockAgentsFindByIds.mockReset();
  mockSearchNodes.mockReset();
  mockCreateQueryEmbedding.mockReset();
  mockReadSearchPreferences.mockReset();
  mockProjectsFindById.mockReset();
  mockGetProjectFileEmbeddingCoverage.mockReset();
  mockGrepFileFallback.mockReset();
  mockResolveEmbeddingProvider.mockReset();
  scoreById = new Map();

  mockListAllOrderedContainers.mockResolvedValue([]);
  mockMessagesListRecentByThreadId.mockResolvedValue([]);
  mockThreadParticipantsListByThread.mockResolvedValue([]);
  mockAgentsFindByIds.mockResolvedValue([]);
  mockSearchNodes.mockResolvedValue({
    hits: [],
    scope_applied: { mode: 'root', source: 'explicit_container' },
    scope_source: 'explicit_container',
  });
  mockCreateQueryEmbedding.mockResolvedValue(null);
  mockProjectsFindById.mockResolvedValue(null);
  mockGetProjectFileEmbeddingCoverage.mockResolvedValue({ embeddedFiles: 1, totalFiles: 1 });
  mockGrepFileFallback.mockResolvedValue({
    hits: [],
    scannedEntries: 0,
    scannedFiles: 0,
    scannedBytes: 0,
    truncated: false,
  });
  mockResolveEmbeddingProvider.mockResolvedValue({});
  mockReadSearchPreferences.mockResolvedValue({
    useVector: true,
    useFts: true,
    useGraphWalk: false,
    threadBoost: true,
  });
  // Default empty route so tests that exit early on validation don't crash
  // when the bare-id resolver runs first. Tests can override per-test.
  mockPoolQuery.mockImplementation(routeQuery({}));
});

describe('workspace_search', () => {
  it('rejects empty queries', async () => {
    const out = await call({ query: '   ' });
    expect(out).toMatch(/Search query or id is required/i);
  });

  it('clamps over-large limit to 50', async () => {
    mockPoolQuery.mockImplementation(routeQuery({}));
    await call({ query: 'hello', limit: 999 });
    let checked = 0;
    for (const c of mockPoolQuery.mock.calls) {
      const sql = c[0] as string;
      if (isNodesLookup(sql)) continue;
      const params = c[1] as unknown[];
      expect(params[params.length - 1]).toBe(50);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('returns "No results" message when nothing matches', async () => {
    mockPoolQuery.mockImplementation(routeQuery({}));
    const out = await call({ query: 'nope' });
    expect(out).toMatch(/No results for "nope"/);
  });

  it('passes explicit time_range into mixed lexical search SQL', async () => {
    mockPoolQuery.mockImplementation(routeQuery({}));

    await call({
      query: 'search',
      kinds: ['doc'],
      time_range: {
        from: '2026-05-01',
        to: '2026-06-01',
      },
    });

    const docCall = mockPoolQuery.mock.calls.find((call: unknown[]) =>
      (call[0] as string).includes('FROM public.docs')
    );
    expect(docCall).toBeDefined();
    expect(docCall?.[0]).toContain('$3::timestamptz');
    expect(docCall?.[1]).toEqual([
      'search',
      null,
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      10,
    ]);
  });

  it('filters lexical message search on messages.created_at', async () => {
    mockPoolQuery.mockImplementation(routeQuery({}));

    await call({
      query: 'search',
      kinds: ['doc', 'message'],
      time_range: {
        from: '2026-05-01',
        to: '2026-06-01',
      },
    });

    const messageCall = mockPoolQuery.mock.calls.find((call: unknown[]) =>
      (call[0] as string).includes('FROM public.messages')
    );
    expect(messageCall).toBeDefined();
    expect(messageCall?.[0]).toContain('m.created_at');
    expect(messageCall?.[0]).not.toContain('mn.created_at');
  });

  it('filters lexical searchable node tables on their own created_at columns', async () => {
    mockPoolQuery.mockImplementation(routeQuery({}));

    await call({
      query: 'search',
      kinds: ['doc', 'container', 'thread', 'memory', 'thread_summary'],
      time_range: {
        from: '2026-05-01',
        to: '2026-06-01',
        field: 'created_at',
      },
    });

    const sqlFor = (needle: string) =>
      mockPoolQuery.mock.calls.find((call: unknown[]) =>
        (call[0] as string).includes(needle)
      )?.[0] as string | undefined;

    expect(sqlFor('FROM public.docs')).toContain('d.created_at');
    expect(sqlFor('FROM public.containers')).toContain('c.created_at');
    expect(sqlFor('FROM public.threads')).toContain('t.created_at');
    expect(sqlFor('FROM public.memories')).toContain('m.created_at');
    expect(sqlFor('FROM public.thread_summaries')).toContain('ts.created_at');
  });

  it('formats a doc hit with snippet', async () => {
    mockPoolQuery.mockImplementation(
      routeQuery({
        docs: [
          {
            id: 'doc-1',
            title: 'Readme',
            updated_at: NOW,
            rank: 0.5,
            snippet: 'this is **hello** world',
          },
        ],
      })
    );
    const out = await call({ query: 'hello' });
    expect(out).toContain('Readme');
    expect(out).toContain('doc-1');
    expect(out).toContain('hello');
  });

  it('only queries kinds it was asked for', async () => {
    mockPoolQuery.mockImplementation(routeQuery({}));
    await call({ query: 'hello', kinds: 'doc' });
    const sqls = mockPoolQuery.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(sqls.some((s) => s.includes('FROM public.docs'))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM public.threads'))).toBe(false);
    expect(sqls.some((s) => s.includes('FROM public.projects'))).toBe(false);
    expect(sqls.some((s) => s.includes('FROM public.containers'))).toBe(false);
    expect(sqls.some((s) => s.includes('FROM public.messages'))).toBe(false);
  });

  it('routes explicit doc-only hybrid search through workspaceSearchNodes', async () => {
    mockSearchNodes.mockResolvedValueOnce({
      hits: [{ node_id: 'doc-1', score: 0.4, channels: ['fts', 'vector'] }],
      scope_applied: { mode: 'root', source: 'explicit_container' },
      scope_source: 'explicit_container',
    });
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'doc-1',
          title: 'Hybrid Docs',
          updated_at: NOW,
          snippet: 'this is **hybrid** docs',
        },
      ],
    });

    const out = await call({ query: 'hybrid docs', kinds: ['doc'], mode: 'hybrid' });

    expect(mockSearchNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'hybrid docs',
        kind: 'doc',
        scope: { container_id: 'root' },
        mode: 'hybrid',
      })
    );
    expect(out).toContain('Hybrid Docs');
    expect(out).toContain('fts+vector');
  });

  it('defaults explicit message search to hybrid workspaceSearchNodes', async () => {
    mockSearchNodes.mockResolvedValueOnce({
      hits: [{ node_id: 'message-1', score: 0.4, channels: ['fts', 'vector'] }],
      scope_applied: { mode: 'root', source: 'explicit_container' },
      scope_source: 'explicit_container',
    });
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'message-1',
          thread_id: 'thread-1',
          thread_title: 'Planning',
          role: 'assistant',
          agent_id: 'agent-1',
          agent_name: 'Venus',
          user_id: null,
          user_name: null,
          created_at: NOW,
          snippet: 'this is **hybrid** search',
        },
      ],
    });

    const out = await callWithDefaults({ query: 'hybrid search', kinds: ['message'] });

    expect(mockSearchNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'hybrid search',
        kind: 'message',
        scope: { container_id: 'root' },
        mode: 'hybrid',
      })
    );
    expect(out).toContain('[Message](message-1)');
    expect(out).toContain('Thread: [Planning](thread-1) (thread-1)');
    expect(out).toContain('Sender: Venus');
    expect(out).toContain('Date: 2025-01-01T00:00:00.000Z');
    expect(out).toContain('this is **hybrid** search');
    expect(out).toContain('fts+vector');
  });

  it('searches messages in mixed lexical mode', async () => {
    mockPoolQuery.mockImplementation(
      routeQuery({
        messages: [
          {
            id: 'message-1',
            thread_id: 'thread-1',
            thread_title: 'Planning',
            role: 'assistant',
            agent_id: 'agent-1',
            agent_name: 'Venus',
            user_id: null,
            user_name: null,
            created_at: NOW,
            rank: 0.4,
            snippet: 'this is **hybrid** search',
          },
        ],
      })
    );

    const out = await call({ query: 'hybrid', kinds: ['doc', 'message'] });

    expect(mockSearchNodes).not.toHaveBeenCalled();
    expect(out).toContain('[Message](message-1)');
    expect(out).toContain('Thread: [Planning](thread-1) (thread-1)');
    expect(out).toContain('Sender: Venus');
  });

  it('rejects hybrid workspace mode unless kinds is doc-only, task-only, or message-only', async () => {
    const out = await call({ query: 'hybrid', kinds: ['memory', 'tool'], mode: 'hybrid' });
    expect(out).toContain('semantic-capable kinds only');
    expect(mockSearchNodes).not.toHaveBeenCalled();
  });

  it('supports semantic search for context-domain kinds through workspace_search', async () => {
    mockCreateQueryEmbedding.mockResolvedValue({
      vector: [0.1, 0.2, 0.3],
      modelId: 'test:model',
    });
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM public.nodes WHERE id = $1')) return { rows: [] };
      if (sql.includes('FROM public.embeddings')) {
        return { rows: [{ id: 'memory-1', kind: 'memory', title: 'search-plan' }] };
      }
      if (sql.includes('FROM public.memories')) {
        return {
          rows: [
            {
              id: 'memory-1',
              memory_key: 'search-plan',
              content: 'Semantic search should find this memory by meaning',
              agent_id: 'agent-1',
              source_thread_id: 'thread-1',
              updated_at: NOW,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const out = await call({
      query: 'meaning based retrieval',
      kinds: ['memory'],
      mode: 'semantic',
      graph_depth: 0,
    });

    expect(mockCreateQueryEmbedding).toHaveBeenCalledWith('meaning based retrieval');
    expect(out).toContain('🧠 [search-plan](memory-1)');
    expect(out).toContain('Semantic search should find this memory');
  });

  it('formats default lexical hits for knowledge kinds beyond workspace containers', async () => {
    mockPoolQuery.mockImplementation(
      routeQuery({
        messages: [
          {
            id: 'message-1',
            thread_id: 'thread-1',
            thread_title: 'Search thread',
            role: 'assistant',
            agent_id: 'agent-1',
            agent_name: 'Venus',
            user_id: null,
            user_name: null,
            created_at: NOW,
            rank: 0.4,
            snippet: 'Workspace **search** includes messages now',
          },
        ],
        memories: [
          {
            id: 'memory-1',
            memory_key: 'search-plan',
            content: 'Workspace search should own knowledge retrieval',
            agent_id: 'agent-1',
            source_thread_id: 'thread-1',
            updated_at: NOW,
          },
        ],
        tools: [
          {
            id: 'workspace_search',
            name: 'Workspace Search',
            description: 'Search workspace knowledge',
            category_path: 'knowledge/workspace/navigation',
            tier: 'standard',
            is_active: true,
            updated_at: NOW,
          },
        ],
      })
    );

    const out = await call({ query: 'search' });

    expect(out).toContain('[Message](message-1)');
    expect(out).toContain('🧠 [search-plan](memory-1)');
    expect(out).toContain('🔧 [Workspace Search](tool:workspace_search)');
  });

  it('enriches thread hits with participants and recent messages', async () => {
    mockPoolQuery.mockImplementation(
      routeQuery({
        threads: [{ id: 'thread-1', title: 'Planning', updated_at: NOW }],
      })
    );
    mockThreadParticipantsListByThread.mockResolvedValue([
      { agentId: 'agent-1' },
      { agentId: 'agent-2' },
    ]);
    mockAgentsFindByIds.mockResolvedValue([
      { id: 'agent-1', name: 'Venus' },
      { id: 'agent-2', name: 'Clio' },
    ]);
    mockMessagesListRecentByThreadId.mockResolvedValue([
      { id: 'm1', authorAgentId: 'agent-1', content: 'hi', createdAt: NOW },
      { id: 'm2', authorAgentId: 'agent-2', content: 'hello', createdAt: NOW },
    ]);
    const out = await call({ query: 'planning', kinds: 'thread' });
    expect(out).toContain('Planning');
    expect(out).toContain('Venus');
    expect(out).toContain('Clio');
  });

  it('formats container hits', async () => {
    mockPoolQuery.mockImplementation(
      routeQuery({
        containers: [{ id: 'container-a', name: 'Alpha', parent_id: null, updated_at: NOW }],
      })
    );
    const out = await call({ query: 'alpha', kinds: 'container' });
    expect(out).toContain('Alpha');
    expect(out).toContain('container-a');
  });

  // A project is a container with category='project', so it surfaces via the
  // container-hit path, covered by "formats container hits" above.

  it('passes scope container ids to SQL when scoping by path', async () => {
    // resolveContainerScope is pure; it needs Containers.listAllOrdered to
    // return the rows so it can compute the subtree.
    mockListAllOrderedContainers.mockResolvedValue([
      { id: 'container-a', name: 'Alpha', parentId: null, sortOrder: 0 },
      { id: 'container-a1', name: 'Sub', parentId: 'container-a', sortOrder: 0 },
    ]);
    mockPoolQuery.mockImplementation(routeQuery({}));
    await call({ query: 'hi', path: '/Alpha', kinds: 'doc' });
    const docCall = mockPoolQuery.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('FROM public.docs')
    );
    expect(docCall).toBeTruthy();
    const params = docCall![1] as unknown[];
    // 2nd param is allowedContainerIds (text[]) — should contain both ids.
    const allowed = params[1] as string[];
    expect(allowed).toEqual(expect.arrayContaining(['container-a', 'container-a1']));
  });

  it('scopes thread summary search through the summarized thread’s project', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      { id: 'container-a', name: 'Alpha', parentId: null, sortOrder: 0 },
      { id: 'container-a1', name: 'Sub', parentId: 'container-a', sortOrder: 0 },
    ]);
    mockPoolQuery.mockImplementation(routeQuery({}));

    await call({ query: 'planning', path: '/Alpha', kinds: 'thread_summary' });

    const summaryCall = mockPoolQuery.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('FROM public.thread_summaries')
    );
    expect(summaryCall).toBeTruthy();
    const sql = summaryCall![0] as string;
    const params = summaryCall![1] as unknown[];

    expect(sql).toContain('JOIN public.nodes tn ON tn.id = ts.thread_id');
    expect(sql).toContain('tn.project_id = ANY($2::text[])');
    expect(params[1]).toEqual(expect.arrayContaining(['container-a', 'container-a1']));
  });

  it('passes NULL for allowedContainerIds when no scope', async () => {
    mockPoolQuery.mockImplementation(routeQuery({}));
    await call({ query: 'hi', kinds: 'doc' });
    const docCall = mockPoolQuery.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('FROM public.docs')
    );
    const params = docCall![1] as unknown[];
    expect(params[1]).toBeNull();
  });

  describe('project_scope', () => {
    const PROJECT = { projectId: 'container-a', projectName: 'Alpha' };
    const callInThread = async (input: Record<string, unknown>) =>
      toolOutputText(
        await invokeTool(
          tool,
          { mode: 'keyword', kinds: 'doc', query: 'hi', ...input },
          {
            threadId: 'thread-1111111111111-aaaaaaaaa',
          }
        )
      );
    const docParams = () => {
      const docCall = mockPoolQuery.mock.calls.find((c: unknown[]) =>
        (c[0] as string).includes('FROM public.docs')
      );
      expect(docCall).toBeTruthy();
      return docCall![1] as unknown[];
    };
    beforeEach(() => {
      mockListAllOrderedContainers.mockResolvedValue([
        { id: 'container-a', name: 'Alpha', parentId: null, sortOrder: 0 },
        { id: 'container-a1', name: 'Sub', parentId: 'container-a', sortOrder: 0 },
        { id: 'container-b', name: 'Beta', parentId: null, sortOrder: 1 },
      ]);
      mockPoolQuery.mockImplementation(routeQuery({}));
    });

    it('only: restricts the search to the calling thread’s project and its folders', async () => {
      mockResolveCallerProject.mockResolvedValue(PROJECT);
      await callInThread({ project_scope: 'only' });
      expect(mockResolveCallerProject).toHaveBeenCalledWith('thread-1111111111111-aaaaaaaaa');
      const allowed = docParams()[1] as string[];
      expect([...allowed].sort()).toEqual(['container-a', 'container-a1']);
    });

    it('only: says so and searches everywhere when the thread is not in a project', async () => {
      const out = await callInThread({ project_scope: 'only' });
      expect(docParams()[1]).toBeNull();
      expect(out).toContain('not in a project');
    });

    it.each([undefined, 'all', 'prioritize'])('%s: leaves the search unscoped', async (value) => {
      mockResolveCallerProject.mockResolvedValue(PROJECT);
      await callInThread(value ? { project_scope: value } : {});
      expect(docParams()[1]).toBeNull();
    });

    it('an explicit path wins over project_scope', async () => {
      mockResolveCallerProject.mockResolvedValue(PROJECT);
      await callInThread({ project_scope: 'only', path: '/Beta' });
      expect(docParams()[1]).toEqual(['container-b']);
    });
  });

  it('respects the limit param across SQL calls', async () => {
    mockPoolQuery.mockImplementation(routeQuery({}));
    await call({ query: 'hi', limit: 7 });
    let checked = 0;
    for (const c of mockPoolQuery.mock.calls) {
      const sql = c[0] as string;
      if (isNodesLookup(sql)) continue;
      const params = c[1] as unknown[];
      expect(params[params.length - 1]).toBe(7);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('returns scope error string for an unknown path', async () => {
    mockListAllOrderedContainers.mockResolvedValue([
      { id: 'container-a', name: 'Alpha', parentId: null, sortOrder: 0 },
    ]);
    const out = await call({ query: 'x', path: '/Nope' });
    expect(out).toMatch(/No container "Nope"/);
  });

  describe('file lane', () => {
    const fileRow = {
      id: 'file-1',
      relative_path: 'src/authMiddleware.ts',
      content_hash: 'fhash-auth',
      project_id: 'proj-1',
      size_bytes: 2048,
      updated_at: NOW,
      rank: 0.4,
      snippet: 'src/<<authMiddleware>>.ts',
    };

    it('excludes files from a default (non-code-ish) search', async () => {
      mockPoolQuery.mockImplementation(routeQuery({}));
      await call({ query: 'budget decision notes' });
      const sqls = mockPoolQuery.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(sqls.some((s) => s.includes('FROM public.files'))).toBe(false);
    });

    it('runs a labeled file lane for a code-ish query with no kinds', async () => {
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      mockPoolQuery.mockImplementation(
        routeQuery({
          docs: [
            {
              id: 'doc-1',
              title: 'Auth doc',
              updated_at: NOW,
              rank: 0.5,
              snippet: 'the **auth** middleware',
            },
          ],
          files: [fileRow],
        })
      );
      // "authMiddleware.ts" is code-ish (extension + camelCase) → lane fires.
      const out = await call({ query: 'authMiddleware.ts', project_id: 'proj-1' });
      // Shared-pool doc still present…
      expect(out).toContain('Auth doc');
      // …and the file lane is a separate, labeled section.
      expect(out).toContain('file lane');
      expect(out).toContain('src/authMiddleware.ts');
      expect(out).toContain('file-1');
    });

    it('shows only the file lane when the shared pool is empty', async () => {
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      mockPoolQuery.mockImplementation(routeQuery({ files: [fileRow] }));
      const out = await call({ query: 'getUserById', project_id: 'proj-1' });
      expect(out).toContain('No shared-pool matches');
      expect(out).toContain('file lane');
      expect(out).toContain('src/authMiddleware.ts');
    });

    it('prepends the honest-empty note (not the generic "no shared-pool matches" line) when the relevance floor withholds the pool but the file lane still has hits', async () => {
      // Semantic committed path: the pool has one doc candidate, but it scores
      // below the cross-encoder floor, so `visible` empties. The file lane
      // (its own, non-scored, identity-mocked rerank) still finds a file — the
      // composed output must say the shared pool was withheld, not empty.
      scoreById = new Map([['doc-1', COMMITTED_RERANK_FLOOR - 1]]);
      mockCreateQueryEmbedding.mockResolvedValue({
        vector: [0.1, 0.2, 0.3],
        modelId: 'test-model',
      });
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      mockPoolQuery.mockImplementation(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM public.nodes WHERE id = $1')) return { rows: [] };
        // File embeddings are content-addressed (their own table): the
        // file-kind candidate query hits public.file_embeddings, not the shared
        // public.embeddings node store.
        if (sql.includes('FROM public.file_embeddings')) {
          return {
            rows: [
              {
                id: 'file-1',
                kind: 'file',
                title: 'src/authMiddleware.ts',
                chunk_index: null,
                chunk_start: null,
                chunk_end: null,
              },
            ],
          };
        }
        if (sql.includes('FROM public.embeddings')) {
          return {
            rows: [
              {
                id: 'doc-1',
                kind: 'doc',
                title: 'Auth doc',
                chunk_index: null,
                chunk_start: null,
                chunk_end: null,
              },
            ],
          };
        }
        if (sql.includes('FROM public.docs')) {
          return {
            rows: [
              { id: 'doc-1', title: 'Auth doc', content: 'the auth middleware', updated_at: NOW },
            ],
          };
        }
        if (sql.includes('FROM public.files')) return { rows: [fileRow] };
        return { rows: [] };
      });

      // "authMiddleware.ts" is code-ish (extension + camelCase) → lane fires;
      // mode:'semantic' with no explicit kinds routes through the committed
      // multi-kind semantic path (the one the relevance floor gates).
      const out = await call({
        query: 'authMiddleware.ts',
        mode: 'semantic',
        project_id: 'proj-1',
      });

      expect(out).toContain('No strongly-relevant matches for "authMiddleware.ts"');
      expect(out).toContain('weaker candidate(s)');
      expect(out).toContain('file lane');
      expect(out).toContain('src/authMiddleware.ts');
      // The uninformative generic empty-pool note must not also appear.
      expect(out).not.toContain('No shared-pool matches');
    });

    it('does not run the file lane when explicit kinds omit file', async () => {
      // Code-ish query, but the caller explicitly asked for docs only → honored
      // literally, no lane.
      mockPoolQuery.mockImplementation(routeQuery({}));
      await call({ query: 'authMiddleware.ts', kinds: ['doc'] });
      const sqls = mockPoolQuery.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(sqls.some((s) => s.includes('FROM public.files'))).toBe(false);
    });

    it('searches files inline (no lane) when kinds:["file"] is explicit', async () => {
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      mockPoolQuery.mockImplementation(routeQuery({ files: [fileRow] }));
      const out = await call({ query: 'auth', kinds: ['file'], project_id: 'proj-1' });
      const sqls = mockPoolQuery.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(sqls.some((s) => s.includes('FROM public.files'))).toBe(true);
      // Rendered as a normal result set, not the "file lane" labeled section.
      expect(out).toContain('src/authMiddleware.ts');
      expect(out).not.toContain('file lane');
    });

    it('falls back to bounded grep for explicit keyword file search at zero coverage', async () => {
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      mockGetProjectFileEmbeddingCoverage.mockResolvedValue({ embeddedFiles: 0, totalFiles: 4 });
      mockGrepFileFallback.mockResolvedValue({
        hits: [
          {
            path: path.join(PROJECT_ROOT, 'src', 'authMiddleware.ts'),
            relativePath: 'src/authMiddleware.ts',
            score: 1,
            matchedOn: 'grep',
            indexed: false,
            matchSource: 'path',
          },
        ],
        scannedEntries: 7,
        scannedFiles: 4,
        scannedBytes: 512,
        truncated: false,
      });
      mockPoolQuery.mockImplementation(routeQuery({ files: [fileRow] }));

      const out = await call({
        query: 'authMiddleware',
        kinds: ['file'],
        project_id: 'proj-1',
      });

      expect(out).toContain('matchedOn: grep');
      expect(out).toContain('indexed: false');
      expect(out).toContain(path.join(PROJECT_ROOT, 'src', 'authMiddleware.ts'));
      expect(out).toContain('coverage 0/4');
      const sqls = mockPoolQuery.mock.calls.map((call: unknown[]) => call[0] as string);
      expect(sqls.some((sql) => sql.includes('FROM public.files'))).toBe(false);
      expect(mockResolveEmbeddingProvider).not.toHaveBeenCalled();
    });

    it('falls back to bounded grep for an automatic code-ish keyword lane at zero coverage', async () => {
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      mockGetProjectFileEmbeddingCoverage.mockResolvedValue({ embeddedFiles: 0, totalFiles: 2 });
      mockGrepFileFallback.mockResolvedValue({
        hits: [
          {
            path: path.join(PROJECT_ROOT, 'src', 'getUserById.ts'),
            relativePath: 'src/getUserById.ts',
            score: 1,
            matchedOn: 'grep',
            indexed: false,
            matchSource: 'content',
            line: 12,
          },
        ],
        scannedEntries: 5,
        scannedFiles: 2,
        scannedBytes: 256,
        truncated: false,
      });
      mockPoolQuery.mockImplementation(routeQuery({ files: [fileRow] }));

      const out = await call({ query: 'getUserById', project_id: 'proj-1' });

      expect(out).toContain('matchedOn: grep');
      expect(out).toContain('indexed: false');
      expect(out).toContain(`${path.join(PROJECT_ROOT, 'src', 'getUserById.ts')}:12`);
      const sqls = mockPoolQuery.mock.calls.map((call: unknown[]) => call[0] as string);
      expect(sqls.some((sql) => sql.includes('FROM public.files'))).toBe(false);
      expect(mockResolveEmbeddingProvider).not.toHaveBeenCalled();
    });

    it('uses an honestly labeled grep fallback when explicit file search has zero coverage', async () => {
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      mockGetProjectFileEmbeddingCoverage.mockResolvedValue({ embeddedFiles: 0, totalFiles: 3 });
      mockGrepFileFallback.mockResolvedValue({
        hits: [
          {
            path: path.join(PROJECT_ROOT, 'src', 'authMiddleware.ts'),
            relativePath: 'src/authMiddleware.ts',
            score: 1,
            matchedOn: 'grep',
            indexed: false,
            matchSource: 'content',
            line: 7,
          },
        ],
        scannedEntries: 12,
        scannedFiles: 8,
        scannedBytes: 4096,
        truncated: true,
      });

      const out = await callWithDefaults({
        query: 'auth middleware',
        kinds: ['file'],
        mode: 'hybrid',
        project_id: 'proj-1',
      });

      expect(out).toContain('matchedOn: grep');
      expect(out).toContain('indexed: false');
      expect(out).toContain(`${path.join(PROJECT_ROOT, 'src', 'authMiddleware.ts')}:7`);
      expect(out).toContain('coverage 0/3');
      expect(out).toContain('truncated: true');
      expect(mockGrepFileFallback).toHaveBeenCalledWith(
        expect.objectContaining({ projectRoot: PROJECT_ROOT, searchPath: PROJECT_ROOT })
      );
      const sqls = mockPoolQuery.mock.calls.map((call: unknown[]) => call[0] as string);
      expect(sqls.some((sql) => sql.includes('FROM public.file_embeddings'))).toBe(false);
    });

    it('applies exclude_ids to filesystem fallback paths', async () => {
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      mockGetProjectFileEmbeddingCoverage.mockResolvedValue({ embeddedFiles: 0, totalFiles: 2 });
      mockGrepFileFallback.mockResolvedValue({
        hits: [
          {
            path: path.join(PROJECT_ROOT, 'src', 'excluded.ts'),
            relativePath: 'src/excluded.ts',
            score: 1,
            matchedOn: 'grep',
            indexed: false,
            matchSource: 'content',
          },
          {
            path: path.join(PROJECT_ROOT, 'src', 'visible.ts'),
            relativePath: 'src/visible.ts',
            score: 1,
            matchedOn: 'grep',
            indexed: false,
            matchSource: 'content',
          },
        ],
        scannedEntries: 2,
        scannedFiles: 2,
        scannedBytes: 100,
        truncated: false,
      });
      const baseRoute = routeQuery({});
      mockPoolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('WHERE f.id = ANY')) {
          return { rows: [{ folder_path: PROJECT_ROOT, relative_path: 'src/excluded.ts' }] };
        }
        return baseRoute(sql, params);
      });

      const out = await callWithDefaults({
        query: 'needle',
        kinds: ['file'],
        mode: 'semantic',
        project_id: 'proj-1',
        exclude_ids: ['file-excluded'],
      });

      expect(out).not.toContain(path.join(PROJECT_ROOT, 'src', 'excluded.ts'));
      expect(out).toContain(path.join(PROJECT_ROOT, 'src', 'visible.ts'));
    });

    it('reports fallback unavailable when no real project folder resolves', async () => {
      mockProjectsFindById.mockResolvedValue(null);

      const out = await callWithDefaults({
        query: 'needle',
        kinds: ['file'],
        mode: 'semantic',
        project_id: 'missing-project',
      });

      expect(out).toContain('matchedOn: unavailable');
      expect(out).toContain('indexed: false');
      expect(out).toContain('No real project folder could be resolved');
      expect(mockGrepFileFallback).not.toHaveBeenCalled();
    });

    it('keeps the main results when the file lane throws', async () => {
      mockProjectsFindById.mockResolvedValue({ id: 'proj-1', folderPath: PROJECT_ROOT });
      // The lane is an enhancement, never a dependency: its underlying
      // `public.files` query blows up, but the shared-pool doc hit must
      // still come back — the lane failure must not reject the whole call.
      const baseRoute = routeQuery({
        docs: [
          {
            id: 'doc-1',
            title: 'Auth doc',
            updated_at: NOW,
            rank: 0.5,
            snippet: 'the **auth** middleware',
          },
        ],
      });
      mockPoolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM public.files')) throw new Error('file lane boom');
        return baseRoute(sql, params);
      });
      // "authMiddleware.ts" is code-ish (extension + camelCase) → lane fires.
      const out = await call({ query: 'authMiddleware.ts', project_id: 'proj-1' });
      expect(out).toContain('Auth doc');
      expect(out).not.toContain('file lane');
    });
  });

  describe('bare-id resolution shortcut', () => {
    it('skips the lookup when query has whitespace (prose, not an id)', async () => {
      mockPoolQuery.mockImplementation(routeQuery({}));
      await call({ query: 'hello world' });
      const sqls = mockPoolQuery.mock.calls.map((c: unknown[]) => c[0] as string);
      // The nodes lookup must not have fired for a multi-word query.
      expect(sqls.some(isNodesLookup)).toBe(false);
    });

    it('falls through to normal search when the id has no matching node', async () => {
      mockPoolQuery.mockImplementation(routeQuery({ nodes: [] }));
      const out = await call({ query: 'thread-does-not-exist' });
      // Falls through → normal lexical search (which finds nothing).
      expect(out).toMatch(/No results for/);
    });

    it('resolves a prefixed thread id and returns the enriched thread hit', async () => {
      mockPoolQuery.mockImplementation(
        routeQuery({
          nodes: [{ type: 'thread' }],
          threads: [{ id: 'thread-1', title: 'Planning', updated_at: NOW }],
        })
      );
      mockThreadParticipantsListByThread.mockResolvedValue([{ agentId: 'agent-1' }]);
      mockAgentsFindByIds.mockResolvedValue([{ id: 'agent-1', name: 'Venus' }]);
      mockMessagesListRecentByThreadId.mockResolvedValue([
        { id: 'm1', authorAgentId: 'agent-1', content: 'kick off', createdAt: NOW },
      ]);
      const out = await call({ query: 'thread-1' });
      expect(out).toContain('Resolved id "thread-1" → thread');
      expect(out).toContain('Planning');
      expect(out).toContain('Venus');
    });

    it('resolves an explicit doc id and can return the full document body', async () => {
      mockPoolQuery.mockImplementation(
        routeQuery({
          nodes: [{ type: 'doc' }],
          docs: [
            {
              id: 'doc-1',
              title: 'Full Doc',
              updated_at: NOW,
              content: 'line one\n\nline two with details',
            },
          ],
        })
      );

      const out = await call({ id: 'doc-1', detail: 'full' });

      expect(out).toContain('Resolved id "doc-1" → doc');
      expect(out).toContain('Content:');
      expect(out).toContain('line one\n\nline two with details');
    });

    it('resolves multiple explicit ids in one call', async () => {
      // Tasks are docs now, so a multi-id lookup resolves two doc nodes.
      mockPoolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        const id = params?.[0];
        if (sql.includes('FROM public.nodes WHERE id = $1')) {
          if (id === 'doc-1' || id === 'doc-2') return { rows: [{ type: 'doc' }] };
          return { rows: [] };
        }
        if (sql.includes('FROM public.docs')) {
          if (id === 'doc-2') {
            return {
              rows: [{ id: 'doc-2', title: 'Doc Two', updated_at: NOW, content: 'doc two body' }],
            };
          }
          return {
            rows: [{ id: 'doc-1', title: 'Doc One', updated_at: NOW, content: 'doc body' }],
          };
        }
        return { rows: [] };
      });

      const out = await call({ ids: ['doc-1', 'doc-2'] });

      expect(out).toContain('2 id lookup(s):');
      expect(out).toContain('Doc One');
      expect(out).toContain('Doc Two');
    });

    it('resolves an image id through the image renderer (missing row reported)', async () => {
      mockPoolQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM public.nodes WHERE id = $1')) return { rows: [{ type: 'image' }] };
        return { rows: [] };
      });
      const out = await call({ query: 'image-abc' });
      expect(out).toContain('Resolved id "image-abc" → image');
      expect(out).toContain('image row is missing');
    });

    it('returns a generic message for kinds that have no detail renderer', async () => {
      mockPoolQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM public.nodes WHERE id = $1')) {
          // A node type outside the renderer switch exercises the fallback.
          return { rows: [{ type: 'mystery_kind' }] };
        }
        return { rows: [] };
      });
      const out = await call({ query: 'node-xyz' });
      expect(out).toContain('no detail renderer');
    });
  });

  describe('explicit search modes', () => {
    it('keeps question and command phrasing on the same explicit hybrid path', async () => {
      await callWithDefaults({ query: 'where is the launch plan', kinds: ['doc'] });
      await callWithDefaults({ query: 'find the launch plan', kinds: ['doc'] });

      expect(mockSearchNodes).toHaveBeenCalledTimes(2);
      expect(mockSearchNodes.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          query: 'where is the launch plan',
          kind: 'doc',
          mode: 'hybrid',
          scope: { container_id: 'root' },
        })
      );
      expect(mockSearchNodes.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          query: 'find the launch plan',
          kind: 'doc',
          mode: 'hybrid',
          scope: { container_id: 'root' },
        })
      );
    });

    it('rejects the removed agent fuzzy mode before retrieval', async () => {
      const out = await call({ query: 'rernker swp', mode: 'fuzzy', kinds: ['doc'] });

      expect(out).toBe('mode must be one of: hybrid, semantic, or keyword.');
      expect(mockPoolQuery).not.toHaveBeenCalled();
      expect(mockCreateQueryEmbedding).not.toHaveBeenCalled();
      expect(mockSearchNodes).not.toHaveBeenCalled();
    });
  });
});
