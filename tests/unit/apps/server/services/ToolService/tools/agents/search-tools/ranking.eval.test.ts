/**
 * search_tools ranking evaluation over a synthetic catalog, end to end through
 * the handler.
 *
 * The keyword channel is mocked with a small lexical scorer over the catalog
 * (curated keywords > name words > description words), so nothing here is a
 * hand-fed order: retrieval produces a pool the way the real channel does, the
 * live-MCP lexical channel and RRF merge run for real, and the ranker decides.
 * The embedder is unavailable, which is the keyword floor the
 * integration suite also runs on.
 *
 * Families covered: widget, file, doc, google (gmail/calendar), web, image
 * and an MCP playwright server. Includes a provider-wins case (an MCP tool is
 * the best answer and must stay first) and a near-tie case (identical evidence
 * from a first-party and an MCP tool; the first-party tool wins).
 */

import searchTools from '@server/services/ToolService/handlers/tools/tool-search';
import { toolView } from '@snaglet/db';
import { generateQueryEmbedding } from '@server/services/EmbeddingService';
import { resolveAgentTools } from '@server/services/AgentToolResolver';

jest.mock('@snaglet/db', () => ({
  Tools: { listAvailableForAgent: jest.fn() },
  toolView: { searchByKeyword: jest.fn(), semanticSearch: jest.fn() },
}));
jest.mock('@server/services/EmbeddingService', () => ({ generateQueryEmbedding: jest.fn() }));
jest.mock('@server/services/AgentToolResolver', () => ({ resolveAgentTools: jest.fn() }));
jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockKeyword = toolView.searchByKeyword as jest.Mock;
const mockSemantic = toolView.semanticSearch as jest.Mock;
const mockEmbed = generateQueryEmbedding as jest.Mock;
const mockResolve = resolveAgentTools as jest.Mock;

interface CatalogTool {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  aliases?: string[];
  type: 'builtin' | 'mcp';
  categoryPath: string;
}

const t = (
  id: string,
  name: string,
  description: string,
  keywords: string[],
  categoryPath: string,
  aliases: string[] = []
): CatalogTool => ({ id, name, description, keywords, aliases, type: 'builtin', categoryPath });

const mcp = (server: string, tool: string, description: string): CatalogTool => ({
  id: `mcp__${server}__${tool}`,
  name: tool,
  description,
  keywords: [],
  aliases: [],
  type: 'mcp',
  categoryPath: `integrations/${server}`,
});

