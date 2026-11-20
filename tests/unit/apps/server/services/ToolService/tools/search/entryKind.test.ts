/**
 * `search` with kinds:["entry"]: routing in tools/workspace/search/tool.ts,
 * the handler's input checks, and the snippet cut. The ranked reads are
 * covered against a real database in
 * tests/integration/apps/server/services/ToolService/entrySearch.test.ts.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSearchEntries = jest.fn<(options: Record<string, unknown>) => Promise<unknown>>();
const mockMatchTables = jest.fn<(q: string, o?: unknown) => Promise<unknown[]>>();
jest.mock('@snaglet/db/tables/table_entries', () => ({
  rowQuery: (q: string, consumed: string[]) =>
    q
      .split(' ')
      .filter((word) => !consumed.includes(word))
      .join(' '),
  matchTables: (q: string, o?: unknown) => mockMatchTables(q, o),
  readEntryHits: (refs: unknown[]) => mockReadEntryHits(refs),
  searchEntries: (options: Record<string, unknown>) => mockSearchEntries(options),
  SNIPPET_SOURCE_LENGTH: 300,
}));
const mockSearchSemantic = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@server/services/tableSemantic/TableSemanticService', () => ({
  searchSemantic: (...args: unknown[]) => mockSearchSemantic(...args),
}));
const mockListSearchable = jest.fn<(options: { projectId?: string }) => Promise<string[]>>();
jest.mock('@snaglet/db/tables/table_semantic', () => ({
  TableSemantic: {
    listSearchable: (options: { projectId?: string }) => mockListSearchable(options),
  },
}));
const mockReadEntryHits = jest.fn<(refs: unknown[]) => Promise<unknown[]>>();
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (sql: string, params?: unknown[]) => mockQuery(sql, params) }),
}));
jest.mock('@snaglet/db/tables/table_fields', () => ({ TableFields: { listFields: jest.fn() } }));
const mockResolve = jest.fn<(name: string) => Promise<unknown>>();
jest.mock('@server/services/search/paletteEntrySearch', () => ({
  resolveEntryTable: (name: string) => mockResolve(name),
}));

import entrySearch, {
  ENTRY_SEARCH_MAX_TABLES,
  snippetAround,
} from '@server/services/ToolService/handlers/search/entrySearch';
import searchTool from '@server/services/ToolService/tools/workspace/search/tool';

const HIT = {
  tableId: 'table-1',
  tableName: 'tasks',
  projectId: 'project-1',
  entryId: 'entry-1',
  name: 'Memories',
  score: 1,
  createdAt: '2026-10-19T10:00:00.000000Z',
  snippet: 'prune the old memories rows every night',
};

describe('search kinds:["entry"]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMatchTables.mockResolvedValue([]);
    mockSearchSemantic.mockResolvedValue({ hits: [], tableIds: [], indexing: [] });
    mockListSearchable.mockResolvedValue([]);
    mockReadEntryHits.mockResolvedValue([]);
    mockSearchEntries.mockResolvedValue({ hits: [HIT], tablesSearched: 3, tablesOmitted: 0 });
    mockQuery.mockResolvedValue({ rows: [{ id: 'project-1', name: 'Snaglet' }] });
  });

  it('is reached through the search tool, alone', async () => {
    const reply = JSON.parse(
      (await searchTool({ kinds: ['entry'], query: 'memories' }, {}, undefined)) as string
    );
    expect(reply.entries[0]).toMatchObject({
      id: 'entry-1',
      ref: 'entry:table-1/entry-1',
      title: 'Memories',
      table: 'tasks',
      project: 'Snaglet',
      snippet: 'prune the old memories rows every night',
    });
    expect(mockSearchEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        q: 'memories',
        sort: 'relevance',
        maxTables: ENTRY_SEARCH_MAX_TABLES,
      })
    );
  });

  it('refuses to mix with other kinds or a content_range, without searching', async () => {
    await expect(
      searchTool({ kinds: ['entry', 'doc'], query: 'x' }, {}, undefined)
    ).resolves.toMatch(/on its own/);
    await expect(
      searchTool(
        { kinds: ['entry'], query: 'x', content_range: { start_line: 1, end_line: 2 } },
        {},
        undefined
      )
    ).resolves.toMatch(/content_range is supported only on the workspace backend/);
    expect(mockSearchEntries).not.toHaveBeenCalled();
  });

  it('turns "latest" into sort:recent, and an empty query browses newest first', async () => {
    await entrySearch({ query: 'memories', sort: 'recent' }, {}, undefined);
    expect(mockSearchEntries).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'recent' }));
    await entrySearch({}, {}, undefined);
    expect(mockSearchEntries).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: '', sort: 'recent' })
    );
    await expect(entrySearch({ sort: 'newest' }, {}, undefined)).rejects.toThrow(
      'sort must be relevance or recent.'
    );
  });

  it('searches one named table without a table cap, and refuses a table it cannot resolve', async () => {
    mockResolve.mockResolvedValueOnce({
      status: 'resolved',
      tableId: 'table-1',
      tableName: 'tasks',
      projectId: null,
    });
    await entrySearch({ query: 'x', table: 'tasks' }, {}, undefined);
    const options = mockSearchEntries.mock.calls[0]![0]!;
    expect(options).toMatchObject({ tableIds: ['table-1'] });
    expect(options).not.toHaveProperty('maxTables');

    mockResolve.mockResolvedValueOnce({
      status: 'unsearchable',
      name: 'old',
      message: 'old is archived. Restore it to search its entries.',
    });
    await expect(entrySearch({ query: 'x', table: 'old' }, {}, undefined)).rejects.toThrow(
      'old is archived'
    );
    expect(mockSearchEntries).toHaveBeenCalledTimes(1);
  });

  it('says how many tables a cross-table search left out and clamps limit', async () => {
    mockSearchEntries.mockResolvedValue({ hits: [], tablesSearched: 40, tablesOmitted: 7 });
    const reply = JSON.parse(
      (await entrySearch({ query: 'x', limit: 9999 }, {}, undefined)) as string
    );
    expect(reply).toMatchObject({ tables_searched: 40, tables_omitted: 7, entries: [] });
    expect(reply.note).toMatch(/pass table or project_id/);
    expect(mockSearchEntries).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it('searches only the best-matching tables, says why, and names the next ones', async () => {
    const match = (name: string) => ({
      tableId: `id-${name}`,
      tableName: name,
      score: 5,
      why: [`name has "task"`],
      nameTerms: ['task'],
    });
    mockMatchTables.mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map(match));
    const reply = JSON.parse(
      (await entrySearch({ query: 'task memories' }, {}, undefined)) as string
    );
    expect(mockSearchEntries).toHaveBeenCalledTimes(1);
    expect(mockSearchEntries.mock.calls[0]![0]).toMatchObject({
      tableIds: ['id-a', 'id-b', 'id-c'],
    });
    expect(mockSearchEntries.mock.calls[0]![0]).not.toHaveProperty('maxTables');
    expect(reply.table_match.chosen).toEqual([
      { table: 'a', why: ['name has "task"'] },
      { table: 'b', why: ['name has "task"'] },
      { table: 'c', why: ['name has "task"'] },
    ]);
    expect(reply.table_match.also_matched).toEqual(['d', 'e']);
  });

  it('searches every table (capped) when the matched ones hold no row, and says so', async () => {
    mockMatchTables.mockResolvedValue([
      { tableId: 'id-a', tableName: 'a', score: 5, why: ['name has "task"'], nameTerms: ['task'] },
    ]);
    mockSearchEntries
      .mockResolvedValueOnce({ hits: [], tablesSearched: 1, tablesOmitted: 0 })
      .mockResolvedValueOnce({ hits: [HIT], tablesSearched: 12, tablesOmitted: 0 });
    const reply = JSON.parse((await entrySearch({ query: 'task zebra' }, {}, undefined)) as string);
    expect(mockSearchEntries).toHaveBeenCalledTimes(2);
    expect(mockSearchEntries.mock.calls[1]![0]).toMatchObject({ q: 'zebra' });
    expect(mockSearchEntries.mock.calls[1]![0]).toMatchObject({
      maxTables: ENTRY_SEARCH_MAX_TABLES,
    });
    expect(reply.table_match).toMatchObject({
      chosen: [{ table: 'a' }],
      widened: true,
      note: expect.stringMatching(/every table was searched for "zebra"/),
    });
    expect(reply.entries).toHaveLength(1);
  });

  it('skips matching for an explicit table, match_tables:false and an empty query', async () => {
    mockResolve.mockResolvedValue({
      status: 'resolved',
      tableId: 'table-1',
      tableName: 'tasks',
      projectId: null,
    });
    await entrySearch({ query: 'x', table: 'tasks' }, {}, undefined);
    await entrySearch({ query: 'x', match_tables: false }, {}, undefined);
    await entrySearch({}, {}, undefined);
    expect(mockMatchTables).not.toHaveBeenCalled();
    const reply = JSON.parse((await entrySearch({ query: 'x' }, {}, undefined)) as string);
    expect(reply.table_match.note).toMatch(/No table name, field name or select option matched/);
  });

  it('adds rows found by meaning for tables that have it on, and labels where each came from', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'table-1', name: 'tasks' }] });
    mockSearchEntries.mockResolvedValue({ hits: [HIT], tablesSearched: 1, tablesOmitted: 0 });
    mockSearchSemantic.mockResolvedValue({
      hits: [
        { tableId: 'table-1', entryId: 'entry-2', distance: 0.2 },
        { tableId: 'table-1', entryId: 'entry-1', distance: 0.3 },
        { tableId: 'table-1', entryId: 'entry-3', distance: 0.9 },
      ],
      tableIds: ['table-1'],
      indexing: [],
    });
    mockReadEntryHits.mockResolvedValue([
      { ...HIT, entryId: 'entry-2', name: 'Feline care', snippet: 'feeding and grooming' },
    ]);
    const reply = JSON.parse((await entrySearch({ query: 'cat' }, {}, undefined)) as string);
    expect(reply.entries.map((e: { id: string; match: string }) => [e.id, e.match])).toEqual([
      ['entry-1', 'both'],
      ['entry-2', 'meaning'],
    ]);
    expect(reply.semantic).toMatchObject({ tables: ['tasks'], indexing: [], used: true });
    // The far row (distance 0.9) is not a meaning match and is not read.
    expect(mockReadEntryHits).toHaveBeenCalledWith([{ tableId: 'table-1', entryId: 'entry-2' }]);
  });

  it('is keyword-only for mode:"keyword", with a field filter, or when meaning search fails', async () => {
    mockResolve.mockResolvedValue({
      status: 'resolved',
      tableId: 'table-1',
      tableName: 'tasks',
      projectId: null,
    });
    await entrySearch({ query: 'cat', mode: 'keyword' }, {}, undefined);
    expect(mockSearchSemantic).not.toHaveBeenCalled();
    mockSearchSemantic.mockRejectedValue(new Error('The local embedder is not available.'));
    const reply = JSON.parse(
      (await entrySearch({ query: 'cat', table: 'tasks' }, {}, undefined)) as string
    );
    expect(reply.semantic).toMatchObject({
      used: false,
      note: 'Meaning search was skipped: The local embedder is not available.',
    });
    expect(reply.entries).toHaveLength(1);
  });

  it('cuts a snippet around the first keyword with ellipses', () => {
    const long = `${'a '.repeat(100)}memories${' b'.repeat(100)}`;
    const cut = snippetAround(long, 'memories');
    expect(cut).toContain('memories');
    expect(cut.startsWith('…')).toBe(true);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(142);
    expect(snippetAround('short note', 'note')).toBe('short note');
  });
});
