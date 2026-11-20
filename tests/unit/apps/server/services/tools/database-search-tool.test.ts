import { beforeEach, describe, expect, it } from '@jest/globals';

/**
 * kind:"database" runs entirely through the read-only TableQuery engine (the
 * `snaglet_tables_reader` role, `user_tables` schema only), so there is no app /
 * superuser pool to mock: the tests mock `TableQuery.select` and assert on the
 * SQL it builds.
 *
 * Every call first runs the allow-list pre-check (`assertCustomTable`, a
 * `to_regclass('user_tables...')` query); `allowTable()` queues that `[['t']]`
 * response so the rest of the call proceeds.
 */

const select = jest.fn();

jest.mock('@snaglet/db', () => ({
  assertAllowedTable: jest.fn(),
  quoteIdentifier: (name: string) => `"${name}"`,
}));

jest.mock('@snaglet/db/tables/table_query', () => ({
  TableQuery: { select: (...args: unknown[]) => select(...args) },
  // Keep the real refusal class so `instanceof` checks behave.
  TableQueryError: class TableQueryError extends Error {},
}));

import databaseSearchTool from '@server/services/ToolService/handlers/search/databaseSearch';

/** A TableQuery success result from column/value tuples. */
function rows(columns: string[], data: (string | null)[][], capped = false) {
  return { ok: true, columns, rows: data, capped };
}

/** Queue the allow-list pre-check's "yes, this is a custom table" answer. */
function allowTable() {
  select.mockResolvedValueOnce(rows(['ok'], [['t']]));
}

describe('database_search tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('refuses a table that is not a custom user_tables table (allow-list)', async () => {
    // to_regclass returns NULL → the pre-check reports the table is not custom.
    select.mockResolvedValueOnce(rows(['ok'], [[null]]));

    await expect(databaseSearchTool({ table: 'agents', query: 'x' }, {})).rejects.toThrow(
      /custom Database tables only/
    );
    // Only the allow-list query ran; no column discovery, no search.
    expect(select).toHaveBeenCalledTimes(1);
    expect(String(select.mock.calls[0]?.[0])).toContain("to_regclass('user_tables.");
  });

  it('auto-selects searchable columns through the reader when query is provided', async () => {
    allowTable();
    select
      // column discovery
      .mockResolvedValueOnce(rows(['column_name'], [['title'], ['body']]))
      // the search itself
      .mockResolvedValueOnce(rows(['id', 'title'], [['1', 'hello']]));

    const result = await databaseSearchTool({ table: 'tasks', query: 'hello' }, {});

    expect(select).toHaveBeenCalledTimes(3);
    const searchSql = String(select.mock.calls[2]?.[0]);
    expect(searchSql).toContain('FROM user_tables."tasks"');
    expect(searchSql).toContain(`"title"::text ILIKE '%hello%'`);
    expect(searchSql).toContain(`"body"::text ILIKE '%hello%'`);
    expect(result).toContain('id | title');
    expect(result).toContain('1 | hello');
  });

  it('uses explicit columns as fallback search columns (no discovery query)', async () => {
    allowTable();
    select.mockResolvedValueOnce(rows(['id'], [['1']]));

    await databaseSearchTool(
      { table: 'tasks', query: 'hello', columns: ['title', 'description'] },
      {}
    );

    // allow-list + search, but no column-discovery round-trip.
    expect(select).toHaveBeenCalledTimes(2);
    const sql = String(select.mock.calls[1]?.[0]);
    expect(sql).toContain(`"title"::text ILIKE '%hello%' OR "description"::text ILIKE '%hello%'`);
  });

  it('throws when the table has no searchable columns', async () => {
    allowTable();
    select.mockResolvedValueOnce(rows(['column_name'], []));

    await expect(databaseSearchTool({ table: 'embeddings', query: 'foo' }, {})).rejects.toThrow(
      'No searchable columns found for table "embeddings"'
    );
  });

  it('escapes the search term so a quote cannot break out of the literal', async () => {
    allowTable();
    select.mockResolvedValueOnce(rows(['id'], [['1']]));

    await databaseSearchTool({ table: 'tasks', query: "o'brien", columns: ['name'] }, {});

    const sql = String(select.mock.calls[1]?.[0]);
    expect(sql).toContain(`'%o''brien%'`);
  });

  it('inlines filters as literals and escapes string values', async () => {
    allowTable();
    select.mockResolvedValueOnce(rows(['id'], [['1']]));

    await databaseSearchTool({ table: 'tasks', filters: { status: "o'pen", priority: 2 } }, {});

    const sql = String(select.mock.calls[1]?.[0]);
    expect(sql).toContain(`"status" = 'o''pen'`);
    expect(sql).toContain('"priority" = 2');
  });

  it('parses stringified filters before building the clause', async () => {
    allowTable();
    select.mockResolvedValueOnce(rows(['id'], [['1']]));

    await expect(
      databaseSearchTool({ table: 'tasks', filters: JSON.stringify({ status: 'open' }) }, {})
    ).resolves.toContain('id');

    expect(String(select.mock.calls[1]?.[0])).toContain(`"status" = 'open'`);
  });

  it('turns a reader permission refusal (42501) into the custom-tables-only message', async () => {
    allowTable();
    const denied = Object.assign(new Error('permission denied for table provider_credentials'), {
      code: '42501',
    });
    // query present → column discovery runs first and is where the refusal lands
    select.mockRejectedValueOnce(denied);

    const result = databaseSearchTool({ table: 'tasks', query: 'x' }, {});
    await expect(result).rejects.toThrow(/custom Database tables only/);
  });

  it.each([
    ['malformed JSON', '{"status":'],
    ['null JSON', 'null'],
    ['array JSON', '["open"]'],
    ['string JSON', '"open"'],
    ['number JSON', '42'],
    ['native null', null],
    ['native array', ['open']],
    ['native scalar', true],
    ['native non-plain object', new Date(0)],
  ])('rejects %s filters with a clear shape error', async (_label, filters) => {
    allowTable();
    const result = databaseSearchTool({ table: 'tasks', filters }, {});

    await expect(result).rejects.toThrow('filters must be an object');
    // allow-list ran; the filter shape is rejected before any search query.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('says database search is unavailable when there is no reader connection', async () => {
    select.mockResolvedValueOnce({
      ok: false,
      code: 'unavailable',
      message: 'SQL mode is unavailable',
    });

    await expect(databaseSearchTool({ table: 'tasks', query: 'x' }, {})).rejects.toThrow(
      /Database search is unavailable here/
    );
  });
});
