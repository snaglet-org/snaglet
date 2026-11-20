/**
 * Unit tests for the search_tools handler.
 *
 * Mocks: `@snaglet/db` (toolView), `@server/services/EmbeddingService` (generateQueryEmbedding),
 * `@server/services/AgentToolResolver` (resolveAgentTools), `@server/config/logger`.
 * fuseRRF runs for real — it's pure.
 */

import searchTools from '@server/services/ToolService/handlers/tools/tool-search';
import { Tools, toolView } from '@snaglet/db';
import { generateQueryEmbedding } from '@server/services/EmbeddingService';
import {
  resolveAgentTools,
  resolveAgentToolsForExecution,
} from '@server/services/AgentToolResolver';
import toolDefinition from '@server/services/ToolService/tools/system/tool/definition';
import customToolDefinition from '@server/services/ToolService/tools/system/custom-tool/definition';
import { readFileSync } from 'fs';
import path from 'path';

jest.mock('@snaglet/db', () => ({
  Tools: {
    listAvailableForAgent: jest.fn(),
  },
  toolView: {
    searchByKeyword: jest.fn(),
    semanticSearch: jest.fn(),
  },
}));

jest.mock('@server/services/EmbeddingService', () => ({
  generateQueryEmbedding: jest.fn(),
}));

jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAgentTools: jest.fn(),
  resolveAgentToolsForExecution: jest.fn(),
}));

const mockResolveThreadRuntimeConfig = jest.fn();
jest.mock('@server/services/ConfigResolverService', () => ({
  resolveThreadRuntimeConfig: (...a: unknown[]) => mockResolveThreadRuntimeConfig(...a),
}));

jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockSearchByKeyword = toolView.searchByKeyword as jest.Mock;
const mockSemanticSearch = toolView.semanticSearch as jest.Mock;
const mockGenerateEmbedding = generateQueryEmbedding as jest.Mock;
const mockResolveAgentTools = resolveAgentTools as jest.Mock;
const mockResolveForExecution = resolveAgentToolsForExecution as jest.Mock;
const mockListAvailableForAgent = Tools.listAvailableForAgent as jest.Mock;

function makeTool(id: string, name: string, description = `${name} description`) {
  return {
    id,
    name,
    description,
    parameters_schema: {},
    tier: 'core' as const,
    keywords: [] as string[],
    aliases: [] as string[],
  };
}

// Builds a fake ResolvedAgentTool — resolveAgentTools is the single source
// search_tools uses both to gate accessible ids and (for type='mcp' entries)
// to source the live MCP lexical channel (MCP tools are never `tools` DB rows).
function makeResolved(id: string, type: 'builtin' | 'mcp', name: string, description: string) {
  return {
    agentId: 'agent-1',
    tool: {
      id,
      name,
      description,
      type,
      parametersSchema: {},
      keywords: [] as string[],
      aliases: [] as string[],
      source: null,
      configJson: {},
      enabled: true,
      tier: 'standard',
      categoryPath: type === 'mcp' ? 'integrations/playwright' : 'system/test',
      providerId: null,
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
    },
    settings: {},
    requiresConfirmation: false,
  } as unknown as Awaited<ReturnType<typeof resolveAgentTools>>[number];
}

beforeEach(() => {
  mockSearchByKeyword.mockReset();
  mockSemanticSearch.mockReset();
  mockGenerateEmbedding.mockReset();
  mockResolveAgentTools.mockReset();
  mockResolveForExecution.mockReset();
  mockResolveForExecution.mockResolvedValue([]);
  mockListAvailableForAgent.mockReset();
});

