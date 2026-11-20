import type { ToolHandler } from '@server/services/ToolService/types';
import { writeAgentEntries, type AgentWriteInput } from '@server/domains/tables/tableAgent';
import { runTableTool } from '@server/services/ToolService/tools/database/_shared/errors';
import {
  badInput,
  entryValues,
  objectAt,
  onlyKeys,
  optionalArray,
  optionalString,
  requiredString,
} from '@server/services/ToolService/tools/database/_shared/input';
import { renderWrite } from '@server/services/ToolService/tools/database/_shared/render';

type Insert = NonNullable<AgentWriteInput['insert']>[number];
type Update = NonNullable<AgentWriteInput['update']>[number];

const VALUES_HINT = '; put field values inside values';

function insertRow(raw: unknown, index: number): Insert {
  const path = `insert[${index}]`;
  const row = objectAt(raw, path);
  onlyKeys(row, ['id', 'values', 'before'], path, VALUES_HINT);
  const id = optionalString(row.id, `${path}.id`);
  const before = optionalString(row.before, `${path}.before`);
  return {
    ...(id ? { id } : {}),
    values: entryValues(row.values, `${path}.values`),
    ...(before ? { before } : {}),
  };
}

function updateRow(raw: unknown, index: number): Update {
  const path = `update[${index}]`;
  const row = objectAt(raw, path);
  onlyKeys(row, ['id', 'values', 'rev'], path, VALUES_HINT);
  const rev = optionalString(row.rev, `${path}.rev`);
  return {
    id: requiredString(row.id, `${path}.id`),
    values: entryValues(row.values, `${path}.values`),
    ...(rev ? { rev } : {}),
  };
}

type Repeat = NonNullable<AgentWriteInput['repeat']>[number];

function repeatItem(raw: unknown, index: number): Repeat {
  const path = `repeat[${index}]`;
  const item = objectAt(raw, path);
  onlyKeys(item, ['id', 'field', 'set', 'done', 'skip'], path);
  return item as unknown as Repeat;
}

const tool: ToolHandler = async (input) =>
  runTableTool(async () => {
    const table = requiredString(input.table, 'table');
    const insert = optionalArray(input.insert, 'insert')?.map(insertRow) ?? [];
    const update = optionalArray(input.update, 'update')?.map(updateRow) ?? [];
    const repeat = optionalArray(input.repeat, 'repeat')?.map(repeatItem) ?? [];
    if (!insert.length && !update.length && !repeat.length)
      throw badInput('pass at least one insert, update or repeat item');
    const result = await writeAgentEntries(table, {
      ...(insert.length ? { insert } : {}),
      ...(update.length ? { update } : {}),
      ...(repeat.length ? { repeat } : {}),
    });
    return renderWrite(result);
  });

export default tool;
