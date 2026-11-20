import { beforeEach, describe, expect, it } from '@jest/globals';
import type { ContainerRow } from '@snaglet/db/tables/containers';

// Mocks are reassigned per-test where SQL routing logic differs; defaults
// return empty results so a test that exercises just one kind doesn't have
// to set up all four.
const query = jest.fn();
const listContainers = jest.fn();
const listRecentMessages = jest.fn();
const listParticipants = jest.fn();
const findAgentsByIds = jest.fn();
const searchNodes = jest.fn();
const createQueryEmbedding = jest.fn();
const readSearchPreferences = jest.fn();

jest.mock('@snaglet/db', () => ({
  getPool: () => ({ query: (...args: unknown[]) => query(...args) }),
  // Tests mock the engine-agnostic getDb() facade.
  getDb: () => ({ query: (...args: unknown[]) => query(...args) }),
}));

jest.mock('@snaglet/db/tables/containers', () => ({
  Containers: {
    listAllOrdered: (...args: unknown[]) => listContainers(...args),
  },
}));

jest.mock('@snaglet/db/tables/messages', () => ({
  Messages: {
    listRecentByThreadId: (...args: unknown[]) => listRecentMessages(...args),
  },
}));

jest.mock('@snaglet/db/tables/thread_participants', () => ({
  ThreadParticipants: {
    listByThread: (...args: unknown[]) => listParticipants(...args),
  },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    findByIds: (...args: unknown[]) => findAgentsByIds(...args),
  },
}));

// Thread hits render an opening summary when one exists; without this mock
// the formatter reaches the real model (and a real pg pool — which hangs
// under this suite's fake timers).
jest.mock('@snaglet/db/tables/thread_summaries', () => ({
  ThreadSummaries: {
    getByThread: jest.fn(async () => null),
  },
}));

jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: {
    findById: jest.fn(async () => null),
  },
}));

jest.mock('@server/services/search/nodeSearch.js', () => ({
  workspaceSearchNodes: (...args: unknown[]) => searchNodes(...args),
  createQueryEmbedding: (...args: unknown[]) => createQueryEmbedding(...args),
}));

// The consumer migrated from `readSearchPreferences()` to
// `settingsService.read(searchSettings.preferences)` — same shape returned,
// just routed through the new registry. Mock the read at the service.
jest.mock('@server/services/settings/index.js', () => ({
  settingsService: {
    read: (...args: unknown[]) => readSearchPreferences(...args),
  },
}));
jest.mock('@server/services/settings/categories/search.js', () => ({
  searchSettings: { preferences: { category: 'search', key: 'preferences' } },
}));

import rawWorkspaceSearchTool, {
  composeWithFileLane,
} from '@server/services/ToolService/handlers/search/workspaceSearch/workspaceSearch';
import { renderHonestEmpty } from '@server/services/ToolService/handlers/search/workspaceSearch/committedSearch';
import type { FileHit } from '@server/services/ToolService/handlers/search/workspaceSearch/types';

const FIXED_NOW = Date.parse('2026-05-21T12:00:00Z');

async function workspaceSearchTool(
  input: Record<string, unknown>,
  settings: Record<string, unknown>
): Promise<string> {
  const explicitInput =
    input.mode === undefined && typeof input.query === 'string' && input.query.trim()
      ? { ...input, mode: 'keyword' }
      : input;
  return rawWorkspaceSearchTool(explicitInput, settings, {}) as Promise<string>;
}

