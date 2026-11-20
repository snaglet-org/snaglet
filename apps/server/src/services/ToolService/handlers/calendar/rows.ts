/**
 * Addressing one table row's date field from the calendar tool: `table`
 * (name or id), `entry_id` and `field` (name or id), exactly as a query
 * result names them. Resolved through the table tool's own reader, so the
 * same rules hold: custom tables only (a Snaglet table is a 403), an archived
 * one is a 409.
 */
import { TABLE_ENTRY_ID_PATTERN, type TableField } from '@snaglet/shared/types';
import { describeAgentTable } from '@server/domains/tables/tableAgent';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';

type Input = Record<string, unknown>;

export interface RowTarget {
  tableId: string;
  tableName: string;
  field: TableField;
  entryId: string;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw badInput(`${name} is required`);
  return value.trim();
}

export async function resolveRowTarget(input: Input): Promise<RowTarget> {
  const tableKey = text(input.table, 'table');
  const fieldKey = text(input.field, 'field');
  const entryId = text(input.entry_id, 'entry_id').toLowerCase();
  if (!TABLE_ENTRY_ID_PATTERN.test(entryId)) throw badInput('entry_id must be a row id (a UUID)');
  const table = await describeAgentTable(tableKey);
  const field = table.fields.find(
    (candidate) =>
      candidate.id === fieldKey || candidate.name.toLowerCase() === fieldKey.toLowerCase()
  );
  if (!field || (field.type !== 'date' && field.type !== 'datetime'))
    throw badInput(`field must name a date or datetime field of ${table.name}`);
  return { tableId: table.id, tableName: table.name, field, entryId };
}