const CATALOG: CatalogTool[] = [
  // widgets
  t(
    'widget_create',
    'Create Widget',
    'Create a new widget — an editable gadget (rectangles, ellipses, arrows, text) stored as a workspace node.',
    ['widget', 'gadget', 'canvas', 'create', 'vector', 'whiteboard', 'svg'],
    'widgets'
  ),
  t(
    'widget_get',
    'Get Widget',
    'Read a widget by id: title, placement, the full editable state and its current revision. Set preview to look at the gadget.',
    ['widget', 'gadget', 'get', 'read', 'state', 'revision', 'svg', 'preview'],
    'widgets'
  ),
  t(
    'widget_apply_operations',
    'Apply Widget Operations',
    'Edit a widget with optimistic concurrency: an ordered list of add / update / remove element operations.',
    ['widget', 'gadget', 'edit', 'update', 'add', 'remove', 'operations'],
    'widgets'
  ),
  t(
    'widget_export_svg',
    'Export Widget as SVG',
    'Render a widget to standalone SVG and return the source verbatim.',
    ['widget', 'gadget', 'export', 'svg', 'render', 'preview', 'vector'],
    'widgets'
  ),
  // files
  t(
    'file_read',
    'Read File',
    'Read a file from disk: whole, a line range, or as an image.',
    ['file', 'read', 'cat', 'lines', 'slice', 'partial', 'range', 'image', 'view'],
    'files'
  ),
  t(
    'file_write',
    'Write File',
    'Write content to a file on disk, creating or overwriting it.',
    ['write', 'file', 'create', 'save', 'overwrite', 'filesystem', 'output'],
    'files'
  ),
  t(
    'file_edit',
    'Edit File',
    'Replace text in a file with one or more exact-match edits.',
    ['edit', 'replace', 'patch', 'modify', 'change', 'update', 'rewrite', 'batch'],
    'files'
  ),
  t(
    'file_list',
    'List Files',
    'List the files and folders in a directory.',
    ['list', 'file', 'directory', 'folder', 'browse', 'ls', 'filesystem'],
    'files'
  ),
  // docs
  t(
    'create_doc',
    'Create Doc',
    'Create a workspace document with markdown content.',
    ['workspace', 'doc', 'document', 'create', 'markdown', 'library'],
    'workspace',
    ['workspace_create_doc']
  ),
  t(
    'get_doc',
    'Get Doc',
    'Fetch a workspace document by id or path.',
    ['workspace', 'doc', 'document', 'get', 'read', 'fetch', 'retrieve'],
    'workspace',
    ['workspace_get_doc']
  ),
  t(
    'edit_doc',
    'Edit Doc',
    'Edit a workspace document: replace, append or rewrite its content.',
    ['workspace', 'doc', 'document', 'edit', 'update', 'modify', 'replace', 'find'],
    'workspace',
    ['workspace_edit_doc']
  ),
  // google
  t(
    'google_gmail',
    'Google Gmail',
    'Send, search, read, reply to, and manage email.',
    ['google', 'gmail', 'email', 'message', 'draft', 'label', 'send', 'search'],
    'integrations/google'
  ),
  t(
    'google_calendar',
    'Google Calendar',
    'List, create, update and delete calendar events; find free time.',
    ['google', 'calendar', 'event', 'schedule', 'freebusy', 'meeting'],
    'integrations/google'
  ),
  // web / image
  t(
    'web_fetch',
    'Fetch URL',
    'Fetch the contents of a URL over HTTP.',
    ['fetch', 'url', 'http', 'request', 'get', 'api', 'download', 'web'],
    'web'
  ),
  t(
    'image_resize',
    'Resize Image',
    'Resize an image file to the given dimensions.',
    ['image', 'resize', 'scale', 'thumbnail'],
    'media'
  ),
  // MCP playwright browser tools — descriptions written the way provider
  // tools describe themselves: generic prose full of common words.
  mcp('playwright', 'browser_navigate', 'Navigate to a URL'),
  mcp('playwright', 'browser_navigate_back', 'Go back to the previous page'),
  mcp('playwright', 'browser_take_screenshot', 'Take a screenshot of the current page'),
  mcp('playwright', 'browser_click', 'Perform click on a web page'),
  mcp('playwright', 'browser_type', 'Type text into an editable element or a new field'),
  mcp(
    'playwright',
    'browser_find_text',
    'Find a new or existing text fragment on the page or in a drawing area'
  ),
  mcp('playwright', 'browser_snapshot', 'Capture accessibility snapshot of the current page'),
  // an MCP tool with evidence identical to a first-party one (near-tie case)
  mcp('imaging', 'resize_image', 'Resize an image'),
];

/** Lexical keyword channel: curated keywords > name words > description words. */
function keywordChannel(query: string, limit: number) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
  const scored = CATALOG.filter((c) => c.type !== 'mcp')
    .map((c) => {
      const strong = new Set([...c.keywords, ...(c.aliases ?? []), ...c.id.split('_')]);
      const nameWords = new Set(c.name.toLowerCase().split(/\s+/));
      const prose = new Set(c.description.toLowerCase().split(/[^a-z0-9]+/));
      let score = 0;
      for (const term of terms) {
        if (strong.has(term)) score += 3;
        else if (nameWords.has(term)) score += 2.5;
        else if (prose.has(term)) score += 1;
      }
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id))
    .slice(0, limit)
    .map(({ c }) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      category_path: c.categoryPath,
      provider_id: null,
      parameters_schema: {},
      tier: 'standard',
      keywords: c.keywords,
      aliases: c.aliases ?? [],
    }));
  return { tools: scored, count: scored.length };
}

