import { AppError, getErrorMessage } from '@snaglet/shared/utils';
import { ErrorCode } from '@snaglet/shared/types';
import type { AgentTableField, AgentTableSummary } from '@server/domains/tables/tableAgent';
import {
  invokeTool,
  toolOutputText,
  type ToolHandler,
} from '../../../../../../support/toolHarness';

const listAgentTables = jest.fn();
const listArchivedAgentTables = jest.fn(async (): Promise<string[]> => []);
const threadProject = jest.fn();
const describeAgentTable = jest.fn();
const queryAgentTables = jest.fn();
const readAgentEntries = jest.fn();
const listAgentEntries = jest.fn();
const writeAgentEntries = jest.fn();
const applyAgentSchema = jest.fn();
const deleteAgentEntries = jest.fn();

jest.mock('@server/domains/tables/tableAgent', () => ({
  listAgentTables: (...args: unknown[]) => listAgentTables(...args),
  listArchivedAgentTables: (...args: unknown[]) => listArchivedAgentTables(...args),
  threadProject: (...args: unknown[]) => threadProject(...args),
  describeAgentTable: (...args: unknown[]) => describeAgentTable(...args),
  queryAgentTables: (...args: unknown[]) => queryAgentTables(...args),
  readAgentEntries: (...args: unknown[]) => readAgentEntries(...args),
  listAgentEntries: (...args: unknown[]) => listAgentEntries(...args),
  writeAgentEntries: (...args: unknown[]) => writeAgentEntries(...args),
  applyAgentSchema: (...args: unknown[]) => applyAgentSchema(...args),
  deleteAgentEntries: (...args: unknown[]) => deleteAgentEntries(...args),
}));

import tableRead from '@server/services/ToolService/handlers/tables/tableRead';
import tableWrite from '@server/services/ToolService/handlers/tables/tableWrite';
import tableSchema from '@server/services/ToolService/handlers/tables/tableSchema';
import tableDelete from '@server/services/ToolService/handlers/tables/tableDelete';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';
const OTHER_TABLE_ID = 'table-2222222222222-bbbbbbbbb';
const PROJECT_ID = 'container-1111111111111-aaaaaaaaa';
const THREAD_ID = 'thread-1111111111111-aaaaaaaaa';
const LAUNCH = { id: PROJECT_ID, name: 'Launch' };
/** The schema handler's caller when the call comes from no thread. */
const NO_THREAD = { threadId: undefined };
const LIST_HINT =
  '* title, ? nullable, →t relation (→snaglet:doc etc. links Snaglet items), [] multiple, .. range (start/end), @p project home (none: workspace-wide). table {op: "read", table} for field details and a write example; {op: "read", sql} to query.';
const FIELD_ID = 'field-2222222222222-bbbbbbbbb';
const ENTRY_A = '11111111-1111-4111-8111-111111111111';
const ENTRY_B = '22222222-2222-4222-8222-222222222222';
const ENTRY_C = '33333333-3333-4333-8333-333333333333';
const ENTRY_D = '44444444-4444-4444-8444-444444444444';

type FieldOverrides = Partial<AgentTableField> & Pick<AgentTableField, 'name' | 'type'>;

function field(over: FieldOverrides): AgentTableField {
  return {
    id: `field-1111111111111-${over.name.replace(/_/g, '')}`,
    tableId: TABLE_ID,
    columnName: over.name,
    description: null,
    nullable: false,
    defaultValue: null,
    referenceTableId: null,
    referenceKind: null,
    multiple: false,
    range: false,
    options: null,
    position: 0,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    ...over,
  };
}

const companies: AgentTableSummary = {
  id: TABLE_ID,
  name: 'companies',
  rows: 3,
  rowsCapped: false,
  fields: [
    field({
      name: 'name',
      type: 'text',
      isTitle: true,
      defaultValue: '',
      description: 'Entry name.',
    }),
    field({ name: 'id', type: 'uuid', managed: true }),
    field({ name: 'created_at', type: 'datetime', managed: true }),
    field({
      name: 'website',
      type: 'text',
      nullable: true,
      description: 'Public homepage.\n  No tracking params.',
    }),
    field({ name: 'employees', type: 'number', nullable: true, defaultValue: '10' }),
    field({ name: 'founded', type: 'date', nullable: true }),
    field({ name: 'active', type: 'checkbox', defaultValue: false }),
    field({
      name: 'emails',
      type: 'relation',
      multiple: true,
      defaultValue: [],
      referenceTableId: OTHER_TABLE_ID,
      refName: 'emails',
      description: 'Contact addresses.',
    }),
    field({
      name: 'parent',
      type: 'relation',
      nullable: true,
      referenceTableId: TABLE_ID,
      refName: 'companies',
    }),
  ],
};

const emails: AgentTableSummary = {
  id: OTHER_TABLE_ID,
  name: 'emails',
  rows: 10000,
  rowsCapped: true,
  fields: [
    field({ name: 'address', type: 'text', isTitle: true }),
    field({ name: 'id', type: 'uuid', managed: true }),
    field({
      name: 'company',
      type: 'relation',
      nullable: true,
      referenceTableId: TABLE_ID,
      refName: 'companies',
    }),
  ],
};

const COMPANIES_FIELD_LINES = [
  'name* text — Entry name.',
  'website text? — Public homepage. No tracking params.',
  'employees number? = "10"',
  'founded date?',
  'active checkbox = false',
  'emails →emails[] — Contact addresses.',
  'parent →companies?',
  'system: id uuid, created_at, position (row order)',
  `link an entry: [title](entry:${TABLE_ID}/<entry id>)`,
  'example: table {"op":"write","table":"companies","insert":[{"values":{"name":"text","employees":"12.5","founded":"2026-01-31","active":true,"emails":["<entry id>"],"parent":"<entry id>"}}]}',
];

async function output(tool: ToolHandler, input: unknown): Promise<string> {
  return toolOutputText(await invokeTool(tool, input));
}

/** Failures reject so the executor marks the call failed; the message is the rendered line. */
async function failure(tool: ToolHandler, input: unknown): Promise<string> {
  try {
    await invokeTool(tool, input);
  } catch (err) {
    return getErrorMessage(err);
  }
  throw new Error('expected the tool call to fail');
}

beforeEach(() => jest.resetAllMocks());

