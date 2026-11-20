import type { ToolHandler } from '@server/services/ToolService/types';
import {
  EDITABLE_TABLE_FIELD_TYPES,
  TABLE_SELECT_OPTION_COLORS,
  type EditableTableFieldType,
  type TableFieldDefault,
  type TableSelectOptionColor,
} from '@snaglet/shared/types';
import {
  applyAgentSchema,
  type AgentFieldInput,
  type AgentOptionInput,
  type AgentSchemaOp,
  type AgentTableSummary,
} from '@server/domains/tables/tableAgent';
import { runTableTool } from '@server/services/ToolService/tools/database/_shared/errors';
import {
  badInput,
  numberAsDecimal,
  objectAt,
  onlyKeys,
  optionalArray,
  optionalBoolean,
  optionalString,
  requiredString,
  stringArray,
} from '@server/services/ToolService/tools/database/_shared/input';
import { renderTableDetail } from '@server/services/ToolService/tools/database/_shared/render';

const FIELD_KEYS = [
  'name',
  'type',
  'description',
  'nullable',
  'default',
  'ref',
  'multiple',
  'range',
  'options',
  'before',
  'repeats',
  'calendar',
] as const;

function fieldType(value: unknown, path: string): EditableTableFieldType {
  const type = EDITABLE_TABLE_FIELD_TYPES.find((candidate) => candidate === value);
  if (!type) throw badInput(`${path} must be one of ${EDITABLE_TABLE_FIELD_TYPES.join(', ')}`);
  return type;
}

function fieldDefault(value: unknown, path: string): TableFieldDefault {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return numberAsDecimal(value, path);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value as string[];
  throw badInput(`${path} must be a string, boolean, null or a list of option labels`);
}

function optionColor(value: unknown, path: string): TableSelectOptionColor | undefined {
  if (value === undefined) return undefined;
  const color = TABLE_SELECT_OPTION_COLORS.find((candidate) => candidate === value);
  if (!color) throw badInput(`${path} must be one of ${TABLE_SELECT_OPTION_COLORS.join(', ')}`);
  return color;
}

/** A label, `{label, color?}`, or `{from, to, color?}` (a rename). */
function fieldOption(value: unknown, path: string): AgentOptionInput {
  if (typeof value === 'string') return requiredString(value, path);
  const option = objectAt(value, path);
  const hint = ': an option is a label, {label, color} or {from, to} to rename';
  const color = optionColor(option.color, `${path}.color`);
  if (option.from !== undefined || option.to !== undefined) {
    onlyKeys(option, ['from', 'to', 'color'], path, hint);
    return {
      from: requiredString(option.from, `${path}.from`),
      to: requiredString(option.to, `${path}.to`),
      ...(color ? { color } : {}),
    };
  }
  onlyKeys(option, ['label', 'color'], path, hint);
  return { label: requiredString(option.label, `${path}.label`), ...(color ? { color } : {}) };
}

/** A calendar name or id; null takes the field off its calendar. */
function fieldCalendar(value: unknown, path: string): string | null {
  return value === null ? null : requiredString(value, path);
}

function fieldDescription(value: unknown, path: string): string | null {
  if (value === null || typeof value === 'string') return value;
  throw badInput(`${path} must be a string or null`);
}

/** Only keys the caller sent are forwarded, so `set` stays a sparse patch. */
function fieldProps(raw: unknown, path: string): Partial<AgentFieldInput> {
  const input = objectAt(raw, path);
  onlyKeys(input, FIELD_KEYS, path);
  const out: Partial<AgentFieldInput> = {};
  if (input.name !== undefined) out.name = requiredString(input.name, `${path}.name`);
  if (input.type !== undefined) out.type = fieldType(input.type, `${path}.type`);
  if (input.description !== undefined) {
    out.description = fieldDescription(input.description, `${path}.description`);
  }
  const nullable = optionalBoolean(input.nullable, `${path}.nullable`);
  if (nullable !== undefined) out.nullable = nullable;
  if (input.default !== undefined) out.default = fieldDefault(input.default, `${path}.default`);
  const ref = optionalString(input.ref, `${path}.ref`);
  if (ref !== undefined) out.ref = ref;
  const multiple = optionalBoolean(input.multiple, `${path}.multiple`);
  if (multiple !== undefined) out.multiple = multiple;
  const range = optionalBoolean(input.range, `${path}.range`);
  if (range !== undefined) out.range = range;
  const options = optionalArray(input.options, `${path}.options`);
  if (options !== undefined)
    out.options = options.map((option, index) => fieldOption(option, `${path}.options[${index}]`));
  const before = optionalString(input.before, `${path}.before`);
  if (before !== undefined) out.before = before;
  const repeats = optionalBoolean(input.repeats, `${path}.repeats`);
  if (repeats !== undefined) out.repeats = repeats;
  if (input.calendar !== undefined)
    out.calendar = fieldCalendar(input.calendar, `${path}.calendar`);
  return out;
}

function newField(raw: unknown, path: string): AgentFieldInput {
  const props = fieldProps(raw, path);
  return {
    ...props,
    name: requiredString(props.name, `${path}.name`),
    type: fieldType(props.type, `${path}.type`),
  };
}

