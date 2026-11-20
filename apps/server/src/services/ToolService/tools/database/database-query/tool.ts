import {
  hiddenWorkspaceObjects,
  TableQueryError,
  WorkspaceQuery,
  WORKSPACE_QUERY_DEFAULT_LIMIT,
  WORKSPACE_QUERY_DEFAULT_MAX_CELL,
  WORKSPACE_QUERY_MAX_LIMIT,
  WORKSPACE_QUERY_MAX_MAX_CELL,
  WORKSPACE_QUERY_MIN_MAX_CELL,
} from '@snaglet/db/tables/table_query';
import { getErrorMessage } from '@snaglet/shared/utils';
import type { ToolHandler } from '@server/services/ToolService/types';
import { sqlState } from '@server/services/ToolService/tools/database/_shared/errors';

/**
 * database_query runs agent SQL through the WorkspaceQuery sandbox: one
 * SELECT, in a READ ONLY transaction, as the `snaglet_workspace_reader` login role.
 * The role — not this handler — is the boundary; the checks here only turn
 * refusals into messages an agent can act on.
 */

function resolveMaxColumnWidth(rawValue: unknown): number {
  if (rawValue === undefined || rawValue === null) return WORKSPACE_QUERY_DEFAULT_MAX_CELL;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed === 0 || parsed < -1) {
    throw new Error('max_column_width must be -1 (widest) or a positive integer');
  }
  if (parsed === -1) return WORKSPACE_QUERY_MAX_MAX_CELL;
  return Math.min(Math.max(parsed, WORKSPACE_QUERY_MIN_MAX_CELL), WORKSPACE_QUERY_MAX_MAX_CELL);
}

function resolveLimit(rawValue: unknown): number {
  if (rawValue === undefined || rawValue === null) return WORKSPACE_QUERY_DEFAULT_LIMIT;
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > WORKSPACE_QUERY_MAX_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${WORKSPACE_QUERY_MAX_LIMIT}`);
  }
  return parsed;
}

function hiddenSummary(): string {
  const { tables, columns } = hiddenWorkspaceObjects();
  return `tables ${tables.join(', ')}; columns ${columns.join(', ')}`;
}

/** Explain a refusal in terms of what the agent can change. */
function describeFailure(error: unknown): string {
  const message = getErrorMessage(error);
  if (error instanceof TableQueryError) {
    if (error.code === 'not_a_select') {
      return `database_query is read-only: ${message} Use database_execute for writes.`;
    }
    return message;
  }
  switch (sqlState(error)) {
    case '42501':
      return (
        `${message}. database_query runs as the read-only snaglet_workspace_reader role, which ` +
        `cannot read credentials (${hiddenSummary()}), tables not yet classified for it, ` +
        'or call server-side file, program and admin functions.'
      );
    case '57014':
      return `${message}. Queries are canceled after 5 seconds; add a WHERE or LIMIT.`;
    case '25006':
      return `${message}. database_query is read-only; use database_execute for writes.`;
    case '42601':
      return /multiple commands/i.test(message) ? `${message}. Send one SELECT per call.` : message;
    default:
      return message === 'Query read timeout'
        ? 'Query canceled after 7 seconds; add a WHERE or LIMIT.'
        : message;
  }
}

const tool: ToolHandler = async (input) => {
  const sql = typeof input.sql === 'string' ? input.sql : '';
  if (!sql.trim()) throw new Error('sql is required');
  const maxCell = resolveMaxColumnWidth(input.max_column_width);
  const limit = resolveLimit(input.limit);

  let result: Awaited<ReturnType<typeof WorkspaceQuery.select>>;
  try {
    result = await WorkspaceQuery.select(sql, { limit, maxCell });
  } catch (error: unknown) {
    throw new Error(describeFailure(error));
  }
  if (!result.ok) throw new Error(result.message);
  if (result.columns.length === 0) return 'No rows returned.';

  const header = result.columns.join(' | ');
  const separator = result.columns.map((column) => '-'.repeat(column.length)).join('-+-');
  const rows = result.rows.map((row) => row.map((cell) => cell ?? 'NULL').join(' | '));
  let output = `${header}\n${separator}\n${rows.join('\n')}`;
  if (result.capped) {
    output +=
      `\n\n(showing the first ${limit} rows; more matched — add WHERE/LIMIT` +
      `${limit < WORKSPACE_QUERY_MAX_LIMIT ? ` or raise limit (max ${WORKSPACE_QUERY_MAX_LIMIT})` : ''})`;
  }
  return output;
};

export default tool;