describe('table_read', () => {
  it('lists every table on one line with the notation key and next steps', async () => {
    listAgentTables.mockResolvedValue([companies, emails]);
    expect(await output(tableRead, {})).toBe(
      [
        'companies (3): name* text, website text?, employees number?, founded date?, active checkbox, emails →emails[], parent →companies?',
        'emails (10000+): address* text, company →companies?',
        LIST_HINT,
      ].join('\n')
    );
    expect(threadProject).toHaveBeenCalledWith(undefined);
  });

  it('tags linked tables with their project and leads with the thread project from a project thread', async () => {
    threadProject.mockResolvedValue(LAUNCH);
    listAgentTables.mockResolvedValue([
      { ...companies, project: LAUNCH },
      emails,
      {
        ...emails,
        id: 'table-3333333333333-ccccccccc',
        name: 'leads',
        project: { id: 'container-2222222222222-bbbbbbbbb', name: 'Sales' },
      },
    ]);
    const result = toolOutputText(await invokeTool(tableRead, {}, { threadId: THREAD_ID }));
    expect(result.split('\n')).toEqual([
      'in project Launch: 1 table first, then workspace-wide, then other projects',
      'companies (3) @Launch: name* text, website text?, employees number?, founded date?, active checkbox, emails →emails[], parent →companies?',
      'emails (10000+): address* text, company →companies?',
      'leads (10000+) @Sales: address* text, company →companies?',
      LIST_HINT,
    ]);
    expect(threadProject).toHaveBeenCalledWith(THREAD_ID);
    expect(listAgentTables).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('shows the project on a single-table read', async () => {
    describeAgentTable.mockResolvedValue({ ...companies, project: LAUNCH });
    expect((await output(tableRead, { table: 'companies' })).split('\n')[0]).toBe(
      'companies (3 rows) @Launch'
    );
  });

  it('points at table_schema when there are no tables', async () => {
    listAgentTables.mockResolvedValue([]);
    expect(await output(tableRead, {})).toBe(
      'No tables yet. Create one with table {op: "schema", table, fields}.'
    );
  });

  it('treats blank selectors and the legacy origin filter as a plain list', async () => {
    listAgentTables.mockResolvedValue([emails]);
    await output(tableRead, { table: ' ', sql: '', origin: 'custom' });
    expect(listAgentTables).toHaveBeenCalledWith(null);
    expect(describeAgentTable).not.toHaveBeenCalled();
    expect(queryAgentTables).not.toHaveBeenCalled();
  });

  it('falls back to the target id when a relation target has no name', async () => {
    listAgentTables.mockResolvedValue([
      {
        ...emails,
        rows: 1,
        rowsCapped: false,
        fields: [field({ name: 'company', type: 'relation', referenceTableId: TABLE_ID })],
      },
    ]);
    expect((await output(tableRead, {})).split('\n')[0]).toBe(`emails (1): company →${TABLE_ID}`);
  });

  it('describes one table with descriptions, defaults, system columns and a write example', async () => {
    describeAgentTable.mockResolvedValue(companies);
    expect(await output(tableRead, { table: 'companies' })).toBe(
      ['companies (3 rows)', ...COMPANIES_FIELD_LINES].join('\n')
    );
    expect(describeAgentTable).toHaveBeenCalledWith('companies');
  });

  it('names the user zone and shows the datetime format for tables with a datetime field', async () => {
    const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    const zone = jest
      .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
      .mockImplementation(function (this: Intl.DateTimeFormat) {
        return { ...resolved.call(this), timeZone: 'Pacific/Auckland' };
      });
    try {
      describeAgentTable.mockResolvedValue({
        ...emails,
        name: 'events',
        rows: 2,
        rowsCapped: false,
        fields: [
          ...emails.fields.slice(0, 2),
          field({ name: 'starts_at', type: 'datetime', nullable: true }),
          field({
            name: 'reminder_at',
            type: 'datetime',
            defaultValue: '2026-10-01T02:30:00.000000Z',
          }),
        ],
      });
      expect(await output(tableRead, { table: 'events' })).toBe(
        [
          'events (2 rows)',
          'address* text',
          'starts_at datetime?',
          'reminder_at datetime = "2026-10-01T02:30:00.000000Z"',
          'system: id uuid, created_at, position (row order)',
          `link an entry: [title](entry:${OTHER_TABLE_ID}/<entry id>)`,
          'datetimes: ISO 8601; no offset and sql output use Pacific/Auckland',
          'example: table {"op":"write","table":"events","insert":[{"values":{"address":"text","starts_at":"2026-01-31T15:30"}}]}',
        ].join('\n')
      );
    } finally {
      zone.mockRestore();
    }
  });

  it('marks range fields, says how their end counts and shows start/end placeholders', async () => {
    const trips: AgentTableSummary = {
      id: TABLE_ID,
      name: 'trips',
      rows: 3,
      rowsCapped: false,
      fields: [
        field({ name: 'name', type: 'text', isTitle: true, defaultValue: '' }),
        field({ name: 'stay', type: 'date', range: true, nullable: true }),
        field({ name: 'slot', type: 'datetime', range: true }),
        field({ name: 'booked', type: 'date', nullable: true }),
      ],
    };
    listAgentTables.mockResolvedValue([trips]);
    expect((await output(tableRead, {})).split('\n')[0]).toBe(
      'trips (3): name* text, stay date..?, slot datetime.., booked date?'
    );
    describeAgentTable.mockResolvedValue(trips);
    const lines = (await output(tableRead, { table: 'trips' })).split('\n');
    expect(lines.slice(1, 5)).toEqual([
      'name* text',
      'stay date..?',
      'slot datetime..',
      'booked date?',
    ]);
    expect(lines).toContain(
      'ranges (..): start/end or one value; 2026-01-31/2026-02-02 is three days (date ranges include their end); a datetime range ends at its end instant; sql shows PostgreSQL ranges, end excluded: [2026-01-31,2026-02-03)'
    );
    // A range and a plain date are different value shapes, so both show once.
    expect(lines.slice(-1)[0]).toBe(
      'example: table {"op":"write","table":"trips","insert":[{"values":{"name":"text","stay":"2026-01-31/2026-02-02","slot":"2026-01-31T15:30/2026-01-31T17:00","booked":"2026-01-31"}}]}'
    );
    // Without a range field there is no range line.
    describeAgentTable.mockResolvedValue({
      ...trips,
      fields: [trips.fields[0]!, trips.fields[3]!],
    });
    expect(await output(tableRead, { table: 'trips' })).not.toContain('ranges (..)');
  });

  it('marks a repeating field and shows the calendar a date field shows on', async () => {
    const chores: AgentTableSummary = {
      id: TABLE_ID,
      name: 'chores',
      rows: 2,
      rowsCapped: false,
      fields: [
        field({ name: 'name', type: 'text', isTitle: true, defaultValue: '' }),
        field({
          name: 'due',
          type: 'date',
          nullable: true,
          recurrence: {
            statusFieldId: null,
            doneOptionIds: [],
            resetOptionId: null,
          },
          calendarId: 'calendar-1111111111111-aaaaaaaaa',
          calendarName: 'Home',
          description: 'When it is due.',
        }),
        field({
          name: 'checked',
          type: 'datetime',
          nullable: true,
          calendarId: 'calendar-1111111111111-bbbbbbbbb',
        }),
      ],
    };
    describeAgentTable.mockResolvedValue(chores);
    const lines = (await output(tableRead, { table: 'chores' })).split('\n');
    expect(lines.slice(1, 4)).toEqual([
      'name* text',
      'due date? ↻ calendar "Home" — When it is due.',
      // A calendar the describe could not name shows by id.
      'checked datetime? calendar "calendar-1111111111111-bbbbbbbbb"',
    ]);
  });

  it('uses the singular for one row and + for a capped count', async () => {
    describeAgentTable.mockResolvedValueOnce({ ...emails, rows: 1, rowsCapped: false });
    expect((await output(tableRead, { table: 'emails' })).split('\n')[0]).toBe('emails (1 row)');
    describeAgentTable.mockResolvedValueOnce(emails);
    expect((await output(tableRead, { table: 'emails' })).split('\n')[0]).toBe(
      'emails (10000+ rows)'
    );
  });

  it('shows relations to Snaglet items as snaglet:<kind> with id placeholders', async () => {
    const briefs: AgentTableSummary = {
      id: TABLE_ID,
      name: 'briefs',
      rows: 2,
      rowsCapped: false,
      fields: [
        field({ name: 'name', type: 'text', isTitle: true, defaultValue: '' }),
        field({
          name: 'brief',
          type: 'relation',
          nullable: true,
          referenceKind: 'doc',
          refName: 'snaglet:doc',
        }),
        field({
          name: 'owners',
          type: 'relation',
          multiple: true,
          defaultValue: [],
          referenceKind: 'agent',
          refName: 'snaglet:agent',
        }),
        field({ name: 'parent', type: 'relation', nullable: true, referenceTableId: TABLE_ID }),
      ],
    };
    listAgentTables.mockResolvedValue([briefs]);
    expect((await output(tableRead, {})).split('\n')[0]).toBe(
      `briefs (2): name* text, brief →snaglet:doc?, owners →snaglet:agent[], parent →${TABLE_ID}?`
    );
    describeAgentTable.mockResolvedValue(briefs);
    expect((await output(tableRead, { table: 'briefs' })).split('\n').slice(-1)[0]).toBe(
      'example: table {"op":"write","table":"briefs","insert":[{"values":{"name":"text","brief":"<doc id>","owners":["<agent id>"],"parent":"<entry id>"}}]}'
    );
  });

  it('names the Snaglet items a query returns on one line after the count', async () => {
    queryAgentTables.mockResolvedValue({
      columns: ['name', 'brief'],
      rows: [['Row A', 'doc-1111111111111-aaaaaaaaa']],
      capped: false,
      itemTitles: [
        { id: 'doc-1111111111111-aaaaaaaaa', title: 'Launch brief', archived: false },
        { id: 'test-agent-a', title: `Test ${'x'.repeat(70)}`, archived: true },
      ],
    });
    expect(
      (await output(tableRead, { sql: 'SELECT name, brief FROM briefs' })).split('\n')
    ).toEqual([
      'name\tbrief',
      'Row A\tdoc-1111111111111-aaaaaaaaa',
      '1 row',
      `snaglet titles: doc-1111111111111-aaaaaaaaa "Launch brief", test-agent-a "Test ${'x'.repeat(54)}…" (archived)`,
    ]);
  });

  it('returns SQL rows as escaped TSV with defaults applied', async () => {
    queryAgentTables.mockResolvedValue({
      columns: ['name', 'notes'],
      rows: [
        ['Row A', 'line 1\nline 2\tend'],
        ['C:\\temp', null],
        ['', 'x\r'],
      ],
      capped: false,
    });
    expect(await output(tableRead, { sql: 'SELECT name, notes FROM companies' })).toBe(
      ['name\tnotes', 'Row A\tline 1\\nline 2\\tend', 'C:\\\\temp\t', '\tx\\r', '3 rows'].join('\n')
    );
    expect(queryAgentTables).toHaveBeenCalledWith('SELECT name, notes FROM companies', {
      limit: 50,
      maxCell: 200,
    });
  });

  it('counts one row and an empty result', async () => {
    queryAgentTables.mockResolvedValueOnce({ columns: ['n'], rows: [['1']], capped: false });
    expect(await output(tableRead, { sql: 'SELECT 1 AS n' })).toBe('n\n1\n1 row');
    queryAgentTables.mockResolvedValueOnce({ columns: [], rows: [], capped: false });
    expect(await output(tableRead, { sql: 'SELECT 1 WHERE false' })).toBe('0 rows');
  });

  it('flags a capped result with the next step that still applies', async () => {
    queryAgentTables.mockResolvedValueOnce({ columns: ['n'], rows: [['1'], ['2']], capped: true });
    expect(await output(tableRead, { sql: 'SELECT n FROM t', limit: 2, max_cell: 40 })).toBe(
      'n\n1\n2\n2 of 2+ rows (capped; add WHERE or raise limit)'
    );
    expect(queryAgentTables).toHaveBeenLastCalledWith('SELECT n FROM t', { limit: 2, maxCell: 40 });

    queryAgentTables.mockResolvedValueOnce({ columns: ['n'], rows: [['1']], capped: true });
    expect(await output(tableRead, { sql: 'SELECT n FROM t', limit: 200, max_cell: 4000 })).toBe(
      'n\n1\n1 of 1+ rows (capped; add WHERE or page with OFFSET)'
    );
  });

  it.each([
    [{ table: 'companies', sql: 'SELECT 1' }, 'error 400: pass table or sql, not both'],
    [{ sql: 'SELECT 1', limit: 0 }, 'error 400: limit must be an integer 1-200'],
    [{ sql: 'SELECT 1', limit: 201 }, 'error 400: limit must be an integer 1-200'],
    [{ sql: 'SELECT 1', limit: '50' }, 'error 400: limit must be an integer 1-200'],
    [{ sql: 'SELECT 1', limit: 1.5 }, 'error 400: limit must be an integer 1-200'],
    [{ sql: 'SELECT 1', max_cell: 39 }, 'error 400: max_cell must be an integer 40-4000'],
    [{ sql: 'SELECT 1', max_cell: 4001 }, 'error 400: max_cell must be an integer 40-4000'],
    [{ sql: 42 }, 'error 400: sql must be a string'],
    [{ table: ['companies'] }, 'error 400: table must be a string'],
  ])('refuses %j before calling the domain', async (input, message) => {
    expect(await failure(tableRead, input)).toBe(message);
    expect(listAgentTables).not.toHaveBeenCalled();
    expect(describeAgentTable).not.toHaveBeenCalled();
    expect(queryAgentTables).not.toHaveBeenCalled();
  });
});

describe('table_read {table, ids}', () => {
  it('prints each entry with its 8-char rev and full values, then what was missing', async () => {
    readAgentEntries.mockResolvedValue({
      table: 'companies',
      tableId: 'table-1111111111111-aaaaaaaaa',
      entries: [
        { id: ENTRY_A, rev: '3f9e1c2a', values: { name: 'Row A', employees: '12', tags: ['x'] } },
      ],
      missing: [ENTRY_B],
    });
    expect(await output(tableRead, { table: 'companies', ids: [ENTRY_A, ENTRY_B] })).toBe(
      [
        `${ENTRY_A} (rev 3f9e1c2a) {"name":"Row A","employees":"12","tags":["x"]}`,
        `not found: ${ENTRY_B}`,
        '1 entry of companies',
        'link a row: [title](entry:table-1111111111111-aaaaaaaaa/<entry id>)',
      ].join('\n')
    );
    expect(readAgentEntries).toHaveBeenCalledWith('companies', [ENTRY_A, ENTRY_B]);
    expect(queryAgentTables).not.toHaveBeenCalled();
  });

  it('needs a table and an array', async () => {
    expect(await failure(tableRead, { ids: [ENTRY_A] })).toContain('ids needs table');
    expect(await failure(tableRead, { table: 'companies', ids: ENTRY_A })).toContain(
      'ids must be an array'
    );
    expect(readAgentEntries).not.toHaveBeenCalled();
  });

  it('points sql results that carry an id column at the rev read, and only those', async () => {
    queryAgentTables.mockResolvedValue({
      columns: ['id', 'name'],
      rows: [[ENTRY_A, 'Row A']],
      capped: false,
    });
    expect(
      (await output(tableRead, { sql: 'select id, name from companies' })).split('\n').at(-1)
    ).toBe('to edit with a rev guard, read these with table {op: "read", table, ids}');
    queryAgentTables.mockResolvedValue({ columns: ['name'], rows: [['Row A']], capped: false });
    expect(await output(tableRead, { sql: 'select name from companies' })).not.toContain(
      'rev guard'
    );
    queryAgentTables.mockResolvedValue({ columns: ['id'], rows: [], capped: false });
    expect(await output(tableRead, { sql: 'select id from companies where false' })).not.toContain(
      'rev guard'
    );
  });
});

describe('table_write', () => {
  it('sends one batch keyed by field name and reports each group with a rev prefix', async () => {
    writeAgentEntries.mockResolvedValue({
      tableId: 'table-1111111111111-aaaaaaaaa',
      inserted: [
        { id: ENTRY_A, rev: '3f9e1c2a0b1c2d3e' },
        { id: ENTRY_B, rev: '0a1b2c3d4e5f6071' },
      ],
      existing: [{ id: ENTRY_C, rev: 'abcdef1234567890' }],
      updated: [{ id: ENTRY_D, rev: '9f8e7d6c' }],
      unchanged: [ENTRY_A],
    });
    const result = await output(tableWrite, {
      table: 'companies',
      insert: [
        {
          id: ENTRY_A,
          values: { name: 'Row A', employees: 12, active: true, emails: [ENTRY_B] },
          before: ENTRY_C,
        },
        { values: { name: 'Row B', employees: '9007199254740993.01' } },
      ],
      update: [{ id: ENTRY_D, values: { website: null }, rev: '9f8e7d6c' }],
    });
    expect(result).toBe(
      [
        `inserted 2: ${ENTRY_A} (rev 3f9e1c2a), ${ENTRY_B} (rev 0a1b2c3d)`,
        `existing 1: ${ENTRY_C} (rev abcdef12)`,
        `updated 1: ${ENTRY_D} (rev 9f8e7d6c)`,
        `unchanged 1: ${ENTRY_A}`,
        'link a row: [title](entry:table-1111111111111-aaaaaaaaa/<entry id>)',
      ].join('\n')
    );
    expect(writeAgentEntries).toHaveBeenCalledWith('companies', {
      insert: [
        {
          id: ENTRY_A,
          values: { name: 'Row A', employees: '12', active: true, emails: [ENTRY_B] },
          before: ENTRY_C,
        },
        { values: { name: 'Row B', employees: '9007199254740993.01' } },
      ],
      update: [{ id: ENTRY_D, values: { website: null }, rev: '9f8e7d6c' }],
    });
  });

  it('sends only the groups the caller passed and reports a no-op batch', async () => {
    writeAgentEntries.mockResolvedValue({ inserted: [], existing: [], updated: [], unchanged: [] });
    expect(
      await output(tableWrite, { table: 'companies', update: [{ id: ENTRY_A, values: {} }] })
    ).toBe('no changes');
    expect(writeAgentEntries).toHaveBeenCalledWith('companies', {
      update: [{ id: ENTRY_A, values: {} }],
    });
  });

  it('keeps a field named __proto__ as data', async () => {
    writeAgentEntries.mockResolvedValue({ inserted: [], existing: [], updated: [], unchanged: [] });
    await output(tableWrite, {
      table: 'companies',
      insert: [{ values: JSON.parse('{"__proto__": "x"}') as Record<string, unknown> }],
    });
    const [, input] = writeAgentEntries.mock.calls[0] as [string, { insert: { values: object }[] }];
    expect(Object.keys(input.insert[0]!.values)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(input.insert[0]!.values)).toBe(Object.prototype);
  });

  it.each([
    [{ insert: [{ values: {} }] }, 'error 400: table must be a non-empty string'],
    [{ table: 'companies' }, 'error 400: pass at least one insert, update or repeat item'],
    [
      { table: 'companies', insert: [] },
      'error 400: pass at least one insert, update or repeat item',
    ],
    [{ table: 'companies', insert: 'row' }, 'error 400: insert must be an array'],
    [
      { table: 'companies', insert: [{ name: 'Row A' }] },
      'error 400: insert[0]: unknown key "name"; put field values inside values',
    ],
    [
      { table: 'companies', insert: [{ values: [] }] },
      'error 400: insert[0].values must be an object',
    ],
    [
      { table: 'companies', insert: [{ values: { name: { text: 'x' } } }] },
      'error 400: insert[0].values.name must be a string, boolean, null or array of entry ids or labels',
    ],
    [
      { table: 'companies', insert: [{ values: { employees: 2 ** 60 } }] },
      'error 400: insert[0].values.employees: pass this number as a decimal string',
    ],
    [
      { table: 'companies', update: [{ values: {} }] },
      'error 400: update[0].id must be a non-empty string',
    ],
    [
      { table: 'companies', update: [{ id: ENTRY_A, values: {}, revision: 'x' }] },
      'error 400: update[0]: unknown key "revision"; put field values inside values',
    ],
  ])('refuses %j before calling the domain', async (input, message) => {
    expect(await failure(tableWrite, input)).toBe(message);
    expect(writeAgentEntries).not.toHaveBeenCalled();
  });
});

describe('table_schema', () => {
  it('creates a table from fields and returns its describe block', async () => {
    applyAgentSchema.mockResolvedValue({ created: true, table: { ...companies, rows: 0 } });
    const result = await output(tableSchema, {
      table: 'companies',
      fields: [
        { name: 'website', type: 'text', description: 'Public homepage.', nullable: true },
        { name: 'employees', type: 'number', default: 10 },
        { name: 'emails', type: 'relation', ref: 'emails', multiple: true, default: [] },
      ],
    });
    expect(result).toBe(
      ['created companies (workspace-wide):', ...COMPANIES_FIELD_LINES].join('\n')
    );
    expect(applyAgentSchema).toHaveBeenCalledWith(
      'companies',
      {
        fields: [
          { name: 'website', type: 'text', description: 'Public homepage.', nullable: true },
          { name: 'employees', type: 'number', default: '10' },
          { name: 'emails', type: 'relation', ref: 'emails', multiple: true, default: [] },
        ],
      },
      NO_THREAD
    );
  });

  it('forwards range on new and updated fields, and refuses a non-boolean range', async () => {
    applyAgentSchema.mockResolvedValue({ created: false, table: companies });
    await output(tableSchema, {
      table: 'companies',
      ops: [
        { op: 'add_field', field: { name: 'stay', type: 'date', range: true } },
        { op: 'update_field', name: 'founded', set: { range: false } },
      ],
    });
    expect(applyAgentSchema).toHaveBeenLastCalledWith(
      'companies',
      {
        ops: [
          { op: 'add_field', field: { name: 'stay', type: 'date', range: true } },
          { op: 'update_field', name: 'founded', set: { range: false } },
        ],
      },
      NO_THREAD
    );
    expect(
      await failure(tableSchema, {
        table: 'companies',
        fields: [{ name: 'stay', type: 'date', range: 'yes' }],
      })
    ).toBe('error 400: fields[0].range must be true or false');
  });

  it('forwards repeats, calendar and clear_repeats on new and updated fields', async () => {
    applyAgentSchema.mockResolvedValue({ created: false, table: companies });
    const ops = [
      {
        op: 'add_field',
        field: { name: 'due', type: 'date', repeats: true, calendar: 'Home' },
      },
      { op: 'update_field', name: 'founded', set: { calendar: null } },
      { op: 'update_field', name: 'due', set: { repeats: false }, clear_repeats: true },
    ];
    await output(tableSchema, { table: 'companies', ops });
    expect(applyAgentSchema).toHaveBeenLastCalledWith('companies', { ops }, NO_THREAD);
  });

  it.each([
    [{ repeats: 'yes' }, 'error 400: ops[0].field.repeats must be true or false'],
    [{ calendar: '' }, 'error 400: ops[0].field.calendar must be a non-empty string'],
    [{ calendar: 7 }, 'error 400: ops[0].field.calendar must be a non-empty string'],
  ])('refuses a malformed date setting %j', async (settings, message) => {
    expect(
      await failure(tableSchema, {
        table: 'companies',
        ops: [{ op: 'add_field', field: { name: 'due', type: 'date', ...settings } }],
      })
    ).toBe(message);
    expect(applyAgentSchema).not.toHaveBeenCalled();
  });

  it('refuses week_start like any unknown key: repeats start weeks on Monday', async () => {
    expect(
      await failure(tableSchema, {
        table: 'companies',
        ops: [
          {
            op: 'add_field',
            field: { name: 'due', type: 'date', repeats: true, week_start: 'SU' },
          },
        ],
      })
    ).toBe(
      `error 400: ops[0].field: unknown key "week_start" (allowed: name, type, description, nullable, default, ref, multiple, range, options, before, repeats, calendar)`
    );
    expect(
      await failure(tableSchema, {
        table: 'companies',
        ops: [{ op: 'update_field', name: 'due', set: { week_start: 'MO' } }],
      })
    ).toBe(
      `error 400: ops[0].set: unknown key "week_start" (allowed: name, type, description, nullable, default, ref, multiple, range, options, before, repeats, calendar)`
    );
    expect(applyAgentSchema).not.toHaveBeenCalled();
  });

  it('refuses a non-boolean clear_repeats and clear_repeats on other ops', async () => {
    expect(
      await failure(tableSchema, {
        table: 'companies',
        ops: [{ op: 'update_field', name: 'due', set: { repeats: false }, clear_repeats: 'yes' }],
      })
    ).toBe('error 400: ops[0].clear_repeats must be true or false');
    expect(
      await failure(tableSchema, {
        table: 'companies',
        ops: [{ op: 'add_field', field: { name: 'due', type: 'date' }, clear_repeats: true }],
      })
    ).toBe('error 400: ops[0]: unknown key "clear_repeats" (allowed: op, field)');
    expect(applyAgentSchema).not.toHaveBeenCalled();
  });

  it('applies every op kind in one call and names the table as it is now', async () => {
    applyAgentSchema.mockResolvedValue({ created: false, table: { ...companies, name: 'firms' } });
    const result = await output(tableSchema, {
      table: 'companies',
      ops: [
        { op: 'add_field', field: { name: 'notes', type: 'text', before: 'website' } },
        { op: 'update_field', name: 'website', set: { name: 'homepage', description: null } },
        { op: 'reorder_fields', names: ['name', 'homepage'] },
        { op: 'rename_table', name: 'firms' },
      ],
    });
    expect(result.split('\n')[0]).toBe('altered firms (4 ops):');
    expect(applyAgentSchema).toHaveBeenCalledWith(
      'companies',
      {
        ops: [
          { op: 'add_field', field: { name: 'notes', type: 'text', before: 'website' } },
          { op: 'update_field', name: 'website', set: { name: 'homepage', description: null } },
          { op: 'reorder_fields', names: ['name', 'homepage'] },
          { op: 'rename_table', name: 'firms' },
        ],
      },
      NO_THREAD
    );
  });

  it('forwards the archive, delete, restore and title ops', async () => {
    applyAgentSchema.mockResolvedValue({ created: false, table: companies });
    const ops = [
      { op: 'archive_field', name: 'website' },
      { op: 'restore_field', name: 'notes', as: 'old_notes' },
      { op: 'delete_field', name: 'founded' },
      { op: 'set_title_field', name: 'website' },
    ];
    expect((await output(tableSchema, { table: 'companies', ops })).split('\n')[0]).toBe(
      'altered companies (4 ops):'
    );
    expect(applyAgentSchema).toHaveBeenLastCalledWith('companies', { ops }, NO_THREAD);

    applyAgentSchema.mockResolvedValue({
      created: false,
      table: { ...companies, state: 'deleted' },
    });
    const deleted = await output(tableSchema, {
      table: 'companies',
      ops: [{ op: 'delete_table', clear_links: true }],
    });
    expect(deleted.split('\n')[0]).toBe(
      'deleted companies; a person can undo it from the table history:'
    );
    expect(deleted).not.toContain('example:');
    expect(applyAgentSchema).toHaveBeenLastCalledWith(
      'companies',
      {
        ops: [{ op: 'delete_table', clear_links: true }],
      },
      NO_THREAD
    );

    applyAgentSchema.mockResolvedValue({
      created: false,
      table: { ...companies, state: 'archived' },
    });
    expect(
      (await output(tableSchema, { table: 'companies', ops: [{ op: 'archive_table' }] })).split(
        '\n'
      )[0]
    ).toBe('archived companies; restore_table brings it back:');
    expect(
      await failure(tableSchema, {
        table: 'companies',
        ops: [{ op: 'delete_table', clear_links: 'yes' }],
      })
    ).toBe('error 400: ops[0].clear_links must be true or false');
    expect(
      await failure(tableSchema, { table: 'companies', ops: [{ op: 'archive_table', name: 'x' }] })
    ).toBe('error 400: ops[0]: unknown key "name" (allowed: op)');
  });

  it('forwards set_project and names the new home, or the workspace, in the heading', async () => {
    applyAgentSchema.mockResolvedValue({
      created: false,
      table: { ...companies, project: LAUNCH },
    });
    const linked = await output(tableSchema, {
      table: 'companies',
      ops: [{ op: 'set_project', project_id: ` ${PROJECT_ID} ` }],
    });
    expect(linked.split('\n')[0]).toBe('companies is now in project Launch:');
    expect(applyAgentSchema).toHaveBeenLastCalledWith(
      'companies',
      {
        ops: [{ op: 'set_project', project_id: PROJECT_ID }],
      },
      NO_THREAD
    );

    applyAgentSchema.mockResolvedValue({ created: false, table: companies });
    const unlinked = await output(tableSchema, {
      table: 'companies',
      ops: [{ op: 'set_project', project_id: null }],
    });
    expect(unlinked.split('\n')[0]).toBe('companies is now workspace-wide:');
    expect(applyAgentSchema).toHaveBeenLastCalledWith(
      'companies',
      {
        ops: [{ op: 'set_project', project_id: null }],
      },
      NO_THREAD
    );

    // With other ops it is one of several; the heading counts them.
    applyAgentSchema.mockResolvedValue({
      created: false,
      table: { ...companies, project: LAUNCH },
    });
    const mixed = await output(tableSchema, {
      table: 'companies',
      ops: [
        { op: 'rename_table', name: 'firms' },
        { op: 'set_project', project_id: PROJECT_ID },
      ],
    });
    expect(mixed.split('\n')[0]).toBe('altered companies (2 ops):');

    expect(await failure(tableSchema, { table: 'companies', ops: [{ op: 'set_project' }] })).toBe(
      'error 400: ops[0].project_id must be a project id, or null for workspace-wide'
    );
    expect(
      await failure(tableSchema, {
        table: 'companies',
        ops: [{ op: 'set_project', project_id: 3 }],
      })
    ).toBe('error 400: ops[0].project_id must be a non-empty string');
    expect(
      await failure(tableSchema, {
        table: 'companies',
        ops: [{ op: 'set_project', project_id: null, name: 'x' }],
      })
    ).toBe('error 400: ops[0]: unknown key "name" (allowed: op, project_id)');
  });

  it('shows archived tables and fields on one quiet line', async () => {
    listAgentTables.mockResolvedValue([emails]);
    listArchivedAgentTables.mockResolvedValue(['old_leads', 'drafts']);
    expect((await output(tableRead, {})).split('\n')).toContain(
      'archived (restore_table): old_leads, drafts'
    );
    describeAgentTable.mockResolvedValue({ ...companies, archivedFields: ['fax'] });
    expect((await output(tableRead, { table: 'companies' })).split('\n')).toContain(
      'archived (restore_field): fax'
    );
  });

  it('forwards datetime fields and their ISO defaults', async () => {
    applyAgentSchema.mockResolvedValueOnce({ created: false, table: companies });
    await output(tableSchema, {
      table: 'companies',
      ops: [
        {
          op: 'add_field',
          field: { name: 'renewal_at', type: 'datetime', default: '2026-10-01T15:30' },
        },
        { op: 'update_field', name: 'founded', set: { type: 'datetime' } },
      ],
    });
    expect(applyAgentSchema).toHaveBeenLastCalledWith(
      'companies',
      {
        ops: [
          {
            op: 'add_field',
            field: { name: 'renewal_at', type: 'datetime', default: '2026-10-01T15:30' },
          },
          { op: 'update_field', name: 'founded', set: { type: 'datetime' } },
        ],
      },
      NO_THREAD
    );
  });

  it('uses the singular for one op', async () => {
    applyAgentSchema.mockResolvedValueOnce({ created: false, table: companies });
    expect(
      (
        await output(tableSchema, {
          table: 'companies',
          ops: [{ op: 'update_field', name: 'active', set: { default: true } }],
        })
      ).split('\n')[0]
    ).toBe('altered companies (1 op):');
  });

  it('forwards an empty fields list, which creates a table with only its title field', async () => {
    const created = { ...emails, name: 'notes', rows: 0, rowsCapped: false };
    applyAgentSchema.mockResolvedValueOnce({ created: true, table: created });
    expect((await output(tableSchema, { table: 'notes', fields: [] })).split('\n')[0]).toBe(
      'created notes (workspace-wide):'
    );
    expect(applyAgentSchema).toHaveBeenLastCalledWith('notes', { fields: [] }, NO_THREAD);
  });

  it('passes the calling thread to the create and names the project the table landed in', async () => {
    const created = { ...emails, name: 'notes', rows: 0, rowsCapped: false, project: LAUNCH };
    applyAgentSchema.mockResolvedValueOnce({ created: true, table: created });
    const result = toolOutputText(
      await invokeTool(tableSchema, { table: 'notes', fields: [] }, { threadId: THREAD_ID })
    );
    expect(result.split('\n')[0]).toBe(`created notes in project Launch (${PROJECT_ID}):`);
    expect(applyAgentSchema).toHaveBeenLastCalledWith(
      'notes',
      { fields: [] },
      { threadId: THREAD_ID }
    );

    // A set_project op in the same call travels with the create; the domain lets it win.
    applyAgentSchema.mockResolvedValueOnce({
      created: true,
      table: { ...created, project: undefined },
    });
    const flat = toolOutputText(
      await invokeTool(
        tableSchema,
        { table: 'notes', fields: [], ops: [{ op: 'set_project', project_id: null }] },
        { threadId: THREAD_ID }
      )
    );
    expect(flat.split('\n')[0]).toBe('created notes (workspace-wide):');
    expect(applyAgentSchema).toHaveBeenLastCalledWith(
      'notes',
      { fields: [], ops: [{ op: 'set_project', project_id: null }] },
      { threadId: THREAD_ID }
    );
  });

  it.each([
    [{ fields: [] }, 'error 400: table must be a non-empty string'],
    [{ table: 'companies' }, 'error 400: pass fields to create the table, or ops to change it'],
    [
      { table: 'companies', ops: [] },
      'error 400: pass fields to create the table, or ops to change it',
    ],
    [
      { table: 'companies', fields: [{ name: 'notes' }] },
      'error 400: fields[0].type must be one of text, number, date, datetime, checkbox, relation, select',
    ],
    [
      { table: 'companies', fields: [{ type: 'text' }] },
      'error 400: fields[0].name must be a non-empty string',
    ],
    [
      { table: 'companies', fields: [{ name: 'notes', type: 'text', required: true }] },
      `error 400: fields[0]: unknown key "required" (allowed: name, type, description, nullable, default, ref, multiple, range, options, before, repeats, calendar)`,
    ],
    [
      { table: 'companies', fields: [{ name: 'notes', type: 'text', default: {} }] },
      'error 400: fields[0].default must be a string, boolean, null or a list of option labels',
    ],
    [
      { table: 'companies', fields: [{ name: 'notes', type: 'text', description: 5 }] },
      'error 400: fields[0].description must be a string or null',
    ],
    [
      { table: 'companies', fields: [{ name: 'notes', type: 'text', nullable: 'yes' }] },
      'error 400: fields[0].nullable must be true or false',
    ],
    [
      { table: 'companies', ops: [{ op: 'drop_field', name: 'notes' }] },
      'error 400: ops[0].op must be one of add_field, update_field, reorder_fields, rename_table, archive_field, delete_field, restore_field, set_title_field, archive_table, delete_table, restore_table, set_project',
    ],
    [
      { table: 'companies', ops: [{ op: 'add_field', name: 'notes', type: 'text' }] },
      'error 400: ops[0]: unknown key "name" (allowed: op, field)',
    ],
    [
      { table: 'companies', ops: [{ op: 'update_field', name: 'notes', set: {} }] },
      'error 400: ops[0].set must change at least one prop',
    ],
    [
      { table: 'companies', ops: [{ op: 'reorder_fields', names: [] }] },
      'error 400: ops[0].names must be a non-empty array of strings',
    ],
    [
      { table: 'companies', ops: [{ op: 'rename_table' }] },
      'error 400: ops[0].name must be a non-empty string',
    ],
  ])('refuses %j before calling the domain', async (input, message) => {
    expect(await failure(tableSchema, input)).toBe(message);
    expect(applyAgentSchema).not.toHaveBeenCalled();
  });
});

describe('table_delete', () => {
  it('reports deleted, already gone and cleared links by name', async () => {
    deleteAgentEntries.mockResolvedValue({
      deletedIds: [ENTRY_A, ENTRY_B, ENTRY_C],
      alreadyDeleted: [ENTRY_D],
      clearedReferences: [
        {
          tableId: OTHER_TABLE_ID,
          fieldId: FIELD_ID,
          count: 2,
          tableName: 'emails',
          fieldName: 'company_id',
        },
      ],
    });
    expect(
      await output(tableDelete, {
        table: 'companies',
        ids: [ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D],
        clear_links: true,
      })
    ).toBe('deleted 3, already gone 1, links cleared: emails.company_id 2');
    expect(deleteAgentEntries).toHaveBeenCalledWith('companies', {
      ids: [ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D],
      clearLinks: true,
    });
  });

  it('defaults clear_links to false and falls back to ids for unnamed links', async () => {
    deleteAgentEntries.mockResolvedValueOnce({
      deletedIds: [ENTRY_A],
      alreadyDeleted: [],
      clearedReferences: [],
    });
    expect(await output(tableDelete, { table: 'companies', ids: [ENTRY_A] })).toBe('deleted 1');
    expect(deleteAgentEntries).toHaveBeenLastCalledWith('companies', {
      ids: [ENTRY_A],
      clearLinks: false,
    });

    deleteAgentEntries.mockResolvedValueOnce({
      deletedIds: [],
      alreadyDeleted: [ENTRY_A],
      clearedReferences: [{ tableId: OTHER_TABLE_ID, fieldId: FIELD_ID, count: 1 }],
    });
    expect(await output(tableDelete, { table: 'companies', ids: [ENTRY_A] })).toBe(
      `deleted 0, already gone 1, links cleared: ${OTHER_TABLE_ID}.${FIELD_ID} 1`
    );
  });

  it('turns a link conflict into one line that says how to proceed', async () => {
    const references = (counts: [string, string, number][]) =>
      counts.map(([tableName, fieldName, count]) => ({
        tableId: OTHER_TABLE_ID,
        tableName,
        fieldId: FIELD_ID,
        fieldName,
        count,
      }));
    deleteAgentEntries.mockRejectedValueOnce(
      new AppError('UI wording.', ErrorCode.CONFLICT, 409, true, {
        references: references([['emails', 'company_id', 2]]),
      })
    );
    expect(await failure(tableDelete, { table: 'companies', ids: [ENTRY_A] })).toBe(
      'error 409: 2 links point to the selected entries: emails.company_id (2). Repeat with clear_links:true to remove them.'
    );

    deleteAgentEntries.mockRejectedValueOnce(
      new AppError('UI wording.', ErrorCode.CONFLICT, 409, true, {
        references: references([['emails', 'company_id', 1]]),
      })
    );
    expect(await failure(tableDelete, { table: 'companies', ids: [ENTRY_A] })).toBe(
      'error 409: 1 link points to the selected entries: emails.company_id (1). Repeat with clear_links:true to remove them.'
    );

    deleteAgentEntries.mockRejectedValueOnce(
      new AppError('UI wording.', ErrorCode.CONFLICT, 409, true, {
        references: references([
          ['emails', 'company_id', 2],
          ['companies', 'parent', 1],
        ]),
      })
    );
    expect(await failure(tableDelete, { table: 'companies', ids: [ENTRY_A] })).toBe(
      'error 409: 3 links point to the selected entries: emails.company_id (2), companies.parent (1). Repeat with clear_links:true to remove them.'
    );
  });

  it.each([
    [{ ids: [ENTRY_A] }, 'error 400: table must be a non-empty string'],
    [{ table: 'companies' }, 'error 400: ids must be a non-empty array of strings'],
    [{ table: 'companies', ids: [] }, 'error 400: ids must be a non-empty array of strings'],
    [{ table: 'companies', ids: [ENTRY_A, ''] }, 'error 400: ids[1] must be a non-empty string'],
    [
      { table: 'companies', ids: [ENTRY_A], clear_links: 'yes' },
      'error 400: clear_links must be true or false',
    ],
  ])('refuses %j before calling the domain', async (input, message) => {
    expect(await failure(tableDelete, input)).toBe(message);
    expect(deleteAgentEntries).not.toHaveBeenCalled();
  });

  it('refuses more than 500 ids before calling the domain', async () => {
    const ids = Array.from({ length: 501 }, () => ENTRY_A);
    expect(await failure(tableDelete, { table: 'companies', ids })).toBe(
      'error 400: ids must list at most 500 entries'
    );
    expect(deleteAgentEntries).not.toHaveBeenCalled();
  });
});

describe('table tool errors', () => {
  it('renders a domain error as status and message only', async () => {
    describeAgentTable.mockRejectedValue(
      new AppError('Table "missing" not found.', ErrorCode.NOT_FOUND, 404)
    );
    expect(await failure(tableRead, { table: 'missing' })).toBe(
      'error 404: Table "missing" not found.'
    );
  });

  it('adds field-level validation details briefly', async () => {
    writeAgentEntries.mockRejectedValue(
      new AppError('Some values are invalid.', ErrorCode.VALIDATION_ERROR, 400, true, [
        { field: 'insert[0].founded', message: 'Use YYYY-MM-DD.' },
        { field: 'insert[1].employees', message: 'Use a decimal number.' },
        { field: '', message: 'Unknown field nme.' },
        { field: 'insert[3].name', message: 'Too long.' },
        { field: 'insert[4].name', message: 'Too long.' },
      ])
    );
    expect(await failure(tableWrite, { table: 'companies', insert: [{ values: {} }] })).toBe(
      'error 400: Some values are invalid. (insert[0].founded: Use YYYY-MM-DD.; insert[1].employees: Use a decimal number.; Unknown field nme.; +2 more)'
    );
  });

  it('names the conflicting entry and its current rev, never its values', async () => {
    writeAgentEntries.mockRejectedValue(
      new AppError('This entry changed since that revision.', ErrorCode.CONFLICT, 409, true, {
        entry: { id: ENTRY_A, createdAt: '2026-01-31T00:00:00Z', rev: '3f9e1c2a', values: {} },
      })
    );
    expect(
      await failure(tableWrite, {
        table: 'companies',
        update: [{ id: ENTRY_A, values: { name: 'Row A' }, rev: '0a1b2c3d' }],
      })
    ).toBe(
      `error 409: This entry changed since that revision. (entry ${ENTRY_A} is at rev 3f9e1c2a)`
    );
  });

  it('keeps scalar context and drops ids, revisions and nested objects', async () => {
    listAgentTables.mockRejectedValue(
      new AppError('The table is busy.', ErrorCode.CONFLICT, 409, true, {
        table: { id: TABLE_ID, name: 'companies' },
        schemaVersion: 'a'.repeat(64),
        revision: 'b'.repeat(64),
        fieldId: FIELD_ID,
        row: 2,
      })
    );
    expect(await failure(tableRead, {})).toBe('error 409: The table is busy. (row=2)');
  });

  it('drops the SQLSTATE from a query error and keeps a 503 readable', async () => {
    queryAgentTables.mockRejectedValueOnce(
      new AppError('column "nme" does not exist', ErrorCode.VALIDATION_ERROR, 400, true, {
        sqlState: '42703',
      })
    );
    expect(await failure(tableRead, { sql: 'SELECT nme FROM companies' })).toBe(
      'error 400: column "nme" does not exist'
    );
    queryAgentTables.mockRejectedValueOnce(
      new AppError('SQL mode is unavailable.', ErrorCode.SERVICE_UNAVAILABLE, 503)
    );
    expect(await failure(tableRead, { sql: 'SELECT 1' })).toBe(
      'error 503: SQL mode is unavailable.'
    );
  });

  it('flattens unexpected errors to one line without a stack', async () => {
    queryAgentTables.mockRejectedValue(new Error('column "nme" does not exist\n  HINT: check it'));
    expect(await failure(tableRead, { sql: 'SELECT nme FROM companies' })).toBe(
      'error 500: column "nme" does not exist HINT: check it'
    );
  });

  it('caps a very long message', async () => {
    listAgentTables.mockRejectedValue(new AppError('x'.repeat(1000), ErrorCode.CONFLICT, 409));
    const message = await failure(tableRead, {});
    expect(message).toBe(`error 409: ${'x'.repeat(399)}…`);
  });
});

describe('table_read structured rows', () => {
  const page = {
    table: 'companies',
    tableId: 'table-1111111111111-aaaaaaaaa',
    entries: [{ id: ENTRY_A, rev: '3f9e1c2a', values: { name: 'Row A' } }],
    page: 2,
    pageSize: 1,
    total: 3,
    hasMore: true,
    schemaVersion: 'v1',
  };

  it('forwards where, sort, columns, page and limit to the paged read and prints the position', async () => {
    listAgentEntries.mockResolvedValue(page);
    const where = [{ field: 'employees', operator: 'gte', value: '10' }];
    const sort = [{ field: 'name', direction: 'desc' }];
    expect(
      await output(tableRead, {
        table: 'companies',
        where,
        sort,
        columns: ['name'],
        page: 2,
        limit: 1,
      })
    ).toBe(
      [
        `${ENTRY_A} (rev 3f9e1c2a) {"name":"Row A"}`,
        'rows 2-2 of 3 in companies; more: page 3',
        'link a row: [title](entry:table-1111111111111-aaaaaaaaa/<entry id>)',
      ].join('\n')
    );
    expect(listAgentEntries).toHaveBeenCalledWith('companies', {
      where,
      sort,
      columns: ['name'],
      page: 2,
      limit: 1,
    });
    expect(readAgentEntries).not.toHaveBeenCalled();
    expect(queryAgentTables).not.toHaveBeenCalled();
  });

  it('says so when a page is empty', async () => {
    listAgentEntries.mockResolvedValue({ ...page, entries: [], page: 9, hasMore: false });
    expect(await output(tableRead, { table: 'companies', page: 9 })).toBe(
      'no rows on page 9 of companies (3 in all)'
    );
  });

  it.each([
    [{ where: [] }, 'error 400: where needs table'],
    [
      { table: 'companies', where: [], ids: [ENTRY_A] },
      'error 400: where cannot be combined with ids',
    ],
    [{ table: 'companies', sort: [], max_cell: 100 }, 'error 400: max_cell is for sql reads'],
    [{ table: 'companies', page: 0 }, null],
    [
      { table: 'companies', columns: ['name'], limit: 101 },
      'error 400: limit must be an integer 1-100',
    ],
  ])('refuses %j before calling the domain', async (input, message) => {
    const result = await failure(tableRead, input as Record<string, unknown>);
    if (message) expect(result).toBe(message);
    else expect(result).toBeTruthy();
    expect(listAgentEntries).not.toHaveBeenCalled();
  });

  it('leaves the existing reads untouched when no structured key is passed', async () => {
    describeAgentTable.mockResolvedValue(companies);
    await output(tableRead, { table: 'companies', limit: 5 });
    expect(describeAgentTable).toHaveBeenCalledWith('companies');
    expect(listAgentEntries).not.toHaveBeenCalled();
  });
});
