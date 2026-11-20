import { TableFields } from '@snaglet/db/tables/table_fields';
import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';
import {
  describeAgentTable,
  listAgentEntries,
  listAgentTables,
  listArchivedAgentTables,
  queryAgentTables,
  readAgentEntries,
  threadProject,
} from '@server/domains/tables/tableAgent';
import { runTableTool } from '@server/services/ToolService/tools/database/_shared/errors';
import {
  badInput,
  optionalInteger,
} from '@server/services/ToolService/tools/database/_shared/input';
import {
  renderEntries,
  renderEntryPage,
  renderQuery,
  renderTableDetail,
  renderTableList,
} from '@server/services/ToolService/tools/database/_shared/render';
import {
  AGENT_LIST_LIMIT,
  SQL_LIMIT,
  SQL_MAX_CELL,
} from '@server/services/ToolService/tools/database/_shared/schemas';
import {
  structuredEntries,
  structuredQuery,
  type TableReadData,
} from '@server/services/ToolService/tools/database/_shared/structured';

/** Blank selectors count as absent, so `{table: ''}` still lists. */
function selector(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badInput(`${key} must be a string`);
  return value.trim() || undefined;
}

/** Keys that turn `{table}` into a paged, structured row read. */
const STRUCTURED_KEYS = ['where', 'sort', 'columns', 'page'] as const;

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** The text, plus `{ rows, fields }` as `rawContent` when SDK code asked for structured data. */
type ReadResult = string | ToolHandlerRichResult;

function withRows(text: string, data: TableReadData | null): ReadResult {
  return data ? { output: text, rawContent: data } : text;
}

/** The names a paged read's `columns` asked for, when it asked. */
function requestedColumns(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : undefined;
}

// Unknown keys are ignored: the `table_list` alias id maps here and may still send `origin`.
const tool: ToolHandler = async (input, _settings, context) =>
  runTableTool<ReadResult>(async () => {
    // Hook and tool code (the SDK) also gets row reads as objects; the text is
    // the same either way, and chat never asks.
    const structured = context?.structuredResult === true;
    const fieldsOf = (tableId: string) =>
      structured ? TableFields.listFields(tableId) : Promise.resolve([]);
    const table = selector(input.table, 'table');
    const sql = selector(input.sql, 'sql');
    const paged = STRUCTURED_KEYS.filter((key) => present(input[key]));
    const limit = optionalInteger(
      input.limit,
      'limit',
      SQL_LIMIT.min,
      paged.length ? AGENT_LIST_LIMIT.max : SQL_LIMIT.max
    );
    const maxCell = optionalInteger(input.max_cell, 'max_cell', SQL_MAX_CELL.min, SQL_MAX_CELL.max);
    if (table && sql) throw badInput('pass table or sql, not both');
    if (paged.length) {
      const named = paged.join('/');
      if (!table) throw badInput(`${named} needs table`);
      if (present(input.ids)) throw badInput(`${named} cannot be combined with ids`);
      if (present(input.max_cell)) throw badInput('max_cell is for sql reads');
      const page = optionalInteger(input.page, 'page', 1, Number.MAX_SAFE_INTEGER);
      const result = await listAgentEntries(table, {
        ...(present(input.where) && { where: input.where as never }),
        ...(present(input.sort) && { sort: input.sort as never }),
        ...(present(input.columns) && { columns: input.columns as never }),
        ...(page !== undefined && { page }),
        ...(limit !== undefined && { limit }),
      });
      return withRows(
        renderEntryPage(result),
        structured
          ? structuredEntries(
              result,
              await fieldsOf(result.tableId),
              requestedColumns(input.columns)
            )
          : null
      );
    }
    if (input.ids !== undefined && input.ids !== null) {
      if (!table) throw badInput('ids needs table');
      if (!Array.isArray(input.ids)) throw badInput('ids must be an array of entry ids');
      const result = await readAgentEntries(table, input.ids);
      return withRows(
        renderEntries(result),
        structured ? structuredEntries(result, await fieldsOf(result.tableId)) : null
      );
    }
    if (sql) {
      const rows = limit ?? SQL_LIMIT.default;
      const result = await queryAgentTables(sql, {
        limit: rows,
        maxCell: maxCell ?? SQL_MAX_CELL.default,
      });
      return withRows(renderQuery(result, rows), structured ? structuredQuery(result) : null);
    }
    if (table) return renderTableDetail(await describeAgentTable(table));
    // From a project thread, that project's tables lead the list.
    const project = await threadProject(context?.threadId);
    return renderTableList(
      await listAgentTables(project?.id ?? null),
      await listArchivedAgentTables(),
      project
    );
  });

export default tool;
