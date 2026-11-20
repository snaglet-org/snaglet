import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { EDITABLE_TABLE_FIELD_TYPES, TABLE_ENTRY_DELETE_MAX } from '@snaglet/shared/types';
import {
  AGENT_LIST_LIMIT,
  READ_MAX_IDS,
  SQL_LIMIT,
  SQL_MAX_CELL,
  tableParam,
} from '../../database/_shared/schemas';

/**
 * table(op) — table operations: read, fields, query, write, schema and delete.
 *
 * Schema is flat (like `node` and `doc`): each property says which op reads
 * it. Each old id is an op-pinned alias in toolAliases.ts, so an access rule
 * naming one old id covers exactly its op (allow: table_read never grants
 * write). Only delete is confirm-gated; `schema` is marked
 * non-destructive, although its delete_field / delete_table ops
 * remove data a person can undo. Like delete_table's `clear_links`, turning
 * a field's repeats off while rows repeat needs `clear_repeats`: the editor
 * warns before its save removes every row's repeat.
 *
 * The schema op's `ops[]` items list only `{op}`; their shapes are in the
 * `ops` description (SCHEMA_OPS_DOC). A drift test checks every op the handler
 * accepts appears there with each of its keys. Row writes (insert/update) keep
 * their full item schemas.
 */
export const SCHEMA_OPS_DOC =
  'add_field {field}, update_field {name, set, clear_repeats} (set.name renames), reorder_fields {names} (all fields), rename_table {name}, archive_field|delete_field|set_title_field {name}, restore_field {name, as}, archive_table, delete_table {clear_links}, restore_table {as}, set_project {project_id} (null: workspace-wide); as: a new name if the old one is taken';

const field = {
  type: 'object',
  required: ['name', 'type'],
  properties: {
    name: { type: 'string' },
    type: { enum: [...EDITABLE_TABLE_FIELD_TYPES] },
    description: { type: 'string' },
    nullable: { type: 'boolean' },
    default: {},
    ref: {
      type: 'string',
      description: 'table, or snaglet:doc|project|container|thread|image|post|agent',
    },
    multiple: { type: 'boolean', description: 'list (relation/select)' },
    range: { type: 'boolean', description: 'date/datetime with an end: start/end' },
    options: {
      type: 'array',
      description: 'select labels; in set, the full list: {from,to} renames, unlisted are removed',
    },
    before: { type: 'string', description: 'field to place it before' },
    repeats: { type: 'boolean', description: 'date/datetime: rows can repeat (↻)' },
    calendar: { type: ['string', 'null'], description: 'date/datetime: calendar name or id' },
  },
};

const definition: BuiltinToolDefinition = {
  id: 'table',
  name: 'Table',
  description:
    'Tables. read: no args lists; {table} describes; {table, ids} rows+rev. ' +
    'fields: metadata; query: SELECT SQL. ' +
    'op write: atomic insert and/or update. ' +
    'op schema (all or nothing; one text title field (*); a person can undo): create ' +
    `{fields:[{name, type: ${EDITABLE_TABLE_FIELD_TYPES.join('|')}, options?, ref?, multiple?, range?}]} ` +
    'or alter {ops:[{op:"add_field", field}, {op:"update_field", name, set:{field props}}, {op:"rename_table", name}, …]}. ' +
    'op delete: entries by id; atomic, retry-safe. ' +
    'The full fields and ops shapes, write\'s repeat, max_cell and clear_links are not listed: tool({op:"schema", name:"table"}) returns them as unlisted_parameters.',
  type: 'builtin',
  tier: 'core',
  contextRequirement: 'none',
  destructive: false,
  destructiveOps: ['delete'],
  aliases: ['table_read', 'table_write', 'table_schema', 'table_delete'],
  keywords: [
    'table',
    'database',
    'rows',
    'records',
    'entries',
    'spreadsheet',
    'list tables',
    'describe table',
    'query',
    'sql',
    'insert',
    'update row',
    'create table',
    'schema',
    'field',
    'column',
    'delete row',
  ],
  parameters_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['op'],
    properties: {
      op: { type: 'string', enum: ['read', 'fields', 'query', 'write', 'schema', 'delete'] },
      table: { ...tableParam, description: 'name or id; required except read with no args or sql' },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: `read: <=${READ_MAX_IDS} ids, rows+rev; delete: <=${TABLE_ENTRY_DELETE_MAX} entry ids`,
      },
      sql: { type: 'string', description: 'query: required read-only SELECT on user_tables; TSV' },
      where: {
        type: 'array',
        description:
          'read rows: [{field, operator, value}] ANDed; e.g. is, contains, gt, before, is_empty',
        items: { type: 'object' },
      },
      sort: {
        type: 'array',
        description: 'read rows: [{field, direction}]',
        items: { type: 'object' },
      },
      columns: { type: 'array', description: 'read rows: field names', items: { type: 'string' } },
      page: {
        type: 'integer',
        description: `read rows: 1-based; limit ${AGENT_LIST_LIMIT.default}, max ${AGENT_LIST_LIMIT.max}`,
      },
      limit: {
        type: 'integer',
        description: `read sql rows ${SQL_LIMIT.min}-${SQL_LIMIT.max}, default ${SQL_LIMIT.default}`,
      },
      insert: {
        type: 'array',
        description:
          'write: values {field: value}; number as decimal string, date YYYY-MM-DD, datetime ISO 8601 (no offset: user zone), range start/end (2026-01-31/2026-02-02 is three days: date ranges include their end; a datetime range ends at its end instant), relation entry/Snaglet item id, select label (arrays if multiple), null clears. id: optional uuid (retry-safe). before: entry id to insert above',
        items: {
          type: 'object',
          required: ['values'],
          properties: {
            id: { type: 'string' },
            values: { type: 'object' },
            before: { type: 'string' },
          },
        },
      },
      update: {
        type: 'array',
        description: 'write: sparse patches; rev must match: from a write or read ids, not sql',
        items: {
          type: 'object',
          required: ['id', 'values'],
          properties: {
            id: { type: 'string' },
            values: { type: 'object' },
            rev: { type: 'string' },
          },
        },
      },
    },
  },
  // The schema op's fields and ops, repeat steps, sql max_cell and delete's
  // clear_links: accepted (handlers validate their own input; nothing checks
  // it against parameters_schema) but not advertised, to save tokens on every
  // turn. The description carries compact create/add_field/update_field
  // shapes so a first schema call succeeds, and an unknown key names the
  // allowed ones. tool(op:schema) returns them as `unlisted_parameters`;
  // TOOL.md lists them.
  unlisted_params: {
    max_cell: {
      type: 'integer',
      description: `read sql chars per cell ${SQL_MAX_CELL.min}-${SQL_MAX_CELL.max}, default ${SQL_MAX_CELL.default}`,
    },
    repeat: {
      type: 'array',
      description:
        'write: ↻ fields, after rows, a step each: {id, field, set|done|skip}; see table read',
      items: { type: 'object' },
    },
    fields: {
      type: 'array',
      description:
        "schema: creates the table (may be []) in the calling thread's project, else workspace-wide (a set_project op overrides); it also gets a title field called name",
      items: field,
    },
    ops: {
      type: 'array',
      description: `schema: ${SCHEMA_OPS_DOC}`,
      items: { type: 'object', required: ['op'] },
    },
    clear_links: {
      type: 'boolean',
      description: 'delete: required when other entries link to them; removes those links',
    },
  },
};

export default definition;
