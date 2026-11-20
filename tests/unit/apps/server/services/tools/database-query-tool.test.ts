import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { TableQueryOptions, TableQueryResult } from '@snaglet/db/tables/table_query';

const mockSelect =
  jest.fn<(sql: string, options: TableQueryOptions) => Promise<TableQueryResult>>();

jest.mock('@snaglet/db/tables/table_query', () => {
  const actual = jest.requireActual<typeof import('@snaglet/db/tables/table_query')>(
    '@snaglet/db/tables/table_query'
  );
  return {
    ...actual,
    WorkspaceQuery: {
      select: (sql: string, options: TableQueryOptions) => mockSelect(sql, options),
    },
  };
});

import { TableQueryError } from '@snaglet/db/tables/table_query';
import databaseQueryTool from '@server/services/ToolService/tools/database/database-query/tool';
import definition from '@server/services/ToolService/tools/database/database-query/definition';
import { hiddenWorkspaceObjects } from '@snaglet/db/runtime/postgres/workspaceReader';

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('database_query tool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockResolvedValue({ ok: true, columns: [], rows: [], capped: false });
  });

  it('renders rows as a table, with NULL for null', async () => {
    mockSelect.mockResolvedValueOnce({
      ok: true,
      columns: ['id', 'content'],
      rows: [
        ['1', 'alpha'],
        ['2', null],
      ],
      capped: false,
    });
    await expect(databaseQueryTool({ sql: 'SELECT id, content FROM docs' }, {})).resolves.toBe(
      'id | content\n---+--------\n1 | alpha\n2 | NULL'
    );
  });

  it('says when more rows matched than the limit', async () => {
    mockSelect.mockResolvedValueOnce({ ok: true, columns: ['n'], rows: [['1']], capped: true });
    const output = await databaseQueryTool({ sql: 'SELECT n FROM t', limit: 1 }, {});
    expect(output).toContain('(showing the first 1 rows; more matched');
    expect(mockSelect).toHaveBeenCalledWith('SELECT n FROM t', { limit: 1, maxCell: 100 });
  });

  it('reports an empty result', async () => {
    await expect(databaseQueryTool({ sql: 'SELECT 1 WHERE false' }, {})).resolves.toBe(
      'No rows returned.'
    );
  });

  it('maps max_column_width onto the SQL-side cell cut', async () => {
    await databaseQueryTool({ sql: 'SELECT 1' }, {});
    await databaseQueryTool({ sql: 'SELECT 1', max_column_width: 40 }, {});
    await databaseQueryTool({ sql: 'SELECT 1', max_column_width: 3 }, {});
    await databaseQueryTool({ sql: 'SELECT 1', max_column_width: -1 }, {});
    expect(mockSelect.mock.calls.map(([, options]) => options.maxCell)).toEqual([
      100, 40, 10, 20_000,
    ]);
  });

  it('rejects invalid arguments before querying', async () => {
    for (const max_column_width of [0, -2, 'not-a-number']) {
      await expect(databaseQueryTool({ sql: 'SELECT 1', max_column_width }, {})).rejects.toThrow(
        'max_column_width must be -1 (widest) or a positive integer'
      );
    }
    for (const limit of [0, 501, 1.5]) {
      await expect(databaseQueryTool({ sql: 'SELECT 1', limit }, {})).rejects.toThrow(
        'limit must be an integer from 1 to 500'
      );
    }
    await expect(databaseQueryTool({}, {})).rejects.toThrow('sql is required');
    await expect(databaseQueryTool({ sql: '   ' }, {})).rejects.toThrow('sql is required');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('refuses rather than falling back when no reader connection exists', async () => {
    mockSelect.mockResolvedValueOnce({ ok: false, code: 'unavailable', message: 'no reader' });
    await expect(databaseQueryTool({ sql: 'SELECT 1' }, {})).rejects.toThrow('no reader');
  });

  it('explains refusals in terms the agent can act on', async () => {
    mockSelect.mockRejectedValueOnce(
      new TableQueryError('not_a_select', 'Only SELECT statements run here (found DELETE).')
    );
    await expect(databaseQueryTool({ sql: 'delete from docs' }, {})).rejects.toThrow(
      'database_query is read-only: Only SELECT statements run here (found DELETE). Use database_execute for writes.'
    );

    mockSelect.mockRejectedValueOnce(pgError('42501', 'permission denied for table mcp_api_keys'));
    const denied = databaseQueryTool({ sql: 'SELECT * FROM mcp_api_keys' }, {});
    await expect(denied).rejects.toThrow(
      /permission denied for table mcp_api_keys\. .*snaglet_workspace_reader/
    );

    mockSelect.mockRejectedValueOnce(
      pgError('57014', 'canceling statement due to statement timeout')
    );
    await expect(databaseQueryTool({ sql: 'SELECT pg_sleep(9)' }, {})).rejects.toThrow(
      /canceled after 5 seconds/
    );

    mockSelect.mockRejectedValueOnce(new Error('Query read timeout'));
    await expect(databaseQueryTool({ sql: 'SELECT pg_sleep(9)' }, {})).rejects.toThrow(
      /canceled after 7 seconds/
    );
  });

  it('names every hidden table and column in its description', () => {
    const { tables, columns } = hiddenWorkspaceObjects();
    for (const table of tables) expect(definition.description).toContain(table);
    for (const qualified of columns) {
      const [table, column] = qualified.split('.') as [string, string];
      expect(definition.description).toContain(table);
      expect(definition.description).toContain(column);
    }
  });
});
