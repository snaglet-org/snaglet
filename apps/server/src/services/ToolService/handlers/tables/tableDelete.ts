import type { ToolHandler } from '@server/services/ToolService/types';
import { TABLE_ENTRY_DELETE_MAX } from '@snaglet/shared/types';
import { deleteAgentEntries } from '@server/domains/tables/tableAgent';
import { runTableTool } from '@server/services/ToolService/tools/database/_shared/errors';
import {
  badInput,
  optionalBoolean,
  requiredString,
  stringArray,
} from '@server/services/ToolService/tools/database/_shared/input';
import { renderDelete } from '@server/services/ToolService/tools/database/_shared/render';

const tool: ToolHandler = async (input) =>
  runTableTool(async () => {
    const table = requiredString(input.table, 'table');
    const ids = stringArray(input.ids, 'ids');
    if (ids.length > TABLE_ENTRY_DELETE_MAX) {
      throw badInput(`ids must list at most ${TABLE_ENTRY_DELETE_MAX} entries`);
    }
    const clearLinks = optionalBoolean(input.clear_links, 'clear_links') ?? false;
    return renderDelete(await deleteAgentEntries(table, { ids, clearLinks }));
  });

export default tool;
