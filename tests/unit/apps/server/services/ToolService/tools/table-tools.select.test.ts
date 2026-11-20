import { getErrorMessage } from '@snaglet/shared/utils';
import type { AgentTableField, AgentTableSummary } from '@server/domains/tables/tableAgent';
import {
  invokeTool,
  toolOutputText,
  type ToolHandler,
} from '../../../../../../support/toolHarness';

const listAgentTables = jest.fn();
const describeAgentTable = jest.fn();
const applyAgentSchema = jest.fn();

jest.mock('@server/domains/tables/tableAgent', () => ({
  listAgentTables: (...args: unknown[]) => listAgentTables(...args),
  listArchivedAgentTables: async () => [],
  threadProject: async () => null,
  describeAgentTable: (...args: unknown[]) => describeAgentTable(...args),
  queryAgentTables: jest.fn(),
  writeAgentEntries: jest.fn(),
  applyAgentSchema: (...args: unknown[]) => applyAgentSchema(...args),
  deleteAgentEntries: jest.fn(),
}));

import tableRead from '@server/services/ToolService/handlers/tables/tableRead';
import tableSchema from '@server/services/ToolService/handlers/tables/tableSchema';

const TABLE_ID = 'table-1111111111111-aaaaaaaaa';

function field(over: Partial<AgentTableField> & Pick<AgentTableField, 'name' | 'type'>) {
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
    options: null,
    position: 0,
    managed: false,
    revision: 1,
    collapsed: false,
    isTitle: false,
    ...over,
  } satisfies AgentTableField;
}

function options(...labels: string[]) {
  return labels.map((label, index) => ({ id: `opt-${index}`, label, color: 'blue' as const }));
}

const tasks: AgentTableSummary = {
  id: TABLE_ID,
  name: 'tasks',
  rows: 2,
  rowsCapped: false,
  fields: [
    field({ name: 'name', type: 'text', isTitle: true, defaultValue: '' }),
    field({ name: 'id', type: 'uuid', managed: true }),
    field({
      name: 'status',
      type: 'select',
      nullable: true,
      defaultValue: 'todo',
      options: options('todo', 'doing', 'done'),
      description: 'Where the work is.',
    }),
    field({
      name: 'tags',
      type: 'select',
      multiple: true,
      defaultValue: [],
      options: options('a|b', 'x', 'y', 'z', 'w', 'v', 'u', 't', 's', 'r'),
    }),
    field({ name: 'stage', type: 'select', nullable: true, options: [] }),
  ],
};

async function output(tool: ToolHandler, input: unknown): Promise<string> {
  return toolOutputText(await invokeTool(tool, input));
}

async function failure(tool: ToolHandler, input: unknown): Promise<string> {
  try {
    await invokeTool(tool, input);
  } catch (err) {
    return getErrorMessage(err);
  }
  throw new Error('expected the tool call to fail');
}

beforeEach(() => jest.resetAllMocks());

describe('select fields in table_read', () => {
  it('shows every option in a table block, quoting labels that hold a delimiter', async () => {
    describeAgentTable.mockResolvedValue(tasks);
    expect((await output(tableRead, { table: 'tasks' })).split('\n')).toEqual([
      'tasks (2 rows)',
      'name* text',
      'status select(todo|doing|done)? = "todo" — Where the work is.',
      'tags select[]("a|b"|x|y|z|w|v|u|t|s|r)',
      'stage select()?',
      'system: id uuid, created_at, position (row order)',
      `link an entry: [title](entry:${TABLE_ID}/<entry id>)`,
      'example: table {"op":"write","table":"tasks","insert":[{"values":{"name":"text","status":"todo","tags":["a|b"]}}]}',
    ]);
  });

  it('caps the options a table list shows per field', async () => {
    listAgentTables.mockResolvedValue([tasks]);
    expect((await output(tableRead, {})).split('\n')[0]).toBe(
      'tasks (2): name* text, status select(todo|doing|done)?, tags select[]("a|b"|x|y|z|w|v|u|t|…+2), stage select()?'
    );
  });
});

describe('select fields in table_schema', () => {
  it('forwards labels, colored labels and {from,to} renames', async () => {
    applyAgentSchema.mockResolvedValue({ created: false, table: tasks });
    await output(tableSchema, {
      table: 'tasks',
      fields: [
        {
          name: 'status',
          type: 'select',
          options: [' todo ', { label: 'done', color: 'green' }],
          default: 'todo',
        },
        { name: 'tags', type: 'select', multiple: true, default: ['x', 'y'] },
      ],
      ops: [
        {
          op: 'update_field',
          name: 'status',
          set: {
            options: [
              { from: 'todo', to: 'backlog' },
              { from: 'done', to: 'shipped', color: 'gray' },
            ],
          },
        },
      ],
    });
    expect(applyAgentSchema).toHaveBeenCalledWith(
      'tasks',
      {
        fields: [
          {
            name: 'status',
            type: 'select',
            options: ['todo', { label: 'done', color: 'green' }],
            default: 'todo',
          },
          { name: 'tags', type: 'select', multiple: true, default: ['x', 'y'] },
        ],
        ops: [
          {
            op: 'update_field',
            name: 'status',
            set: {
              options: [
                { from: 'todo', to: 'backlog' },
                { from: 'done', to: 'shipped', color: 'gray' },
              ],
            },
          },
        ],
      },
      { threadId: undefined }
    );
  });

  it.each([
    [
      { name: 'status', type: 'select', options: 'todo,done' },
      'error 400: fields[0].options must be an array',
    ],
    [
      { name: 'status', type: 'select', options: [3] },
      'error 400: fields[0].options[0] must be an object',
    ],
    [
      { name: 'status', type: 'select', options: [{ label: 'a', colour: 'red' }] },
      'error 400: fields[0].options[0]: unknown key "colour": an option is a label, {label, color} or {from, to} to rename',
    ],
    [
      { name: 'status', type: 'select', options: [{ from: 'a' }] },
      'error 400: fields[0].options[0].to must be a non-empty string',
    ],
    [
      { name: 'status', type: 'select', options: [{ label: 'a', color: 'teal' }] },
      'error 400: fields[0].options[0].color must be one of blue, green, yellow, orange, red, purple, pink, brown, gray',
    ],
    [
      { name: 'status', type: 'select', options: [''] },
      'error 400: fields[0].options[0] must be a non-empty string',
    ],
    [
      { name: 'tags', type: 'select', multiple: true, default: ['a', 1] },
      'error 400: fields[0].default must be a string, boolean, null or a list of option labels',
    ],
  ])('refuses %j before calling the domain', async (input, message) => {
    expect(await failure(tableSchema, { table: 'tasks', fields: [input] })).toBe(message);
    expect(applyAgentSchema).not.toHaveBeenCalled();
  });
});
