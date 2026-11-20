/**
 * Keyword relevance under RRF fusion. The real-catalog ranking test
 * (tests/integration/.../searchToolsRanking.test.ts) has no embedding
 * provider, so `hybrid` degrades to keyword there and fusion never runs. Here
 * both channels are mocked with deterministic ranked lists, so the fusion
 * arithmetic is the only variable.
 *
 * The control: when no channel retrieves `file_read`, it must not appear.
 * Ranking can only reorder what retrieval produced, so the keyword channel
 * retrieving the tool at all is what matters.
 */

import searchTools from '@server/services/ToolService/handlers/tools/tool-search';
import { toolView } from '@snaglet/db';
import { generateQueryEmbedding } from '@server/services/EmbeddingService';

jest.mock('@snaglet/db', () => ({
  Tools: { listAvailableForAgent: jest.fn() },
  toolView: { searchByKeyword: jest.fn(), semanticSearch: jest.fn() },
}));
jest.mock('@server/services/EmbeddingService', () => ({
  generateQueryEmbedding: jest.fn(),
}));
jest.mock('@server/services/AgentToolResolver', () => ({ resolveAgentTools: jest.fn() }));
jest.mock('@server/config/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockKeyword = toolView.searchByKeyword as jest.MockedFunction<
  typeof toolView.searchByKeyword
>;
const mockSemantic = toolView.semanticSearch as jest.MockedFunction<typeof toolView.semanticSearch>;
const mockEmbed = generateQueryEmbedding as jest.MockedFunction<typeof generateQueryEmbedding>;

function tool(id: string) {
  return {
    id,
    name: id,
    description: `${id} description`,
    category_path: 'test',
    provider_id: null,
    parameters_schema: {},
    tier: 'standard',
    keywords: [],
    aliases: [],
  };
}

/** Channel results are ORDER-carrying; RRF reads rank, not score. */
const keywordChannel = (ids: string[]) =>
  mockKeyword.mockResolvedValue({ tools: ids.map(tool), count: ids.length });

/** Descending mock similarities — the values never matter, only the order. */
const semanticChannel = (ids: string[]) =>
  mockSemantic.mockResolvedValue({
    tools: ids.map((id, index) => ({ ...tool(id), score: 0.9 - index * 0.05 })),
    count: ids.length,
  });

async function fusedTopIds(query: string): Promise<string[]> {
  const raw = (await searchTools({ query, mode: 'hybrid' })) as string;
  return (JSON.parse(raw) as { tools: Array<{ id: string }> }).tools.map((t) => t.id);
}

/** What the semantic channel returns in every file-read scenario below. */
const SEMANTIC_FILE_ORDER = [
  'export_node',
  'pdf_extract',
  'google_drive',
  'file_read',
  'file_info',
];

beforeEach(() => {
  jest.clearAllMocks();
  mockEmbed.mockResolvedValue({ embedding: [0.1, 0.2, 0.3], model: 'mock-embedder' });
});

/** Relevance-ranked keyword pool: file_read retrieved and first. */
const KEYWORD_AFTER = ['file_read', 'pdf_extract', 'file_write', 'export_node', 'file_info'];
/**
 * A keyword pool for the same query in which `file_read` is absent, the shape
 * an alphabetical first pass produces for `file`.
 */
const KEYWORD_BEFORE = ['apply_patch', 'export_node', 'file_info', 'google_drive', 'file_list'];

describe('the keyword improvement survives RRF', () => {
  it('carries file_read into the top 3 once the keyword channel ranks it', async () => {
    keywordChannel(KEYWORD_AFTER);
    semanticChannel(SEMANTIC_FILE_ORDER);

    expect(await fusedTopIds('read a local file')).toContain('file_read');
  });

  it('control: a candidate no channel retrieves cannot be surfaced', async () => {
    // Semantic is held fixed minus file_read and the keyword pool lacks it,
    // so file_read is absent from every channel. Ranking can only reorder what
    // retrieval produced.
    keywordChannel(KEYWORD_BEFORE);
    semanticChannel(SEMANTIC_FILE_ORDER.filter((id) => id !== 'file_read'));

    expect(await fusedTopIds('read a local file')).not.toContain('file_read');
  });

  it('exact capability evidence lifts a single-channel rank-4 retrieval', async () => {
    // RRF alone would leave a rank-4 single-channel hit below every candidate
    // both channels agree on. The ranker recognizes that `read a local file`
    // names the capability `file_read` exactly (verb read + object file), and
    // exact first-party matches rank above weak generic matches.
    keywordChannel(KEYWORD_BEFORE);
    semanticChannel(SEMANTIC_FILE_ORDER);

    expect((await fusedTopIds('read a local file'))[0]).toBe('file_read');
  });

  it('keeps it top-3 even when the semantic channel omits it entirely', async () => {
    keywordChannel(['file_read', 'pdf_extract', 'file_write']);
    semanticChannel(['export_node', 'google_drive', 'pdf_extract']);

    expect(await fusedTopIds('read a local file')).toContain('file_read');
  });
});

describe('fusion still covers what lexical ranking cannot', () => {
  it('surfaces file_read for a query with no lexical evidence at all', async () => {
    // "show me what's in package.json" shares no token with file_read's name,
    // keywords, or aliases, so the keyword channel cannot retrieve it at any
    // weighting. This is the case the semantic channel exists for.
    keywordChannel(['bulk_export', 'navigate_user_pane', 'get_node']);
    semanticChannel(['file_read', 'file_info', 'bulk_export']);

    expect(await fusedTopIds("show me what's in package.json")).toContain('file_read');
  });

  it('does not let one channel monopolize the slate', async () => {
    // Both channels agree on nothing; each should still be represented.
    keywordChannel(['file_read', 'file_write', 'file_edit']);
    semanticChannel(['memory_search', 'search', 'get_doc']);

    const ids = await fusedTopIds('read a local file');
    expect(ids.some((id) => ['file_read', 'file_write', 'file_edit'].includes(id))).toBe(true);
    expect(ids.some((id) => ['memory_search', 'search', 'get_doc'].includes(id))).toBe(true);
  });
});

describe('bounded domain preference under fusion', () => {
  it('does not promote a weakly-ranked thread tool over strongly-ranked results', async () => {
    // 'document'/'project' make this a workspace-domain query, which is what
    // triggers the re-rank. Channels are full-length (the pool is 10) with
    // `thread_delete` genuinely weak in both — the real-catalog shape, where
    // it retrieved at rank 8 purely for listing `project` as a keyword.
    keywordChannel([
      'create_container',
      'create_doc',
      'pdf_generate',
      'google_docs',
      'update_container',
      'doc_history',
      'orient',
      'thread_delete',
      'edit_doc',
      'pdf_extract',
    ]);
    semanticChannel([
      'create_doc',
      'create_container',
      'update_container',
      'pdf_generate',
      'doc_history',
      'edit_doc',
      'orient',
      'google_docs',
      'thread_delete',
    ]);

    const ids = await fusedTopIds('create a project brief document');

    expect(ids).not.toContain('thread_delete');
    expect(ids.slice(0, 2).sort()).toEqual(['create_container', 'create_doc']);
  });

  it('bounds how far domain membership can lift a candidate', async () => {
    // The contract, stated directly: domain preference is worth a fixed number
    // of positions, not an unconditional promotion. A thread tool sitting far
    // down a single channel cannot reach the top however domain-y the query.
    keywordChannel([
      'create_doc',
      'create_container',
      'pdf_generate',
      'google_docs',
      'update_container',
      'doc_history',
      'orient',
      'edit_doc',
      'thread_delete',
    ]);
    semanticChannel(['create_doc', 'create_container', 'pdf_generate']);

    const ids = await fusedTopIds('create a project brief document');

    expect(ids[0]).toBe('create_doc');
    expect(ids).not.toContain('thread_delete');
  });

  it('still prefers a workspace tool that is already competitive', async () => {
    // The re-rank keeps its purpose: a near-miss workspace tool gains ground.
    keywordChannel(['get_doc', 'pdf_generate', 'workspace_search', 'orient']);
    semanticChannel(['get_doc', 'pdf_generate', 'workspace_search']);

    expect(await fusedTopIds('find a document in the workspace')).toContain('workspace_search');
  });
});

describe('the keyword floor is preserved when no embedder is configured', () => {
  it('reports keyword mode and keeps the keyword ranking intact', async () => {
    // The integration suite runs in exactly this state; this pins the contract.
    mockEmbed.mockResolvedValue({ embedding: null, model: null });
    keywordChannel(['file_read', 'pdf_extract', 'file_write']);

    const raw = (await searchTools({ query: 'read a local file', mode: 'hybrid' })) as string;
    const parsed = JSON.parse(raw) as {
      tools: Array<{ id: string }>;
      related?: Array<{ id: string }>;
      search_mode: string;
    };

    expect(parsed.search_mode).toBe('keyword');
    // file_read keeps the lead; file_write is the same `file` family with a
    // different verb (write vs read), so it is reported as related rather
    // than occupying a primary slot.
    expect(parsed.tools.map((t) => t.id)).toEqual(['file_read', 'pdf_extract']);
    expect((parsed.related ?? []).map((t) => t.id)).toEqual(['file_write']);
    expect(mockSemantic).not.toHaveBeenCalled();
  });
});