describe('search_tools handler', () => {
  describe('input validation', () => {
    it('returns error string when query is missing', async () => {
      const result = await searchTools({});
      expect(typeof result).toBe('string');
      expect(result as string).toMatch(/^Error:/);
      expect(mockSemanticSearch).not.toHaveBeenCalled();
      expect(mockSearchByKeyword).not.toHaveBeenCalled();
    });
  });

  describe('query-only hybrid branch (embedding available)', () => {
    it('runs both channels in parallel and fuses with RRF', async () => {
      mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
      mockSemanticSearch.mockResolvedValue({
        tools: [makeTool('a', 'memory_recall'), makeTool('b', 'memory_store')],
        count: 2,
      });
      mockSearchByKeyword.mockResolvedValue({
        tools: [makeTool('b', 'memory_store'), makeTool('c', 'memory_forget')],
        count: 2,
      });

      const result = await searchTools({ query: 'remember something' });
      const parsed = JSON.parse(result as string);

      expect(mockGenerateEmbedding).toHaveBeenCalledWith('remember something');
      expect(mockSemanticSearch).toHaveBeenCalledWith([0.1, 0.2, 0.3], 10, undefined, undefined);
      expect(mockSearchByKeyword).toHaveBeenCalledWith('remember something', 10);
      expect(parsed.search_mode).toBe('hybrid');
      expect(parsed.channels).toEqual({ semantic: 2, keyword: 2 });
      expect(parsed.count).toBeGreaterThan(0);
      expect(parsed.count).toBeLessThanOrEqual(3);
      const ids = parsed.tools.map((t: { id: string }) => t.id);
      expect(ids).toContain('b'); // both-channel hit should make the cut
    });

    it('handles zero results from both channels without throwing', async () => {
      mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1] });
      mockSemanticSearch.mockResolvedValue({ tools: [], count: 0 });
      mockSearchByKeyword.mockResolvedValue({ tools: [], count: 0 });

      const result = await searchTools({ query: 'nonsense xyzzy' });
      const parsed = JSON.parse(result as string);

      expect(parsed.search_mode).toBe('hybrid');
      expect(parsed.count).toBe(0);
      expect(parsed.tools).toEqual([]);
    });
  });

  describe('query-only keyword-fallback branch (no embedding)', () => {
    it('degrades to keyword-only when generateQueryEmbedding returns null', async () => {
      mockGenerateEmbedding.mockResolvedValue({ embedding: null });
      mockSearchByKeyword.mockResolvedValue({
        tools: [makeTool('k1', 'find_files'), makeTool('k2', 'file_list')],
        count: 2,
      });

      const result = await searchTools({ query: 'find a file' });
      const parsed = JSON.parse(result as string);

      expect(mockSemanticSearch).not.toHaveBeenCalled();
      expect(mockSearchByKeyword).toHaveBeenCalledWith('find a file', 10);
      expect(parsed.search_mode).toBe('keyword');
    });

    it('finds google_gmail for the natural query "send an email"', async () => {
      mockGenerateEmbedding.mockResolvedValue({ embedding: null });
      mockSearchByKeyword.mockResolvedValue({
        tools: [
          makeTool(
            'google_gmail',
            'Google Gmail',
            'Send, search, read, reply to, and manage email.'
          ),
        ],
        count: 1,
      });

      const result = await searchTools({ query: 'send an email' });
      const parsed = JSON.parse(result as string);
      const ids = parsed.tools.map((entry: { id: string }) => entry.id);

      expect(mockSearchByKeyword).toHaveBeenCalledWith('send an email', 10);
      expect(parsed.search_mode).toBe('keyword');
      expect(ids).toContain('google_gmail');
    });
  });

  describe('mode param', () => {
    it("mode='list' preserves list_tools compact catalog behavior without a query", async () => {
      mockListAvailableForAgent.mockResolvedValue([
        {
          id: 'file_read',
          name: 'File Read',
          description: 'Read a file.\nLong details.',
          tier: 'core',
          aliases: [],
          assigned: true,
        },
      ]);

      const result = await searchTools({ mode: 'list' }, {}, { agentId: 'agent-1' });
      const parsed = JSON.parse(result as string);

      expect(mockListAvailableForAgent).toHaveBeenCalledWith('agent-1');
      expect(parsed).toMatchObject({
        mode: 'summary',
        assigned_count: 1,
        unassigned_count: 0,
      });
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    });

    it("mode='keyword' skips embedding call entirely", async () => {
      mockSearchByKeyword.mockResolvedValue({
        tools: [makeTool('k1', 'find_files')],
        count: 1,
      });

      const result = await searchTools({ query: 'find a file', mode: 'keyword' });
      const parsed = JSON.parse(result as string);

      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
      expect(mockSemanticSearch).not.toHaveBeenCalled();
      expect(mockSearchByKeyword).toHaveBeenCalledWith('find a file', 10);
      expect(parsed.search_mode).toBe('keyword');
    });

    it("mode='semantic' uses only semantic channel when embedding available", async () => {
      mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
      mockSemanticSearch.mockResolvedValue({
        tools: [makeTool('s1', 'memory_recall')],
        count: 1,
      });

      const result = await searchTools({ query: 'remember', mode: 'semantic' });
      const parsed = JSON.parse(result as string);

      expect(mockSearchByKeyword).not.toHaveBeenCalled();
      expect(mockSemanticSearch).toHaveBeenCalledWith([0.1, 0.2], 10, undefined, undefined);
      expect(parsed.search_mode).toBe('semantic');
      expect(parsed.tools[0].id).toBe('s1');
    });

    it("mode='semantic' falls back to keyword when the embedder is unavailable", async () => {
      mockGenerateEmbedding.mockResolvedValue({ embedding: null });
      mockSearchByKeyword.mockResolvedValue({
        tools: [makeTool('a', 'memory_recall')],
        count: 1,
      });

      const result = await searchTools({ query: 'remember', mode: 'semantic' });

      expect(typeof result).toBe('string');
      // Falls back to keyword search — should return valid JSON (not an error)
      const parsed = JSON.parse(result as string);
      expect(Array.isArray(parsed.tools)).toBe(true);
      expect(mockSearchByKeyword).toHaveBeenCalled();
      expect(mockSemanticSearch).not.toHaveBeenCalled();
    });

    it('rejects unknown mode value with an error string', async () => {
      const result = await searchTools({ query: 'anything', mode: 'bogus' });
      expect(typeof result).toBe('string');
      expect(result as string).toMatch(/^Error: Invalid mode/);
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    });

    it("mode='hybrid' (explicit) matches default hybrid behavior", async () => {
      mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1] });
      mockSemanticSearch.mockResolvedValue({
        tools: [makeTool('a', 'memory_recall')],
        count: 1,
      });
      mockSearchByKeyword.mockResolvedValue({
        tools: [makeTool('b', 'memory_store')],
        count: 1,
      });

      const result = await searchTools({ query: 'memory', mode: 'hybrid' });
      const parsed = JSON.parse(result as string);

      expect(parsed.search_mode).toBe('hybrid');
      expect(parsed.channels).toEqual({ semantic: 1, keyword: 1 });
    });
  });

  // Stable domain re-rank: on a workspace-domain query, workspace_* and thread_*
  // tools share the top tier while web (google_*) tools sink. Pure re-ordering.
  describe('domain re-rank tiering (workspace-domain query)', () => {
    it('tiers thread_* with workspace_* so a thread tool is not sunk below a workspace tool', async () => {
      // Keyword-only path keeps it simple: no embedding, no MCP, no gate (no
      // agentId), so reRankByDomain acts directly on the keyword channel order.
      mockSearchByKeyword.mockResolvedValue({
        tools: [
          makeTool('thread_create', 'thread_create'),
          makeTool('workspace_search', 'workspace_search'),
          makeTool('google_web_search', 'google_web_search'),
        ],
        count: 3,
      });

      const result = await searchTools({ query: 'create a new thread', mode: 'keyword' });
      const parsed = JSON.parse(result as string);
      const ids = parsed.tools.map((t: { id: string }) => t.id);

      // thread_create shares tier 0 with workspace_search and keeps its lead
      // rather than sitting in the generic tier below workspace_search.
      expect(ids[0]).toBe('thread_create');
      expect(ids.indexOf('thread_create')).toBeLessThan(ids.indexOf('workspace_search'));
      // A web tool (tier 2) sinks below both workspace-domain tools.
      expect(ids[ids.length - 1]).toBe('google_web_search');
    });
  });

  // Live MCP tools (mcp__<server>__<tool>) are never `tools` DB rows — the
  // semantic/keyword channels can't retrieve them. search_tools sources them
  // from resolveAgentTools (the same live registry lookup toolCatalogBlock
  // uses) and merges them in when context.agentId is present.
  describe('live MCP tool merge (context.agentId present)', () => {
    const BUILTIN_HITS = [
      makeTool('t1', 'Tool One', 'unrelated description one'),
      makeTool('t2', 'Tool Two', 'unrelated description two'),
      makeTool('t3', 'Tool Three', 'unrelated description three'),
      makeTool('t4', 'Tool Four', 'unrelated description four'),
      makeTool('t5', 'Tool Five', 'unrelated description five'),
    ];
    const MCP_TOOL_ID = 'mcp__playwright__screenshot';
    const QUERY = 'take a screenshot of the page';

    function resolvedWithMcp() {
      return [
        ...BUILTIN_HITS.map((t) => makeResolved(t.id, 'builtin', t.name, t.description)),
        makeResolved(MCP_TOOL_ID, 'mcp', 'screenshot', QUERY),
      ];
    }

    it("mode='keyword': an on-topic MCP tool survives the TOP_N cut even though the primary channel alone already fills it", async () => {
      // Appending MCP hits after the primary channel's results and then
      // slicing to TOP_N would drop every MCP tool whenever the primary
      // channel already has >= TOP_N hits (the common case). RRF-merging by
      // rank keeps them.
      mockResolveAgentTools.mockResolvedValue(resolvedWithMcp());
      mockSearchByKeyword.mockResolvedValue({
        tools: BUILTIN_HITS,
        count: BUILTIN_HITS.length,
      });

      const result = await searchTools(
        { query: QUERY, mode: 'keyword' },
        {},
        { agentId: 'agent-1' }
      );
      const parsed = JSON.parse(result as string);
      const ids = parsed.tools.map((t: { id: string }) => t.id);

      expect(mockResolveAgentTools).toHaveBeenCalledWith('agent-1');
      expect(ids).toContain(MCP_TOOL_ID);
    });

    it("mode='semantic' (embedding available): MCP hits are merged alongside cosine-scored results", async () => {
      mockResolveAgentTools.mockResolvedValue(resolvedWithMcp());
      mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
      mockSemanticSearch.mockResolvedValue({
        tools: BUILTIN_HITS.map((t) => ({ ...t, score: 0.4 })),
        count: BUILTIN_HITS.length,
      });

      const result = await searchTools(
        { query: QUERY, mode: 'semantic' },
        {},
        { agentId: 'agent-1' }
      );
      const parsed = JSON.parse(result as string);
      const ids = parsed.tools.map((t: { id: string }) => t.id);

      expect(ids).toContain(MCP_TOOL_ID);
    });

    it('default hybrid mode degraded to keyword (embedder unavailable): MCP hits still survive the TOP_N cut', async () => {
      mockResolveAgentTools.mockResolvedValue(resolvedWithMcp());
      mockGenerateEmbedding.mockResolvedValue({ embedding: null });
      mockSearchByKeyword.mockResolvedValue({
        tools: BUILTIN_HITS,
        count: BUILTIN_HITS.length,
      });

      const result = await searchTools({ query: QUERY }, {}, { agentId: 'agent-1' });
      const parsed = JSON.parse(result as string);
      const ids = parsed.tools.map((t: { id: string }) => t.id);

      expect(parsed.search_mode).toBe('keyword');
      expect(ids).toContain(MCP_TOOL_ID);
    });

    it('full hybrid (embedding configured, no semantic hits above threshold): MCP hits compete fairly against the keyword channel in the RRF fusion', async () => {
      mockResolveAgentTools.mockResolvedValue(resolvedWithMcp());
      mockGenerateEmbedding.mockResolvedValue({ embedding: [0.1, 0.2] });
      // Realistic: embeddings are configured and the call runs, but nothing
      // clears semanticSearch's minScore floor for this query.
      mockSemanticSearch.mockResolvedValue({ tools: [], count: 0 });
      mockSearchByKeyword.mockResolvedValue({
        tools: BUILTIN_HITS,
        count: BUILTIN_HITS.length,
      });

      const result = await searchTools({ query: QUERY }, {}, { agentId: 'agent-1' });
      const parsed = JSON.parse(result as string);
      const ids = parsed.tools.map((t: { id: string }) => t.id);

      expect(parsed.search_mode).toBe('hybrid');
      expect(mockSemanticSearch).toHaveBeenCalled();
      expect(ids).toContain(MCP_TOOL_ID);
    });

    it('no MCP servers enabled for the agent: behaves exactly as the no-MCP baseline (graceful, no MCP section)', async () => {
      mockResolveAgentTools.mockResolvedValue(
        BUILTIN_HITS.map((t) => makeResolved(t.id, 'builtin', t.name, t.description))
      );
      mockSearchByKeyword.mockResolvedValue({
        tools: BUILTIN_HITS,
        count: BUILTIN_HITS.length,
      });

      const result = await searchTools(
        { query: QUERY, mode: 'keyword' },
        {},
        { agentId: 'agent-1' }
      );
      const parsed = JSON.parse(result as string);
      const ids = parsed.tools.map((t: { id: string }) => t.id);

      expect(ids).not.toContain(MCP_TOOL_ID);
      expect(parsed.tools.length).toBeGreaterThan(0);
    });

    it('an inaccessible tool (not in the resolved set) is gated out even if the DB channel returns it', async () => {
      // accessibleIds is built from resolveAgentTools's resolved set — a tool
      // id the keyword channel returns but resolveAgentTools didn't resolve
      // (e.g. denied by the agent's tool access config) must not leak through.
      mockResolveAgentTools.mockResolvedValue([
        makeResolved('t1', 'builtin', 'Tool One', 'unrelated description one'),
        makeResolved(MCP_TOOL_ID, 'mcp', 'screenshot', QUERY),
      ]);
      mockSearchByKeyword.mockResolvedValue({
        tools: [...BUILTIN_HITS], // includes t2..t5, none of which resolveAgentTools resolved
        count: BUILTIN_HITS.length,
      });

      const result = await searchTools(
        { query: QUERY, mode: 'keyword' },
        {},
        { agentId: 'agent-1' }
      );
      const parsed = JSON.parse(result as string);
      const ids = parsed.tools.map((t: { id: string }) => t.id);

      expect(ids).not.toContain('t2');
      expect(ids).not.toContain('t3');
    });

    describe('thread-effective access', () => {
      // The catalog is advertised from the agent's base access in every
      // thread, so a tool a thread grants beyond that base is reachable only
      // through discovery: search_tools must filter by the thread's access.
      const THREAD_ACCESS = { mode: 'all', allowList: [], denyList: [] };

      beforeEach(() => {
        mockResolveThreadRuntimeConfig.mockReset();
        mockResolveAgentTools.mockResolvedValue([]);
        mockSearchByKeyword.mockResolvedValue({ tools: [], count: 0 });
      });

      it("resolves accessible tools with the thread's tool access when the thread overrides it", async () => {
        mockResolveThreadRuntimeConfig.mockResolvedValue({
          agentOverrides: new Map([['agent-1', { toolAccess: THREAD_ACCESS }]]),
        });

        await searchTools(
          { query: QUERY, mode: 'keyword' },
          {},
          { agentId: 'agent-1', threadId: 'thread-1' }
        );

        expect(mockResolveThreadRuntimeConfig).toHaveBeenCalledWith('thread-1');
        expect(mockResolveAgentTools).toHaveBeenCalledWith('agent-1', { access: THREAD_ACCESS });
      });

      it("falls back to the agent's own access when the thread has no override", async () => {
        mockResolveThreadRuntimeConfig.mockResolvedValue({ agentOverrides: new Map() });

        await searchTools(
          { query: QUERY, mode: 'keyword' },
          {},
          { agentId: 'agent-1', threadId: 'thread-1' }
        );

        expect(mockResolveAgentTools).toHaveBeenCalledWith('agent-1');
      });

      it("falls back to the agent's own access when thread resolution fails", async () => {
        mockResolveThreadRuntimeConfig.mockRejectedValue(new Error('db down'));

        await searchTools(
          { query: QUERY, mode: 'keyword' },
          {},
          { agentId: 'agent-1', threadId: 'thread-1' }
        );

        expect(mockResolveAgentTools).toHaveBeenCalledWith('agent-1');
      });
    });

    it('resolveAgentTools failure degrades to unfiltered results without throwing', async () => {
      mockResolveAgentTools.mockRejectedValue(new Error('db unavailable'));
      mockSearchByKeyword.mockResolvedValue({
        tools: BUILTIN_HITS,
        count: BUILTIN_HITS.length,
      });

      const result = await searchTools(
        { query: QUERY, mode: 'keyword' },
        {},
        { agentId: 'agent-1' }
      );
      const parsed = JSON.parse(result as string);

      expect(Array.isArray(parsed.tools)).toBe(true);
      expect(parsed.tools.length).toBeGreaterThan(0);
    });
  });

  // The search result tells the model its next step, so a found tool gets
  // called instead of reported missing, and a miss leads to creating one.
  describe('self-explanatory results', () => {
    const THEME = makeTool(
      'change_color_theme',
      'Change color theme',
      "The Snaglet app's color theme."
    );
    const OTHER = makeTool('get_current_datetime', 'Get Current Datetime', 'The current time.');
    const resolvedOf = (...tools: ReturnType<typeof makeTool>[]) =>
      tools.map((t) => makeResolved(t.id, 'builtin', t.name, t.description));

    beforeEach(() => {
      mockGenerateEmbedding.mockResolvedValue({ embedding: null });
    });

    it('a hit says how to read its parameters and call it', async () => {
      mockSearchByKeyword.mockResolvedValue({ tools: [THEME], count: 1 });

      const parsed = JSON.parse((await searchTools({ query: 'color theme' })) as string);

      expect(parsed.tools.map((t: { id: string }) => t.id)).toEqual(['change_color_theme']);
      expect(parsed.next).toBe(
        "Read a tool's parameters with tool({op: 'schema', name: '<id>'}), then call it with action({tool: '<id>', params: {...}})."
      );
    });

    it('no match says so and names custom_tool to create one', async () => {
      mockSearchByKeyword.mockResolvedValue({ tools: [], count: 0 });

      const parsed = JSON.parse((await searchTools({ query: 'fax a document' })) as string);

      expect(parsed.tools).toEqual([]);
      expect(parsed.next).toBe(
        `No matching tool. Search again with other words (the thing or the verb). If nothing fits, you can create one with ${customToolDefinition.id}({op: 'create', name, description, parameters_schema, handler_source}).`
      );
    });

    it('no match for an agent that cannot reach custom_tool points the user to New tool', async () => {
      mockResolveAgentTools.mockResolvedValue(resolvedOf(OTHER));
      mockSearchByKeyword.mockResolvedValue({ tools: [], count: 0 });

      const parsed = JSON.parse(
        (await searchTools({ query: 'fax a document' }, {}, { agentId: 'agent-1' })) as string
      );

      expect(parsed.next).toBe(
        'No matching tool. Search again with other words (the thing or the verb). If nothing fits, tell the user what tool you need: they can add one (Tools view → New tool), or allow `custom_tool` in your Capabilities so you can create it.'
      );
    });

    it('lists a matching tool the agent’s access blocks under `blocked`, never as usable', async () => {
      mockResolveAgentTools.mockResolvedValue(resolvedOf(OTHER));
      mockResolveForExecution.mockResolvedValue(resolvedOf(OTHER, THEME));
      mockSearchByKeyword.mockResolvedValue({ tools: [THEME, OTHER], count: 2 });

      const parsed = JSON.parse(
        (await searchTools({ query: 'color theme' }, {}, { agentId: 'agent-1' })) as string
      );

      expect(mockResolveForExecution).toHaveBeenCalledWith('agent-1');
      expect(parsed.tools.map((t: { id: string }) => t.id)).not.toContain('change_color_theme');
      expect(parsed.blocked.map((t: { id: string }) => t.id)).toEqual(['change_color_theme']);
      expect(parsed.blocked_note).toBe(
        "These tools exist, but your tool access does not allow them. Do not tell the user they are missing or that you lost access: say they are blocked by your permissions, which the user can change in your agent's Capabilities settings (Agents)."
      );
    });

    it('a match hidden by this thread’s tool access points at the thread’s settings', async () => {
      mockResolveThreadRuntimeConfig.mockResolvedValue({
        agentOverrides: new Map([
          [
            'agent-1',
            {
              toolAccess: { mode: 'allow_list', allowList: ['get_current_datetime'], denyList: [] },
            },
          ],
        ]),
      });
      mockResolveAgentTools.mockResolvedValue(resolvedOf(OTHER));
      mockResolveForExecution.mockResolvedValue(resolvedOf(OTHER, THEME));
      mockSearchByKeyword.mockResolvedValue({ tools: [THEME, OTHER], count: 2 });

      const parsed = JSON.parse(
        (await searchTools(
          { query: 'color theme' },
          {},
          { agentId: 'agent-1', threadId: 'thread-1' }
        )) as string
      );

      expect(parsed.blocked.map((t: { id: string }) => t.id)).toEqual(['change_color_theme']);
      expect(parsed.blocked_note).toBe(
        "These tools exist, but this thread's tool access does not allow them. Do not tell the user they are missing or that you lost access: say they are blocked in this thread, which the user can change in this thread's settings → Agents."
      );
    });

    it('omits `blocked` when the agent can reach every matching tool', async () => {
      mockResolveAgentTools.mockResolvedValue(resolvedOf(OTHER, THEME));
      mockResolveForExecution.mockResolvedValue(resolvedOf(OTHER, THEME));
      mockSearchByKeyword.mockResolvedValue({ tools: [THEME], count: 1 });

      const parsed = JSON.parse(
        (await searchTools({ query: 'color theme' }, {}, { agentId: 'agent-1' })) as string
      );

      expect(parsed.tools.map((t: { id: string }) => t.id)).toEqual(['change_color_theme']);
      expect(parsed).not.toHaveProperty('blocked');
      expect(parsed).not.toHaveProperty('blocked_note');
    });

    it('a blocked-only match says nothing usable matched and points at `blocked`', async () => {
      mockResolveAgentTools.mockResolvedValue(resolvedOf(OTHER));
      mockResolveForExecution.mockResolvedValue(resolvedOf(OTHER, THEME));
      mockSearchByKeyword.mockResolvedValue({ tools: [THEME], count: 1 });

      const parsed = JSON.parse(
        (await searchTools({ query: 'color theme' }, {}, { agentId: 'agent-1' })) as string
      );

      expect(parsed.tools).toEqual([]);
      expect(parsed.next).toBe(
        'No tool you can use matches. The matches under `blocked` exist, but your tool access blocks them.'
      );
    });
  });

  describe('the tool the model sees says when to use it', () => {
    const KEY = 'Use this whenever the tool you need is not in your list';
    const NEVER =
      "Never tell the user you can't do something, or that a tool is missing, until you have searched.";

    it('in its schema description', () => {
      expect(toolDefinition.description).toContain(KEY);
      expect(toolDefinition.description).toContain(NEVER);
      expect(toolDefinition.description).toContain('action({tool, params})');
      expect(toolDefinition.description).toContain(customToolDefinition.id);
    });

    it('in its TOOL.md guide', () => {
      const doc = readFileSync(
        path.resolve(
          __dirname,
          '../../../../../../../../../apps/server/src/services/ToolService/tools/system/tool/TOOL.md'
        ),
        'utf8'
      );
      expect(doc).toContain(KEY);
      expect(doc).toContain(NEVER);
    });
  });
});