function resolved(c: CatalogTool) {
  return {
    agentId: 'test-agent-a',
    tool: {
      id: c.id,
      name: c.name,
      description: c.description,
      type: c.type,
      parametersSchema: {},
      keywords: c.keywords,
      aliases: c.aliases ?? [],
      source: c.type === 'mcp' ? c.categoryPath.split('/')[1] : null,
      configJson: {},
      enabled: true,
      tier: 'standard',
      categoryPath: c.categoryPath,
      providerId: null,
      sortOrder: 0,
      createdAt: '',
      updatedAt: '',
    },
    settings: {},
    requiresConfirmation: false,
  };
}

interface SearchResult {
  tools: Array<{ id: string; score: number; reasons?: string[] }>;
  related?: Array<{ id: string; score: number; reasons?: string[] }>;
  count: number;
  search_mode: string;
  ranking?: { query_verbs: string[]; query_objects: string[] };
}

async function search(query: string, explain = false): Promise<SearchResult> {
  const raw = (await searchTools({ query, explain }, {}, { agentId: 'test-agent-a' })) as string;
  return JSON.parse(raw) as SearchResult;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue({ embedding: null, model: null });
  mockSemantic.mockResolvedValue({ tools: [], count: 0 });
  mockKeyword.mockImplementation((query: string, limit: number) =>
    Promise.resolve(keywordChannel(query, limit))
  );
  mockResolve.mockResolvedValue(CATALOG.map(resolved));
});

