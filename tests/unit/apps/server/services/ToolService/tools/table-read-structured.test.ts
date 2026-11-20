/**
 * Structured `table` reads for hook and tool code (`snaglet.tables.read`).
 *
 * With `structuredResult` on the handler context (only SDK callers through
 * /api/tools/execute set it) a row read also returns `{ rows, fields }` as
 * `rawContent`: text, number, select, checkbox and date fields come back as
 * typed values. The text is byte-for-byte what every other caller gets, so a
 * hook that parses it keeps working.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  AgentEntriesResult,
  AgentListEntriesResult,
  AgentQueryResult,
} from '@server/domains/tables/tableAgent';

const queryAgentTables = jest.fn<() => Promise<AgentQueryResult>>();
const readAgentEntries = jest.fn<() => Promise<AgentEntriesResult>>();
const listAgentEntries = jest.fn<() => Promise<AgentListEntriesResult>>();
const listFields = jest.fn();

jest.mock('@server/domains/tables/tableAgent', () => ({
  queryAgentTables: () => queryAgentTables(),
  readAgentEntries: () => readAgentEntries(),
  listAgentEntries: () => listAgentEntries(),
  describeAgentTable: jest.fn(),
  listAgentTables: async () => [],
  listArchivedAgentTables: async () => [],
  threadProject: async () => null,
}));
jest.mock('@snaglet/db/tables/table_fields', () => ({
  TableFields: { listFields: (...args: unknown[]) => listFields(...args) },
}));

import tableRead from '@server/services/ToolService/handlers/tables/tableRead';
import {
  entryCellValue,
  sqlCellValue,
  type TableReadData,
} from '@server/services/ToolService/tools/database/_shared/structured';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const ENTRY_1 = '11111111-1111-4111-8111-111111111111';
const ENTRY_2 = '22222222-2222-4222-8222-222222222222';
const SDK = { agentId: 'test-agent-a', structuredResult: true };

const FIELDS = [
  { name: 'id', type: 'uuid', managed: true },
  { name: 'name', type: 'text', managed: false },
  { name: 'phase', type: 'number', managed: false },
  { name: 'status', type: 'select', managed: false },
  { name: 'done', type: 'checkbox', managed: false },
  { name: 'due', type: 'date', managed: false },
  { name: 'tags', type: 'select', managed: false },
];

const QUERY: AgentQueryResult = {
  columns: ['name', 'phase', 'status', 'done', 'due', 'tags'],
  rows: [
    ['Intro', '1', 'Done', 'true', '2026-10-30', '["a","b"]'],
    ['Outro', '2', 'In progress', 'false', null, '[]'],
    ['Wrap', '2', 'Done', 'true', '2026-10-31', '[]'],
  ],
  types: [
    ['string', 'number', 'string', 'boolean', 'string', 'array'],
    ['string', 'number', 'string', 'boolean', 'null', 'array'],
    ['string', 'number', 'string', 'boolean', 'string', 'array'],
  ],
  capped: false,
};

const ENTRIES: AgentEntriesResult = {
  table: 'work_loop',
  tableId: TABLE_ID,
  entries: [
    {
      id: ENTRY_1,
      rev: 'abcdef12',
      values: {
        name: 'Intro',
        phase: '1.5',
        status: 'Done',
        done: true,
        due: '2026-10-30',
        tags: ['a'],
      },
    },
    {
      id: ENTRY_2,
      rev: '12abcdef',
      values: { name: 'Outro', phase: null, status: null, done: false, due: null, tags: [] },
    },
  ],
  missing: [],
};

/** How hooks written before structured reads parse a `{sql}` read's TSV. */
function legacySqlRows(output: string): Record<string, string>[] {
  const lines = output.split('\n');
  const header = lines[0]?.split('\t') ?? [];
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    if (cells.length !== header.length) continue;
    rows.push(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  }
  return rows;
}

function rich(result: unknown): { output: string; rawContent: TableReadData } {
  expect(typeof result).toBe('object');
  return result as { output: string; rawContent: TableReadData };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryAgentTables.mockResolvedValue(QUERY);
  readAgentEntries.mockResolvedValue(ENTRIES);
  listAgentEntries.mockResolvedValue({
    ...ENTRIES,
    page: 1,
    pageSize: 25,
    total: 2,
    hasMore: false,
    schemaVersion: 'v1',
  });
  listFields.mockResolvedValue(FIELDS);
});

