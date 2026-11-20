import type { ToolHandler } from '@server/services/ToolService/types';
import tableRead from '@server/services/ToolService/handlers/tables/tableRead';
import tableWrite from '@server/services/ToolService/handlers/tables/tableWrite';
import tableSchema from '@server/services/ToolService/handlers/tables/tableSchema';
import tableDelete from '@server/services/ToolService/handlers/tables/tableDelete';
import tableFields from '@server/services/ToolService/handlers/tables/tableFields';
import tableQuery from '@server/services/ToolService/handlers/tables/tableQuery';

type Input = Record<string, unknown>;

/**
 * The fields each op reads. A field that belongs only to other ops is refused
 * before any handler runs, so a call can never half-mean another op (e.g.
 * `insert` on a delete, `ops` on a write). `table` and `ids` are shared.
 * Unknown fields pass through to the handler (read ignores the `origin` the
 * `table_list` alias id may send).
 */
export const TABLE_OP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  read: ['table', 'ids', 'sql', 'limit', 'max_cell', 'where', 'sort', 'columns', 'page'],
  write: ['table', 'insert', 'update', 'repeat'],
  schema: ['table', 'fields', 'ops'],
  delete: ['table', 'ids', 'clear_links'],
  fields: ['table'],
  query: ['sql', 'limit', 'max_cell'],
};

function refuseForeignFields(op: string, input: Input): void {
  const own = new Set(TABLE_OP_FIELDS[op]);
  for (const [otherOp, fields] of Object.entries(TABLE_OP_FIELDS)) {
    if (otherOp === op) continue;
    for (const field of fields) {
      if (!own.has(field) && input[field] !== undefined) {
        throw new Error(
          `table ${op}: \`${field}\` belongs to op ${otherOp}, not ${op}. Nothing was changed.`
        );
      }
    }
  }
}

/** Each op hands its handler the input without `op`. */
const strip = (input: Input): Input => {
  const { op: _op, ...rest } = input;
  return rest;
};

const OPS: Record<string, ToolHandler> = {
  read: (input, settings, context) => tableRead(strip(input), settings, context),
  write: (input, settings, context) => tableWrite(strip(input), settings, context),
  schema: (input, settings, context) => tableSchema(strip(input), settings, context),
  delete: (input, settings, context) => tableDelete(strip(input), settings, context),
  fields: (input, settings, context) => tableFields(strip(input), settings, context),
  query: (input, settings, context) => tableQuery(strip(input), settings, context),
};

/**
 * table(op): one core noun tool over the custom-table handlers: read, write,
 * schema, delete, fields and query (the old ids table_read, table_write,
 * table_schema and table_delete map to their ops).
 */
const tool: ToolHandler = async (input, settings, context) => {
  const op = typeof input.op === 'string' ? input.op : undefined;
  const handler = op ? OPS[op] : undefined;
  if (!op || !handler) {
    throw new Error(`op is required and must be one of ${Object.keys(OPS).join(' | ')}.`);
  }
  refuseForeignFields(op, input);
  return handler(input, settings, context);
};

export default tool;
