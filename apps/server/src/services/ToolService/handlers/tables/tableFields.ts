import type { ToolHandler } from '@server/services/ToolService/types';
import { describeAgentTable } from '@server/domains/tables/tableAgent';
import { runTableTool } from '@server/services/ToolService/tools/database/_shared/errors';
import { badInput } from '@server/services/ToolService/tools/database/_shared/input';

function tableName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw badInput('table is required');
  return value.trim();
}

/** Return compact schema metadata without reading or rendering table entries. */
const tool: ToolHandler = async (input) =>
  runTableTool(async () => {
    const table = await describeAgentTable(tableName(input.table));
    return JSON.stringify({
      id: table.id,
      name: table.name,
      fields: table.fields.map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        isTitle: field.isTitle,
        managed: field.managed,
        nullable: field.nullable,
        defaultValue: field.defaultValue,
        description: field.description,
        options: field.options,
        referenceTableId: field.referenceTableId,
        referenceKind: field.referenceKind,
        refName: field.refName,
        multiple: field.multiple,
        range: field.range,
        recurrence: field.recurrence ?? null,
        calendarId: field.calendarId ?? null,
      })),
    });
  });

export default tool;
