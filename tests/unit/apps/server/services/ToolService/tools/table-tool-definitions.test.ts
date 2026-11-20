import { ACCESS_GATED_CORE_TOOL_IDS, CORE_TOOL_IDS } from '@snaglet/shared/constants';
import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { listToolFolders } from '@server/services/ToolService/scripts/lib/tool-metadata';
import { normalizeAnthropicInputSchema } from '@server/services/ToolService/ToolFormatService';
import table, { SCHEMA_OPS_DOC } from '@server/services/ToolService/tools/tables/table/definition';
import { SCHEMA_OP_KEYS } from '@server/services/ToolService/handlers/tables/tableSchema';
import {
  SQL_LIMIT,
  SQL_MAX_CELL,
  AGENT_LIST_LIMIT,
} from '@server/services/ToolService/tools/database/_shared/schemas';
import {
  TABLE_QUERY_DEFAULT_LIMIT,
  TABLE_QUERY_DEFAULT_MAX_CELL,
  TABLE_QUERY_MAX_LIMIT,
  TABLE_QUERY_MAX_MAX_CELL,
  TABLE_QUERY_MIN_MAX_CELL,
} from '@snaglet/db/tables/table_query';

/**
 * UTF-8 bytes of the Anthropic `tools` entry. `table` is core, so every byte
 * is paid on every turn; the ceiling sits a few bytes over the measured size
 * so growth is a deliberate edit.
 */
const WIRE_BYTE_CEILINGS: Record<string, number> = {
  table: 2_540, // measured 2,519 — full fields/ops shapes, repeat, max_cell, clear_links are unlisted
};
/**
 * One tool covers four ops, so its description gets a wider cap than a
 * single-op tool; it also carries the compact schema-op shapes (their full
 * item schemas are unlisted) and names the unlisted fields and where to get them.
 */
const DESCRIPTION_CHAR_CEILING = 680;

function wireBytes(definition: BuiltinToolDefinition): number {
  return Buffer.byteLength(
    JSON.stringify({
      type: 'custom',
      name: definition.id,
      description: definition.description,
      input_schema: normalizeAnthropicInputSchema(definition.parameters_schema),
    }),
    'utf8'
  );
}

function combinatorPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => combinatorPaths(item, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(['oneOf', 'anyOf', 'allOf'].includes(key) ? [`${path}.${key}`] : []),
    ...combinatorPaths(child, `${path}.${key}`),
  ]);
}

type Props = Record<string, { description?: string; items?: Record<string, unknown> }>;
const listed = table.parameters_schema.properties as Props;
/** Advertised plus unlisted: the whole input contract the handlers accept. */
const properties: Props = { ...listed, ...(table.unlisted_params as Props) };
const UNLISTED = ['fields', 'ops', 'repeat', 'max_cell', 'clear_links'];

