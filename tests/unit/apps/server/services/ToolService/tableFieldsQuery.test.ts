import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const describeAgentTable = jest.fn();
const queryAgentTables = jest.fn();
const readAgentEntries = jest.fn();

jest.mock('@server/domains/tables/tableAgent', () => ({
  describeAgentTable,
  queryAgentTables,
  readAgentEntries,
}));

import tableTool from '@server/services/ToolService/tools/tables/table/tool';

const run = (input: Record<string, unknown>) => tableTool(input, {}, undefined);
const table = {
  id: 'table-1',
  name: 'tasks',
  rows: 4,
  rowsCapped: false,
  fields: [
    {
      id: 'f-title',
      name: 'name',
      type: 'text',
      isTitle: true,
      managed: false,
      nullable: false,
      defaultValue: null,
      description: 'title',
      options: null,
      referenceTableId: null,
      referenceKind: null,
      multiple: false,
      range: false,
      recurrence: null,
      calendarId: null,
    },
    {
      id: 'f-status',
      name: 'status',
      type: 'select',
      isTitle: false,
      managed: false,
      nullable: true,
      defaultValue: null,
      description: null,
      options: [{ label: 'Todo' }],
      referenceTableId: null,
      referenceKind: null,
      multiple: false,
      range: false,
      recurrence: null,
      calendarId: null,
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  describeAgentTable.mockResolvedValue(table);
  queryAgentTables.mockResolvedValue({ columns: ['id'], rows: [['e1']], capped: false });
});

describe('table fields/query operations', () => {
  it('fields returns metadata only and never reads rows or includes examples', async () => {
    const result = JSON.parse(await run({ op: 'fields', table: 'tasks' }));
    expect(result).toEqual({ id: 'table-1', name: 'tasks', fields: table.fields });
    expect(describeAgentTable).toHaveBeenCalledWith('tasks');
    expect(readAgentEntries).not.toHaveBeenCalled();
    expect(queryAgentTables).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('example');
  });

  it('query routes SQL through the existing read-only query engine with limits', async () => {
    const result = await run({
      op: 'query',
      sql: 'SELECT id FROM user_tables.tasks',
      limit: 7,
      max_cell: 123,
    });
    expect(queryAgentTables).toHaveBeenCalledWith('SELECT id FROM user_tables.tasks', {
      limit: 7,
      maxCell: 123,
    });
    expect(result).toContain('id');
    expect(readAgentEntries).not.toHaveBeenCalled();
  });

  it('requires table for fields and nonblank SQL for query', async () => {
    await expect(run({ op: 'fields' })).rejects.toThrow(/table is required/);
    await expect(run({ op: 'query', sql: '  ' })).rejects.toThrow(/sql is required/);
  });

  it('rejects foreign fields and preserves legacy read SQL behavior', async () => {
    await expect(run({ op: 'fields', table: 'tasks', ids: ['e1'] })).rejects.toThrow(
      /ids.*belongs to op read/
    );
    await expect(run({ op: 'query', sql: 'SELECT 1', table: 'tasks' })).rejects.toThrow(
      /table.*belongs to op/
    );
    await run({ op: 'read', sql: 'SELECT 1', limit: 3 });
    expect(queryAgentTables).toHaveBeenCalledWith('SELECT 1', { limit: 3, maxCell: 200 });
  });

  it('propagates readonly SQL engine failures', async () => {
    queryAgentTables.mockRejectedValueOnce(new Error('SELECT only'));
    await expect(
      run({ op: 'query', sql: 'UPDATE user_tables.tasks SET name = 1' })
    ).rejects.toThrow(/SELECT only/);
  });
});
