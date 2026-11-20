import type { ToolHandler } from '@server/services/ToolService/types';
import { queryAgentTables } from '@server/domains/tables/tableAgent';
import { runTableTool } from '@server/services/ToolService/tools/database/_shared/errors';
import {
  badInput,
  optionalInteger,
} from '@server/services/ToolService/tools/database/_shared/input';
import { renderQuery } from '@server/services/ToolService/tools/database/_shared/render';
import {
  SQL_LIMIT,
  SQL_MAX_CELL,
} from '@server/services/ToolService/tools/database/_shared/schemas';

const tool: ToolHandler = async (input) =>
  runTableTool(async () => {
    if (typeof input.sql !== 'string' || !input.sql.trim()) throw badInput('sql is required');
    const limit =
      optionalInteger(input.limit, 'limit', SQL_LIMIT.min, SQL_LIMIT.max) ?? SQL_LIMIT.default;
    const maxCell =
      optionalInteger(input.max_cell, 'max_cell', SQL_MAX_CELL.min, SQL_MAX_CELL.max) ??
      SQL_MAX_CELL.default;
    return renderQuery(await queryAgentTables(input.sql.trim(), { limit, maxCell }), limit);
  });

export default tool;
