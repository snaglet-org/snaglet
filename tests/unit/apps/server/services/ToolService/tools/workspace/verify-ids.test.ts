/**
 * verify_ids — Database table catalog ids.
 *
 * A `table:` chip targets a catalog id (`table-builtin-<slug>` or
 * `table-<13 digits>-<suffix>`), which is not a workspace node id. The tool
 * resolves those against public.table_catalog (never public.nodes) and reports
 * them in the same per-id shape as nodes, with type `table` and the name.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const query = jest.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>();
jest.mock('@snaglet/db', () => ({
  getDb: () => ({ query: (sql: string, params: unknown[]) => query(sql, params) }),
}));

import execute from '@server/services/ToolService/handlers/workspace/verifyIds';
import definition from '@server/services/ToolService/tools/workspace/node/definition';

const DOC_ID = 'doc-1111111111111-aaaaaaaaa';
const CUSTOM_TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const MISSING_TABLE_ID = 'table-1111111111111-bbbbbbbbb';

beforeEach(() => {
  jest.clearAllMocks();
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('public.table_catalog')) {
      return {
        rows: [
          { id: 'table-builtin-credentials', name: 'Credentials' },
          { id: CUSTOM_TABLE_ID, name: 'Test Table' },
        ],
      };
    }
    return { rows: [{ id: DOC_ID, type: 'doc', title: 'Test Doc', archived: false }] };
  });
});

describe('verify_ids — table catalog ids', () => {
  it('reports catalog ids as tables and keeps the node report shape', async () => {
    const result = await execute({
      ids: [DOC_ID, 'table-builtin-credentials', CUSTOM_TABLE_ID, MISSING_TABLE_ID],
    });

    expect(result.verified).toEqual([
      { id: DOC_ID, exists: true, type: 'doc', title: 'Test Doc', archived: false },
      {
        id: 'table-builtin-credentials',
        exists: true,
        type: 'table',
        title: 'Credentials',
        archived: false,
      },
      { id: CUSTOM_TABLE_ID, exists: true, type: 'table', title: 'Test Table', archived: false },
      { id: MISSING_TABLE_ID, exists: false },
    ]);
    expect(result.summary).toEqual({ requested: 4, found: 3, not_found: 1 });
  });

  it('checks catalog ids only against the catalog and node ids only against nodes', async () => {
    await execute({ ids: [DOC_ID, 'table-builtin-credentials'] });

    const calls = query.mock.calls.map(([sql, params]) => ({ sql, params }));
    const nodeCall = calls.find(({ sql }) => sql.includes('FROM nodes n'));
    const tableCall = calls.find(({ sql }) => sql.includes('public.table_catalog'));
    expect(nodeCall?.params).toEqual([[DOC_ID]]);
    expect(tableCall?.params).toEqual([['table-builtin-credentials']]);
    expect(tableCall?.sql).not.toContain('table_name');
  });

  it('skips the nodes query when every id is a catalog id', async () => {
    const result = await execute({ ids: ['table-builtin-credentials'] });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('public.table_catalog');
    expect(result.summary).toEqual({ requested: 1, found: 1, not_found: 0 });
  });

  it('skips the catalog query when no id is a catalog id', async () => {
    await execute({ ids: [DOC_ID] });

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('FROM nodes n');
  });

  it('describes table ids on node(op:get) `ids`', () => {
    const ids = (definition.parameters_schema.properties as Record<string, { description: string }>)
      .ids;
    expect(ids.description).toContain('table-builtin-');
    expect(ids.description).toContain('type `table`');
  });
});