function schemaOp(raw: unknown, index: number): AgentSchemaOp {
  const path = `ops[${index}]`;
  const op = objectAt(raw, path);
  switch (op.op) {
    case 'add_field':
      onlyKeys(op, SCHEMA_OP_KEYS.add_field, path);
      return { op: 'add_field', field: newField(op.field, `${path}.field`) };
    case 'update_field': {
      onlyKeys(op, SCHEMA_OP_KEYS.update_field, path);
      const set = fieldProps(op.set, `${path}.set`);
      if (!Object.keys(set).length) throw badInput(`${path}.set must change at least one prop`);
      const clearRepeats = optionalBoolean(op.clear_repeats, `${path}.clear_repeats`);
      return {
        op: 'update_field',
        name: requiredString(op.name, `${path}.name`),
        set,
        ...(clearRepeats !== undefined ? { clear_repeats: clearRepeats } : {}),
      };
    }
    case 'reorder_fields':
      onlyKeys(op, SCHEMA_OP_KEYS.reorder_fields, path);
      return { op: 'reorder_fields', names: stringArray(op.names, `${path}.names`) };
    case 'rename_table':
      onlyKeys(op, SCHEMA_OP_KEYS.rename_table, path);
      return { op: 'rename_table', name: requiredString(op.name, `${path}.name`) };
    case 'archive_field':
    case 'delete_field':
    case 'set_title_field':
      onlyKeys(op, SCHEMA_OP_KEYS[op.op], path);
      return { op: op.op, name: requiredString(op.name, `${path}.name`) };
    case 'restore_field': {
      onlyKeys(op, SCHEMA_OP_KEYS.restore_field, path);
      const as = optionalString(op.as, `${path}.as`);
      return {
        op: 'restore_field',
        name: requiredString(op.name, `${path}.name`),
        ...(as ? { as } : {}),
      };
    }
    case 'archive_table':
      onlyKeys(op, SCHEMA_OP_KEYS.archive_table, path);
      return { op: 'archive_table' };
    case 'delete_table': {
      onlyKeys(op, SCHEMA_OP_KEYS.delete_table, path);
      const clearLinks = optionalBoolean(op.clear_links, `${path}.clear_links`);
      return {
        op: 'delete_table',
        ...(clearLinks !== undefined ? { clear_links: clearLinks } : {}),
      };
    }
    case 'restore_table': {
      onlyKeys(op, SCHEMA_OP_KEYS.restore_table, path);
      const as = optionalString(op.as, `${path}.as`);
      return { op: 'restore_table', ...(as ? { as } : {}) };
    }
    case 'set_project': {
      onlyKeys(op, SCHEMA_OP_KEYS.set_project, path);
      if (op.project_id === undefined)
        throw badInput(`${path}.project_id must be a project id, or null for workspace-wide`);
      return {
        op: 'set_project',
        project_id:
          op.project_id === null ? null : requiredString(op.project_id, `${path}.project_id`),
      };
    }
    default:
      throw badInput(`${path}.op must be one of ${SCHEMA_OP_NAMES.join(', ')}`);
  }
}

/**
 * The keys each schema op accepts (besides nothing else: onlyKeys refuses the
 * rest). Exported so the drift test can check that the `table` definition's
 * ops description names every op and each of its keys.
 */
export const SCHEMA_OP_KEYS: Readonly<Record<AgentSchemaOp['op'], readonly string[]>> = {
  add_field: ['op', 'field'],
  update_field: ['op', 'name', 'set', 'clear_repeats'],
  reorder_fields: ['op', 'names'],
  rename_table: ['op', 'name'],
  archive_field: ['op', 'name'],
  delete_field: ['op', 'name'],
  restore_field: ['op', 'name', 'as'],
  set_title_field: ['op', 'name'],
  archive_table: ['op'],
  delete_table: ['op', 'clear_links'],
  restore_table: ['op', 'as'],
  set_project: ['op', 'project_id'],
};

const SCHEMA_OP_NAMES = Object.keys(SCHEMA_OP_KEYS);

function heading(
  table: AgentTableSummary,
  created: boolean,
  ops: readonly AgentSchemaOp[]
): string {
  if (table.state === 'archived') return `archived ${table.name}; restore_table brings it back:`;
  if (table.state === 'deleted')
    return `deleted ${table.name}; a person can undo it from the table history:`;
  if (created)
    return table.project
      ? `created ${table.name} in project ${table.project.name} (${table.project.id}):`
      : `created ${table.name} (workspace-wide):`;
  const [only] = ops;
  if (ops.length === 1 && only?.op === 'set_project')
    return table.project
      ? `${table.name} is now in project ${table.project.name}:`
      : `${table.name} is now workspace-wide:`;
  return `altered ${table.name} (${ops.length} ${ops.length === 1 ? 'op' : 'ops'}):`;
}

const tool: ToolHandler = async (input, _settings, context) =>
  runTableTool(async () => {
    const table = requiredString(input.table, 'table');
    // Present `fields` (even []) is what creates the table; only the title field is implied.
    const fields = optionalArray(input.fields, 'fields')?.map((raw, index) =>
      newField(raw, `fields[${index}]`)
    );
    const ops = optionalArray(input.ops, 'ops')?.map(schemaOp) ?? [];
    if (!fields && !ops.length) {
      throw badInput('pass fields to create the table, or ops to change it');
    }
    // A create from a project thread lands in that project, as docs and threads do.
    const result = await applyAgentSchema(
      table,
      { ...(fields ? { fields } : {}), ...(ops.length ? { ops } : {}) },
      { threadId: context?.threadId }
    );
    return renderTableDetail(result.table, heading(result.table, result.created, ops));
  });

export default tool;