describe('table(op) definition', () => {
  it('registers exactly one table tool in its own tables category', () => {
    const tableFolders = listToolFolders().filter(
      (entry) => entry.toolId === 'table' || entry.toolId.startsWith('table_')
    );
    expect(tableFolders.map((entry) => entry.toolId)).toEqual(['table']);
    expect(tableFolders[0]).toMatchObject({
      categoryPath: 'tables',
      relativePath: 'tables/table',
    });
  });

  it('is a first-class core tool', () => {
    expect(CORE_TOOL_IDS.has('table')).toBe(true);
    for (const old of ['table_read', 'table_write', 'table_schema', 'table_delete']) {
      expect(CORE_TOOL_IDS.has(old)).toBe(false);
    }
    expect(ACCESS_GATED_CORE_TOOL_IDS.has('table')).toBe(false);
    expect(table.tier).toBe('core');
    expect(table.contextRequirement).toBe('none');
    expect(table.keywords).toEqual(expect.arrayContaining(['table', 'database']));
  });

  it('confirms only op delete; schema stays non-destructive', () => {
    expect(table.destructive).toBe(false);
    expect(table.destructiveOps).toEqual(['delete']);
  });

  it('has a closed schema with no combinators', () => {
    const schema = table.parameters_schema;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['op']);
    expect(combinatorPaths(schema)).toEqual([]);
    // Nothing is stripped on the way to Anthropic, so every provider sees the same shape.
    expect(normalizeAnthropicInputSchema(schema)).toEqual(schema);
  });

  it('leaves the rarer fields out of the wire schema and keeps them in unlisted_params', () => {
    expect(Object.keys(table.unlisted_params ?? {}).sort()).toEqual([...UNLISTED].sort());
    for (const field of UNLISTED) expect(listed).not.toHaveProperty(field);
    expect(table.description).toContain('tool({op:"schema", name:"table"})');
    expect(table.description).toContain('unlisted_parameters');
  });

  it('stays under its per-turn byte ceiling', () => {
    expect(wireBytes(table)).toBeLessThanOrEqual(WIRE_BYTE_CEILINGS.table!);
    expect(table.description.length).toBeLessThanOrEqual(DESCRIPTION_CHAR_CEILING);
  });

  it('keeps row writes fully typed (only schema ops[] items are slimmed)', () => {
    expect(properties.insert?.items).toEqual({
      type: 'object',
      required: ['values'],
      properties: {
        id: { type: 'string' },
        values: { type: 'object' },
        before: { type: 'string' },
      },
    });
    expect(properties.update?.items).toEqual({
      type: 'object',
      required: ['id', 'values'],
      properties: {
        id: { type: 'string' },
        values: { type: 'object' },
        rev: { type: 'string' },
      },
    });
    const fieldItem = properties.fields?.items as { properties: Record<string, unknown> };
    expect(Object.keys(fieldItem.properties).sort()).toEqual(
      [
        'before',
        'default',
        'description',
        'multiple',
        'name',
        'nullable',
        'options',
        'range',
        'ref',
        'type',
        'repeats',
        'calendar',
      ].sort()
    );
    // Only the schema op's ops[] items are slimmed to {op}.
    expect(properties.ops?.items).toEqual({ type: 'object', required: ['op'] });
  });

  it('says how a range is written and how its end counts', () => {
    const fieldItem = properties.fields?.items as {
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(fieldItem.properties.range).toEqual({
      type: 'boolean',
      description: 'date/datetime with an end: start/end',
    });
    expect(properties.insert?.description).toContain(
      'range start/end (2026-01-31/2026-02-02 is three days: date ranges include their end; a datetime range ends at its end instant)'
    );
  });

  it('takes a date field’s repeats and calendar (nullable, no combinator), no week start', () => {
    const fieldItem = properties.fields?.items as {
      properties: Record<string, { type?: unknown; enum?: unknown }>;
    };
    expect(fieldItem.properties.repeats?.type).toBe('boolean');
    expect(fieldItem.properties).not.toHaveProperty('week_start');
    expect(fieldItem.properties.calendar?.type).toEqual(['string', 'null']);
    expect(SCHEMA_OPS_DOC).toContain('update_field {name, set, clear_repeats}');
  });

  // Drift guard: ops[] items list only {op} in the schema, so the prose is
  // the contract. Every op the handler accepts must be named, with each key.
  it.each(Object.entries(SCHEMA_OP_KEYS))(
    'documents schema op %s and each of its keys',
    (op, keys) => {
      const doc = properties.ops?.description ?? '';
      expect(doc).toBe(`schema: ${SCHEMA_OPS_DOC}`);
      expect(doc).toMatch(new RegExp(`\\b${op}\\b`));
      for (const key of keys.filter((k) => k !== 'op')) {
        expect(doc).toMatch(new RegExp(`\\b${key}\\b`));
      }
    }
  );

  it('advertises the structured row-read keys and the agent page bounds', () => {
    for (const key of ['where', 'sort', 'columns', 'page']) {
      expect(properties[key]?.description).toMatch(/^read rows/);
    }
    expect(properties.page?.description).toBe('read rows: 1-based; limit 25, max 100');
    expect(AGENT_LIST_LIMIT).toEqual({ max: 100, default: 25 });
  });

  it('advertises the same bounds the handler and TableQuery enforce', () => {
    expect(SQL_LIMIT).toEqual({
      min: 1,
      max: TABLE_QUERY_MAX_LIMIT,
      default: TABLE_QUERY_DEFAULT_LIMIT,
    });
    expect(SQL_MAX_CELL).toEqual({
      min: TABLE_QUERY_MIN_MAX_CELL,
      max: TABLE_QUERY_MAX_MAX_CELL,
      default: TABLE_QUERY_DEFAULT_MAX_CELL,
    });
    expect(properties.limit?.description).toBe('read sql rows 1-200, default 50');
    expect(properties.max_cell?.description).toBe('read sql chars per cell 40-4000, default 200');
  });
});