describe('table read, sql', () => {
  const input = { sql: 'SELECT name, phase, status, done, due, tags FROM user_tables.work_loop' };

  it('returns typed rows for SDK callers, beside the same text', async () => {
    const plain = await tableRead(input, {}, { agentId: 'test-agent-a' });
    const structured = rich(await tableRead(input, {}, SDK));

    expect(typeof plain).toBe('string');
    expect(structured.output).toBe(plain);
    expect(structured.rawContent.fields).toEqual(QUERY.columns);
    expect(structured.rawContent.rows[0]).toEqual({
      name: 'Intro',
      phase: 1,
      status: 'Done',
      done: true,
      due: '2026-10-30',
      tags: ['a', 'b'],
    });
    expect(structured.rawContent.rows[1]).toMatchObject({ done: false, due: null, tags: [] });
  });

  it('lets a hook gate on a phase without parsing text', async () => {
    const { rawContent } = rich(await tableRead(input, {}, SDK));
    const phase = (n: number) => rawContent.rows.filter((row) => row.phase === n);

    expect(phase(1).every((row) => row.status === 'Done')).toBe(true);
    expect(phase(2).every((row) => row.status === 'Done')).toBe(false);
  });

  it('keeps an existing hook that parses the TSV working', async () => {
    const plain = await tableRead(input, {}, undefined);
    const structured = rich(await tableRead(input, {}, SDK));

    expect(legacySqlRows(structured.output)).toEqual(legacySqlRows(plain as string));
    expect(legacySqlRows(structured.output)[0]).toEqual({
      name: 'Intro',
      phase: '1',
      status: 'Done',
      done: 'true',
      due: '2026-10-30',
      tags: '["a","b"]',
    });
  });

  it('never adds rows to a chat read', async () => {
    expect(typeof (await tableRead(input, {}, { agentId: 'test-agent-a' }))).toBe('string');
    expect(listFields).not.toHaveBeenCalled();
  });
});

describe('table read, entries', () => {
  it('{table, ids}: id, rev and every field, a number field as a number', async () => {
    const input = { table: 'work_loop', ids: [ENTRY_1, ENTRY_2] };
    const plain = await tableRead(input, {}, undefined);
    const structured = rich(await tableRead(input, {}, SDK));

    expect(structured.output).toBe(plain);
    expect(listFields).toHaveBeenCalledWith(TABLE_ID);
    expect(structured.rawContent.fields).toEqual([
      'id',
      'rev',
      'name',
      'phase',
      'status',
      'done',
      'due',
      'tags',
    ]);
    expect(structured.rawContent.rows).toEqual([
      {
        id: ENTRY_1,
        rev: 'abcdef12',
        name: 'Intro',
        phase: 1.5,
        status: 'Done',
        done: true,
        due: '2026-10-30',
        tags: ['a'],
      },
      {
        id: ENTRY_2,
        rev: '12abcdef',
        name: 'Outro',
        phase: null,
        status: null,
        done: false,
        due: null,
        tags: [],
      },
    ]);
  });

  it('a field the entry never set reads null', async () => {
    readAgentEntries.mockResolvedValue({
      ...ENTRIES,
      entries: [{ id: ENTRY_1, rev: 'abcdef12', values: { name: 'Solo' } }],
    });
    const structured = rich(await tableRead({ table: 'work_loop', ids: [ENTRY_1] }, {}, SDK));
    expect(structured.rawContent.rows[0]).toEqual({
      id: ENTRY_1,
      rev: 'abcdef12',
      name: 'Solo',
      phase: null,
      status: null,
      done: null,
      due: null,
      tags: null,
    });
  });

  it('a paged read narrowed by columns lists only those fields', async () => {
    const structured = rich(
      await tableRead({ table: 'work_loop', columns: ['Phase', 'status'] }, {}, SDK)
    );
    expect(structured.rawContent.fields).toEqual(['id', 'rev', 'phase', 'status']);
    expect(structured.rawContent.rows[0]).toEqual({
      id: ENTRY_1,
      rev: 'abcdef12',
      phase: 1.5,
      status: 'Done',
    });
  });
});

describe('cell conversion', () => {
  it('types SQL cells by their JSON type and keeps cut or odd cells as text', () => {
    expect(sqlCellValue('12.50', 'number')).toBe(12.5);
    expect(sqlCellValue('1e+20', 'number')).toBe('1e+20');
    expect(sqlCellValue('9007199254740993', 'number')).toBe('9007199254740993');
    expect(sqlCellValue('9007199254740991', 'number')).toBe(9007199254740991);
    expect(sqlCellValue('NaN', 'number')).toBe('NaN');
    expect(sqlCellValue('true', 'boolean')).toBe(true);
    expect(sqlCellValue(null, 'null')).toBeNull();
    expect(sqlCellValue('[1,"x",null,{"k":1}]', 'array')).toEqual([1, 'x', null, '{"k":1}']);
    expect(sqlCellValue('["aaaa…[+12 chars]', 'array')).toBe('["aaaa…[+12 chars]');
    expect(sqlCellValue('{"k": 1}', 'object')).toBe('{"k": 1}');
    expect(sqlCellValue('[2026-01-31,2026-02-03)', 'string')).toBe('[2026-01-31,2026-02-03)');
    expect(sqlCellValue('7', undefined)).toBe('7');
  });

  it('types entry values by field type', () => {
    expect(entryCellValue('3', 'number')).toBe(3);
    expect(entryCellValue('12345678901234567890', 'number')).toBe('12345678901234567890');
    expect(entryCellValue('', 'number')).toBe('');
    expect(entryCellValue('3', 'text')).toBe('3');
    expect(entryCellValue(true, 'checkbox')).toBe(true);
    expect(entryCellValue(['a', 'b'], 'select')).toEqual(['a', 'b']);
    expect(entryCellValue(null, 'date')).toBeNull();
    expect(entryCellValue(undefined, 'date')).toBeNull();
  });
});