describe('search_tools ranking eval (synthetic catalog, keyword floor + live MCP)', () => {
  const EVAL: Array<{
    query: string;
    top: string;
    related?: string[];
    notInTools?: string[];
  }> = [
    {
      query: 'create a new widget or gadget',
      top: 'widget_create',
      related: ['widget_get', 'widget_apply_operations'],
    },
    { query: 'read a widget and look at its state', top: 'widget_get' },
    { query: 'edit an existing widget add an element', top: 'widget_apply_operations' },
    { query: 'export a widget to svg', top: 'widget_export_svg' },
    { query: 'read a local file', top: 'file_read' },
    { query: 'write a file to disk', top: 'file_write' },
    { query: 'edit a file and replace some text', top: 'file_edit' },
    { query: 'list files in a directory', top: 'file_list' },
    { query: 'create a project brief document', top: 'create_doc', related: ['get_doc'] },
    { query: 'get a document by id', top: 'get_doc' },
    { query: 'update an existing document', top: 'edit_doc' },
    { query: 'send an email', top: 'google_gmail' },
    { query: 'schedule a calendar event', top: 'google_calendar' },
    // provider wins: the MCP tool is the best answer and no first-party
    // prior may displace it
    {
      query: 'navigate the browser to a url and take a screenshot',
      top: 'mcp__playwright__browser_navigate',
      notInTools: ['file_read'],
    },
    { query: 'click a button on the web page', top: 'mcp__playwright__browser_click' },
    // near-tie: identical evidence from a first-party and an MCP tool
    { query: 'resize an image', top: 'image_resize' },
  ];

  it.each(EVAL)('$query → $top', async ({ query, top, related, notInTools }) => {
    const result = await search(query, true);
    const ids = result.tools.map((x) => x.id);
    expect(ids[0]).toBe(top);
    for (const id of related ?? []) {
      expect((result.related ?? []).map((x) => x.id)).toContain(id);
    }
    for (const id of notInTools ?? []) expect(ids).not.toContain(id);
  });

  it('no provider tool outranks widget_create for a widget query, though several retrieve', async () => {
    const result = await search('create a new widget or gadget');
    const ids = result.tools.map((x) => x.id);
    expect(ids[0]).toBe('widget_create');
    // The playwright tools do enter the pool (their prose mentions "new",
    // "drawing", "page") — the point is that they cannot win.
    const withMcp = mockResolve.mock.results.length > 0;
    expect(withMcp).toBe(true);
    expect(ids.findIndex((id) => id.startsWith('mcp__'))).not.toBe(0);
  });

  it('near-tie is decided by the first-party prior, and the reasons say so', async () => {
    const result = await search('resize an image', true);
    expect(result.tools[0].id).toBe('image_resize');
    expect(result.tools[0].reasons).toContain('first-party-prior');
    const mcpRow = result.tools.find((x) => x.id === 'mcp__imaging__resize_image');
    expect(mcpRow).toBeDefined();
    expect(mcpRow?.reasons).not.toContain('first-party-prior');
  });

  it('provider-wins: web_fetch is not lifted above the navigate tool by the prior', async () => {
    const result = await search('navigate the browser to a url and take a screenshot', true);
    const fetch = [...result.tools, ...(result.related ?? [])].find((x) => x.id === 'web_fetch');
    expect(result.tools[0].id).toBe('mcp__playwright__browser_navigate');
    expect(fetch?.reasons ?? []).not.toContain('first-party-prior');
  });

  describe('winner alignment with the bounded domain preference', () => {
    it('related belongs to the final winner after the workspace-domain re-rank moves it', async () => {
      // On evidence alone google_docs edges workspace_search (three curated
      // hits vs two); `document`/`workspace` make this a workspace-domain
      // query, so the bounded re-rank lifts workspace_* three places and
      // sinks google_* three. The grouping must follow the final winner:
      // workspace_create_doc (same family, different verb) is related;
      // google_drive, a sibling of the evidence winner, is not.
      const docsFamily = [
        t(
          'google_docs',
          'Google Docs',
          'Create, read and edit Google Docs documents.',
          ['google', 'docs', 'document', 'find', 'workspace'],
          'integrations/google'
        ),
        t(
          'google_drive',
          'Google Drive',
          'Search and manage files in Google Drive.',
          ['google', 'drive', 'file', 'document'],
          'integrations/google'
        ),
        t(
          'workspace_search',
          'Workspace Search',
          'Search the workspace for docs, tasks and threads.',
          ['workspace', 'search'],
          'workspace'
        ),
        t(
          'workspace_create_doc',
          'Workspace Create Doc',
          'Create a document in the workspace.',
          ['workspace', 'doc', 'create'],
          'workspace'
        ),
      ];
      mockResolve.mockResolvedValue(docsFamily.map(resolved));
      mockKeyword.mockResolvedValueOnce({
        tools: docsFamily.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description,
          category_path: c.categoryPath,
          provider_id: null,
          parameters_schema: {},
          tier: 'standard',
          keywords: c.keywords,
          aliases: [],
        })),
        count: docsFamily.length,
      });

      const result = await search('find a document in the workspace', true);
      expect(result.tools[0].id).toBe('workspace_search');
      expect(result.tools[0].reasons?.some((r) => r.startsWith('rerank-shift:+'))).toBe(true);
      expect((result.related ?? []).map((x) => x.id)).toEqual(['workspace_create_doc']);
      expect((result.related ?? []).map((x) => x.id)).not.toContain('google_drive');
    });
  });

  describe('output shape', () => {
    it('omits reasons and ranking unless explain is set', async () => {
      const plain = await search('create a new widget or gadget');
      expect(plain.tools[0]).toEqual({
        id: 'widget_create',
        name: 'Create Widget',
        description: expect.any(String),
        score: expect.any(Number),
      });
      expect(plain.ranking).toBeUndefined();
      expect(plain.related?.[0]).not.toHaveProperty('reasons');
      expect(plain.count).toBe(plain.tools.length);
      expect(plain.tools.length).toBeLessThanOrEqual(3);
      expect(plain.related!.length).toBeLessThanOrEqual(3);
    });

    it('explain adds reasons on every entry and the query analysis', async () => {
      const result = await search('create a new widget or gadget', true);
      expect(result.ranking).toEqual({
        query_verbs: ['create'],
        query_objects: ['widget', 'gadget'],
      });
      for (const entry of [...result.tools, ...(result.related ?? [])]) {
        expect(Array.isArray(entry.reasons)).toBe(true);
      }
      expect(result.tools[0].reasons).toEqual(
        expect.arrayContaining(['exact-cover', 'verb:create', 'object:widget'])
      );
    });

    it('omits the related key when nothing is related', async () => {
      const result = await search('send an email');
      expect(result.related).toBeUndefined();
    });
  });
});