function makeContainer(overrides: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: 'container-1',
    parentId: null,
    name: 'Root',
    sortOrder: 0,
    x: null,
    y: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Route a single mocked `query` call to the right rows based on which SQL
 * fragment the tool dispatched. Lets every test express its intent as
 * "this kind returns these rows" without caring about call order.
 */
function routeQueries(
  rowsByKind: Partial<{
    doc: unknown[];
    thread: unknown[];
    container: unknown[];
    message: unknown[];
    task: unknown[];
    memory: unknown[];
    threadSummary: unknown[];
    post: unknown[];
    tool: unknown[];
    nodes: unknown[];
  }>
) {
  query.mockImplementation((sql: string) => {
    if (sql.includes('FROM public.nodes WHERE id = $1'))
      return Promise.resolve({ rows: rowsByKind.nodes ?? [] });
    if (sql.includes('FROM public.docs')) return Promise.resolve({ rows: rowsByKind.doc ?? [] });
    if (sql.includes('FROM public.threads'))
      return Promise.resolve({ rows: rowsByKind.thread ?? [] });
    // No `FROM public.projects` branch: a project is a container with
    // category='project', so it never surfaces its own table in search.
    if (sql.includes('FROM public.containers'))
      return Promise.resolve({ rows: rowsByKind.container ?? [] });
    if (sql.includes('FROM public.messages'))
      return Promise.resolve({ rows: rowsByKind.message ?? [] });
    if (sql.includes('FROM public.tasks')) return Promise.resolve({ rows: rowsByKind.task ?? [] });
    if (sql.includes('FROM public.memories'))
      return Promise.resolve({ rows: rowsByKind.memory ?? [] });
    if (sql.includes('FROM public.thread_summaries'))
      return Promise.resolve({ rows: rowsByKind.threadSummary ?? [] });
    if (sql.includes('FROM public.posts')) return Promise.resolve({ rows: rowsByKind.post ?? [] });
    if (sql.includes('FROM public.tools')) return Promise.resolve({ rows: rowsByKind.tool ?? [] });
    return Promise.resolve({ rows: [] });
  });
}

describe('workspace_search tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.mockResolvedValue({ rows: [] });
    listContainers.mockResolvedValue([]);
    listRecentMessages.mockResolvedValue([]);
    listParticipants.mockResolvedValue([]);
    findAgentsByIds.mockResolvedValue([]);
    searchNodes.mockReset();
    createQueryEmbedding.mockReset();
    readSearchPreferences.mockReset();
    searchNodes.mockResolvedValue({
      hits: [],
      scope_applied: { mode: 'root', source: 'explicit_container' },
      scope_source: 'explicit_container',
    });
    createQueryEmbedding.mockResolvedValue(null);
    readSearchPreferences.mockResolvedValue({
      useVector: true,
      useFts: true,
      useGraphWalk: true,
      threadBoost: true,
    });
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });

  // Validation

  it('rejects empty queries', async () => {
    const out = await workspaceSearchTool({ query: '   ' }, {});
    expect(out).toBe('Search query or id is required.');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns no-results message when every kind comes back empty', async () => {
    routeQueries({});
    const out = await workspaceSearchTool({ query: 'nothing' }, {});
    expect(out).toBe('No results for "nothing".');
  });

  it('keeps inferred kinds soft in the agent lexical path', async () => {
    routeQueries({});

    await workspaceSearchTool({ query: 'images from the launch' }, {});

    const sqls = query.mock.calls.map((call) => call[0] as string);
    expect(sqls.some((sql) => sql.includes('FROM public.images'))).toBe(true);
    expect(sqls.some((sql) => sql.includes('FROM public.docs'))).toBe(true);
    expect(sqls.some((sql) => sql.includes('FROM public.threads'))).toBe(true);
  });

  it('passes explicit time_range into mixed lexical search SQL', async () => {
    routeQueries({});

    await workspaceSearchTool(
      {
        query: 'search',
        kinds: ['doc'],
        time_range: {
          from: '2026-05-01',
          to: '2026-06-01',
        },
      },
      {}
    );

    const docCall = query.mock.calls.find((call) =>
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
    routeQueries({});

    await workspaceSearchTool(
      {
        query: 'search',
        kinds: ['doc', 'message'],
        time_range: {
          from: '2026-05-01',
          to: '2026-06-01',
        },
      },
      {}
    );

    const messageCall = query.mock.calls.find((call) =>
      (call[0] as string).includes('FROM public.messages')
    );
    expect(messageCall).toBeDefined();
    expect(messageCall?.[0]).toContain('m.created_at');
    expect(messageCall?.[0]).not.toContain('mn.created_at');
  });

  it('filters lexical searchable node tables on their own created_at columns', async () => {
    routeQueries({});

    await workspaceSearchTool(
      {
        query: 'search',
        kinds: ['doc', 'container', 'thread', 'memory', 'thread_summary'],
        time_range: {
          from: '2026-05-01',
          to: '2026-06-01',
          field: 'created_at',
        },
      },
      {}
    );

    const sqlFor = (needle: string) =>
      query.mock.calls.find((call) => (call[0] as string).includes(needle))?.[0] as
        | string
        | undefined;

    expect(sqlFor('FROM public.docs')).toContain('d.created_at');
    expect(sqlFor('FROM public.containers')).toContain('c.created_at');
    expect(sqlFor('FROM public.threads')).toContain('t.created_at');
    expect(sqlFor('FROM public.memories')).toContain('m.created_at');
    expect(sqlFor('FROM public.thread_summaries')).toContain('ts.created_at');
  });

  // Doc results (the existing path)

  it('renders doc hits with the 📄 glyph, snippet, and recency', async () => {
    routeQueries({
      doc: [
        {
          id: 'doc-1',
          title: 'Concurrency Notes',
          updated_at: new Date(FIXED_NOW - 2 * 60 * 60_000).toISOString(),
          rank: 0.31,
          snippet: 'the **mutex** locks are acquired in order',
        },
      ],
    });

    const out = await workspaceSearchTool({ query: 'mutex' }, {});

    expect(out).toContain('1 result(s) for "mutex":');
    expect(out).toContain('📄 [Concurrency Notes](doc-1) · 2h ago');
    expect(out).toContain('the **mutex** locks are acquired in order');
  });

  it('appends … when a doc snippet was cut mid-thought', async () => {
    routeQueries({
      doc: [
        {
          id: 'doc-1',
          title: 'X',
          updated_at: new Date(FIXED_NOW).toISOString(),
          rank: 0.5,
          snippet: 'including pages, **docs**',
        },
      ],
    });
    const out = await workspaceSearchTool({ query: 'docs' }, {});
    expect(out).toContain('including pages, **docs**…');
  });

  // Thread hits with enrichment

  it('enriches thread hits with participants and the last 10 messages', async () => {
    routeQueries({
      thread: [
        {
          id: 'thread-1',
          title: 'Auth refactor',
          updated_at: new Date(FIXED_NOW - 30 * 60_000).toISOString(),
        },
      ],
    });
    listParticipants.mockResolvedValue([{ agentId: 'agent-venus' }, { agentId: 'agent-clio' }]);
    findAgentsByIds.mockResolvedValue([
      { id: 'agent-venus', name: 'Venus' },
      { id: 'agent-clio', name: 'Clio' },
    ]);
    listRecentMessages.mockResolvedValue([
      {
        agentId: 'agent-venus',
        role: 'assistant',
        content: 'Two options for the callback wiring',
        createdAt: new Date(FIXED_NOW - 30 * 60_000).toISOString(),
      },
      {
        agentId: null,
        role: 'user',
        content: 'What about legacy flow',
        createdAt: new Date(FIXED_NOW - 25 * 60_000).toISOString(),
      },
    ]);

    const out = await workspaceSearchTool({ query: 'auth' }, {});

    expect(out).toContain('💬 [Auth refactor](thread-1)');
    expect(out).toContain('Participants: Venus, Clio');
    expect(out).toContain('Last 2 message(s)');
    expect(out).toContain('Two options for the callback wiring');
    expect(out).toContain('What about legacy flow');
    expect(listRecentMessages).toHaveBeenCalledWith('thread-1', 10);
  });

  it('handles threads with no participants and no messages gracefully', async () => {
    routeQueries({
      thread: [
        {
          id: 'thread-empty',
          title: 'Empty',
          updated_at: new Date(FIXED_NOW).toISOString(),
        },
      ],
    });

    const out = await workspaceSearchTool({ query: 'Empty' }, {});

    expect(out).toContain('💬 [Empty](thread-empty)');
    expect(out).toContain('(no participants)');
    expect(out).toContain('(no messages yet)');
  });

  // A project is a container with category='project', so it surfaces through
  // the container-hit path, covered by "renders container hits with their full
  // path" below.

  // Container hits

  it('renders container hits with their full path', async () => {
    listContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', parentId: null }),
      // Plain container: this test is about PATH rendering, and a category
      // marker is a separate concern with its own coverage.
      makeContainer({ id: 'container-docs', name: 'docs', parentId: 'container-snaglet' }),
    ]);
    routeQueries({
      container: [
        {
          id: 'container-docs',
          name: 'docs',
          parent_id: 'container-snaglet',
          updated_at: new Date(FIXED_NOW - 5 * 60_000).toISOString(),
        },
      ],
    });

    const out = await workspaceSearchTool({ query: 'docs' }, {});

    expect(out).toContain('📂 [docs](container-docs)');
    expect(out).toContain('Path: /Snaglet/docs');
  });

  // `kinds` filter

  it('only queries the requested kinds when `kinds` is set', async () => {
    routeQueries({ doc: [] });
    await workspaceSearchTool({ query: 'x', kinds: ['doc'] }, {});

    const sqls = query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('FROM public.docs'))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM public.threads'))).toBe(false);
    expect(sqls.some((s) => s.includes('FROM public.projects'))).toBe(false);
    expect(sqls.some((s) => s.includes('FROM public.containers'))).toBe(false);
    expect(sqls.some((s) => s.includes('FROM public.messages'))).toBe(false);
  });

  it('routes explicit doc-only hybrid search through workspaceSearchNodes', async () => {
    searchNodes.mockResolvedValueOnce({
      hits: [{ node_id: 'doc-1', score: 0.42, channels: ['fts', 'vector'] }],
      scope_applied: { mode: 'root', source: 'explicit_container' },
      scope_source: 'explicit_container',
    });
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'doc-1',
          title: 'Hybrid Docs',
          updated_at: new Date(FIXED_NOW).toISOString(),
          snippet: 'notes about **hybrid** docs',
        },
      ],
    });

    const out = await workspaceSearchTool(
      { query: 'hybrid docs', kinds: ['doc'], mode: 'hybrid', limit: 3 },
      {}
    );

    // Committed path fetches a bounded POOL (poolSize for limit 3 = 16) and
    // reranks it in the finish pipeline, so rerank is off on the node-search call.
    expect(searchNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'hybrid docs',
        kind: 'doc',
        scope: { container_id: 'root' },
        limit: 16,
        mode: 'hybrid',
        rerank: false,
      })
    );
    expect(out).toContain('📄 [Hybrid Docs](doc-1)');
    expect(out).toContain('fts+vector');
    expect(out).toContain('score 0.4200');
  });

  it('routes explicit message search through hybrid workspaceSearchNodes by default', async () => {
    searchNodes.mockResolvedValueOnce({
      hits: [{ node_id: 'message-1', score: 0.42, channels: ['fts', 'vector'] }],
      scope_applied: { mode: 'root', source: 'explicit_container' },
      scope_source: 'explicit_container',
    });
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 'message-1',
          thread_id: 'thread-1',
          thread_title: 'Planning',
          role: 'assistant',
          agent_id: 'agent-venus',
          agent_name: 'Venus',
          user_id: null,
          user_name: null,
          created_at: new Date(FIXED_NOW).toISOString(),
          snippet: 'talked about **hybrid** search',
        },
      ],
    });

    const out = await rawWorkspaceSearchTool(
      { query: 'hybrid search', kinds: ['message'], limit: 3 },
      {},
      {}
    );

    expect(searchNodes).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'hybrid search',
        kind: 'message',
        scope: { container_id: 'root' },
        limit: 16,
        mode: 'hybrid',
        rerank: false,
      })
    );
    expect(out).toContain('[Message](message-1)');
    expect(out).toContain('Thread: [Planning](thread-1) (thread-1)');
    expect(out).toContain('Sender: Venus');
    expect(out).toContain('Date: 2026-05-21T12:00:00.000Z');
    expect(out).toContain('talked about **hybrid** search');
    expect(out).toContain('fts+vector');
  });

  it('searches messages in mixed lexical mode', async () => {
    routeQueries({
      message: [
        {
          id: 'message-1',
          thread_id: 'thread-1',
          thread_title: 'Planning',
          role: 'assistant',
          agent_id: 'agent-venus',
          agent_name: 'Venus',
          user_id: null,
          user_name: null,
          created_at: new Date(FIXED_NOW).toISOString(),
          rank: 0.42,
          snippet: 'talked about **hybrid** search',
        },
      ],
    });

    const out = await workspaceSearchTool({ query: 'hybrid', kinds: ['doc', 'message'] }, {});

    expect(searchNodes).not.toHaveBeenCalled();
    expect(out).toContain('[Message](message-1)');
    expect(out).toContain('Thread: [Planning](thread-1) (thread-1)');
    expect(out).toContain('Sender: Venus');
  });

  it('rejects hybrid workspace mode unless the search is doc-only, task-only, or message-only', async () => {
    const out = await workspaceSearchTool(
      { query: 'hybrid', kinds: ['memory', 'tool'], mode: 'hybrid' },
      {}
    );
    expect(out).toContain('semantic-capable kinds only');
    expect(searchNodes).not.toHaveBeenCalled();
  });

  it('supports semantic search for context-domain kinds through workspace_search', async () => {
    createQueryEmbedding.mockResolvedValue({
      vector: [0.1, 0.2, 0.3],
      modelId: 'test:model',
    });
    readSearchPreferences.mockResolvedValue({
      useVector: true,
      useFts: true,
      useGraphWalk: false,
      threadBoost: true,
    });
    query.mockImplementation(async (sql: string) => {
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
              updated_at: new Date(FIXED_NOW).toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const out = await workspaceSearchTool(
      {
        query: 'meaning based retrieval',
        kinds: ['memory'],
        mode: 'semantic',
        graph_depth: 0,
      },
      {}
    );

    expect(createQueryEmbedding).toHaveBeenCalledWith('meaning based retrieval');
    expect(out).toContain('🧠 [search-plan](memory-1)');
    expect(out).toContain('Semantic search should find this memory');
  });

  it('renders knowledge-domain hits in default lexical search', async () => {
    routeQueries({
      message: [
        {
          id: 'message-1',
          thread_id: 'thread-1',
          thread_title: 'Search thread',
          role: 'assistant',
          agent_id: 'agent-1',
          agent_name: 'Venus',
          user_id: null,
          user_name: null,
          created_at: new Date(FIXED_NOW).toISOString(),
          rank: 0.42,
          snippet: 'Workspace **search** includes messages now',
        },
      ],
      memory: [
        {
          id: 'memory-1',
          memory_key: 'search-plan',
          content: 'Workspace search should own knowledge retrieval',
          agent_id: 'agent-1',
          source_thread_id: 'thread-1',
          updated_at: new Date(FIXED_NOW).toISOString(),
        },
      ],
      tool: [
        {
          id: 'workspace_search',
          name: 'Workspace Search',
          description: 'Search workspace knowledge',
          category_path: 'knowledge/workspace/navigation',
          tier: 'standard',
          is_active: true,
          updated_at: new Date(FIXED_NOW).toISOString(),
        },
      ],
    });

    const out = await workspaceSearchTool({ query: 'search' }, {});

    expect(out).toContain('[Message](message-1)');
    expect(out).toContain('🧠 [search-plan](memory-1)');
    expect(out).toContain('🔧 [Workspace Search](tool:workspace_search)');
  });

  it('fetches a full doc by explicit id', async () => {
    routeQueries({
      nodes: [{ type: 'doc' }],
      doc: [
        {
          id: 'doc-1',
          title: 'Full Doc',
          updated_at: new Date(FIXED_NOW).toISOString(),
          content: 'line one\n\nline two with details',
        },
      ],
    });

    const out = await workspaceSearchTool({ id: 'doc-1', detail: 'full' }, {});

    expect(out).toContain('Resolved id "doc-1" → doc');
    expect(out).toContain('Content:');
    expect(out).toContain('line one\n\nline two with details');
  });

  it('accepts a comma-separated string for `kinds`', async () => {
    routeQueries({});
    await workspaceSearchTool({ query: 'x', kinds: 'thread, container' }, {});
    const sqls = query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes('FROM public.threads'))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM public.containers'))).toBe(true);
    expect(sqls.some((s) => s.includes('FROM public.docs'))).toBe(false);
  });

  // Scope filters

  it('passes allowed-ids to every per-kind SQL when scoped by container_id', async () => {
    listContainers.mockResolvedValue([
      makeContainer({ id: 'container-root' }),
      makeContainer({ id: 'container-child', parentId: 'container-root' }),
      makeContainer({ id: 'container-other', parentId: null }),
    ]);

    await workspaceSearchTool({ query: 'foo', container_id: 'container-root' }, {});

    for (const [sql, params] of query.mock.calls as [string, unknown[]][]) {
      if (sql.includes('FROM public.nodes WHERE id = $1')) continue;
      const allowed = params[1] as string[];
      expect(new Set(allowed)).toEqual(new Set(['container-root', 'container-child']));
    }
  });

  it('does not infer project scope from natural-language query text', async () => {
    listContainers.mockResolvedValue([
      makeContainer({ id: 'project-snaglet', name: 'Snaglet', category: 'project' }),
      makeContainer({ id: 'container-child', parentId: 'project-snaglet' }),
      makeContainer({ id: 'project-other', name: 'Other', category: 'project' }),
    ]);
    routeQueries({});

    await workspaceSearchTool({ query: 'needle in Snaglet', kinds: ['doc'], mode: 'keyword' }, {});

    const docCall = query.mock.calls.find((call) =>
      (call[0] as string).includes('FROM public.docs')
    );
    expect(docCall?.[1]?.[0]).toBe('needle in Snaglet');
    expect(docCall?.[1]?.[1]).toBeNull();
    expect(listContainers).not.toHaveBeenCalled();
  });

  it('returns an error message (no SQL) when the path is unresolvable', async () => {
    listContainers.mockResolvedValue([makeContainer({ id: 'container-snaglet', name: 'Snaglet' })]);
    const out = await workspaceSearchTool({ query: 'foo', path: '/Snaglet/missing' }, {});
    expect(out).toContain('No container "missing"');
    expect(query).not.toHaveBeenCalled();
  });

  it('returns disambiguation paths (no SQL) when `name` is ambiguous', async () => {
    listContainers.mockResolvedValue([
      makeContainer({ id: 'container-snaglet', name: 'Snaglet', parentId: null }),
      makeContainer({ id: 'container-snaglet-docs', name: 'docs', parentId: 'container-snaglet' }),
      makeContainer({ id: 'container-coding', name: 'Coding', parentId: null }),
      makeContainer({ id: 'container-coding-docs', name: 'docs', parentId: 'container-coding' }),
    ]);

    const out = await workspaceSearchTool({ query: 'foo', name: 'docs' }, {});

    expect(out).toContain('Multiple containers named "docs"');
    expect(out).toContain('/Snaglet/docs');
    expect(out).toContain('/Coding/docs');
    expect(query).not.toHaveBeenCalled();
  });

  it('trims whitespace-only filter inputs and treats them as absent', async () => {
    routeQueries({});
    await workspaceSearchTool({ query: 'foo', container_id: '   ', path: '', name: '  ' }, {});
    for (const [sql, params] of query.mock.calls as [string, unknown[]][]) {
      if (sql.includes('FROM public.nodes WHERE id = $1')) continue;
      expect(params[1]).toBeNull();
    }
    expect(listContainers).not.toHaveBeenCalled();
  });

  // Limit clamp

  it('clamps limit to [1, 50]', async () => {
    routeQueries({});

    await workspaceSearchTool({ query: 'x', limit: 999 }, {});
    expect(query.mock.calls.length).toBeGreaterThan(0);
    for (const [, params] of query.mock.calls as [string, unknown[]][]) {
      expect(params[params.length - 1]).toBe(50);
    }

    query.mockClear();
    routeQueries({});
    await workspaceSearchTool({ query: 'x', limit: 0 }, {});
    expect(query.mock.calls.length).toBeGreaterThan(0);
    for (const [, params] of query.mock.calls as [string, unknown[]][]) {
      expect(params[params.length - 1]).toBe(1);
    }
  });

  // File-lane composition (relevance floor + honest-empty note)

  function fileHit(id: string): FileHit {
    return {
      kind: 'file',
      id,
      relativePath: `src/${id}.ts`,
      projectId: 'project-1',
      sizeBytes: 42,
      updatedAt: new Date(FIXED_NOW).toISOString(),
    };
  }

  describe('composeWithFileLane', () => {
    it('shows only the lane section, with no note, when the pool never had candidates', () => {
      const out = composeWithFileLane('needle', [], new Map(), [fileHit('file-1')]);
      expect(out).toContain('No shared-pool matches for "needle".');
      expect(out).toContain('Files (1)');
    });

    it('prepends the honest-empty note when the relevance floor withheld the pool but the file lane has hits', () => {
      // Mirrors the semantic committed path: the floor emptied `visible` (all
      // pool candidates fell below the relevance floor) while the file lane
      // still found hits — the composed output must say the pool was
      // withheld, not that it was empty, and still show the lane section.
      const honestEmpty = renderHonestEmpty('needle', 3);
      const out = composeWithFileLane(
        'needle',
        [],
        new Map(),
        [fileHit('file-1')],
        undefined,
        honestEmpty
      );
      expect(out).toContain('No strongly-relevant matches for "needle".');
      expect(out).toContain('3 weaker candidate(s)');
      expect(out).toContain('Files (1)');
      expect(out).toContain('src/file-1.ts');
      // The generic (uninformative) empty-pool note must not also appear.
      expect(out).not.toContain('No shared-pool matches for "needle".');
    });

    it('ignores emptyPoolNote once the shared pool has visible hits', () => {
      const docHit = {
        kind: 'doc' as const,
        id: 'doc-1',
        title: 'Concurrency Notes',
        updatedAt: new Date(FIXED_NOW).toISOString(),
        rank: 0.5,
        snippet: 'notes',
      };
      const out = composeWithFileLane(
        'needle',
        [docHit],
        new Map(),
        [fileHit('file-1')],
        undefined,
        'should not appear'
      );
      expect(out).not.toContain('should not appear');
      expect(out).toContain('1 result(s) for "needle":');
      expect(out).toContain('Files (1)');
    });
  });
});
