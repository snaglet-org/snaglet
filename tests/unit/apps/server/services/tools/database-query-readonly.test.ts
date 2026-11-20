/**
 * Security: database_query never runs agent SQL on the app pool.
 * Every statement goes to the workspace reader through the WorkspaceQuery
 * sandbox, whose pre-check refuses anything but one SELECT before a
 * connection is even checked out — stacked statements, data-modifying CTEs,
 * comment cloaks and EXPLAIN ANALYZE included. The role behind the reader is
 * the real boundary (see tests/integration/apps/server/db/workspaceQuery.test.ts).
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type QueryFn = (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows: unknown[] }>;

const mockReaderQuery = jest.fn<QueryFn>();
const mockWithConnection = jest.fn(
  async (
    fn: (connection: { query: QueryFn; processId: number | null; discard(): void }) => unknown
  ) => fn({ query: mockReaderQuery, processId: 1, discard: () => {} })
);
const mockAppQuery = jest.fn<QueryFn>();

jest.mock('@snaglet/db/db', () => ({
  getDbClient: async () => ({ query: mockAppQuery }),
  getTablesReaderClient: async () => null,
  getWorkspaceReaderClient: async () => ({ withConnection: mockWithConnection }),
}));

import databaseQueryTool from '@server/services/ToolService/tools/database/database-query/tool';

describe('database_query — agent SQL only reaches the read-only sandbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReaderQuery.mockResolvedValue({ rows: [] });
  });

  it.each([
    ['stacked statement after a select', 'select 1; drop table users'],
    ['stacked update after a select', "select 'ok'; update accounts set balance = 0"],
    ['data-modifying CTE', 'WITH t AS (DELETE FROM users RETURNING id) SELECT * FROM t'],
    ['leading block comment cloak', '/* harmless */ delete from users'],
    ['leading line comment cloak', '-- harmless\ndelete from users'],
    ['EXPLAIN ANALYZE executes its inner write', 'explain analyze delete from users'],
    ['leading paren then insert', '(insert into x values (1))'],
    ['uppercase / extra whitespace', '   DELETE   FROM users'],
    ['COPY to a program', "COPY (SELECT 1) TO PROGRAM 'id'"],
    ['session authorization', 'SET SESSION AUTHORIZATION snaglet'],
  ])('refuses before any connection: %s', async (_label, sql) => {
    await expect(databaseQueryTool({ sql }, {})).rejects.toThrow(/database_query is read-only/);
    expect(mockWithConnection).not.toHaveBeenCalled();
    expect(mockAppQuery).not.toHaveBeenCalled();
  });

  it('ignores a read_only: false setting — writes are never allowed', async () => {
    await expect(
      databaseQueryTool({ sql: 'delete from users' }, { read_only: false })
    ).rejects.toThrow(/database_query is read-only/);
    expect(mockWithConnection).not.toHaveBeenCalled();
  });

  it('runs a SELECT on the reader inside a READ ONLY transaction, never on the app pool', async () => {
    await expect(databaseQueryTool({ sql: 'SELECT * FROM docs' }, {})).resolves.toBe(
      'No rows returned.'
    );
    expect(mockWithConnection).toHaveBeenCalledTimes(1);
    const statements = mockReaderQuery.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe('BEGIN READ ONLY');
    expect(statements.some((sql) => sql.includes('SELECT * FROM docs'))).toBe(true);
    expect(statements).toContain('ROLLBACK');
    expect(mockAppQuery).not.toHaveBeenCalled();
  });
});
