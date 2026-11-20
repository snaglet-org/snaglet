import {
  assertValidIdentifier,
  ensureReadonlySelectSql,
  quoteIdentifier,
  assertNoImmutableTables,
} from '@snaglet/db';
import { WorkspaceExecute } from '@snaglet/db/tables/table_query';
import type { ToolHandler } from '@server/services/ToolService/types';
import { describeWriterFailure } from '../_shared/writerErrors';

/**
 * create_view runs as the restricted `snaglet_workspace_writer` role, whose
 * search_path is the custom `user_tables` schema — so an unqualified view is
 * created there, owned by the writer. PostgreSQL checks a view's underlying
 * privileges when the view is READ (with its owner's rights), not when it is
 * created, so the statement reads the new view once inside the same
 * transaction: a view over a system table (`agents`, credentials) fails that
 * probe and is rolled back, never left behind. The identifier and read-only
 * checks below remain as defense in depth.
 */
const tool: ToolHandler = async (input) => {
  const viewName = String(input.view_name ?? input.viewName ?? '');
  assertValidIdentifier(viewName, 'view name');
  // Block creating a VIEW whose name shadows a credential table — would let
  // a later structured read against the view bypass assertAllowedTable.
  assertNoImmutableTables(viewName);
  const replace = input.replace !== false;
  const selectSql = ensureReadonlySelectSql(String(input.select_sql ?? input.selectSql ?? ''));
  // Block creating a VIEW whose body reads from a credential table.
  assertNoImmutableTables(selectSql);
  const view = quoteIdentifier(viewName);
  const statement =
    `${replace ? 'CREATE OR REPLACE' : 'CREATE'} VIEW ${view} AS ${selectSql};\n` +
    `SELECT * FROM ${view} LIMIT 0`;
  try {
    await WorkspaceExecute.execute(statement);
  } catch (error: unknown) {
    throw new Error(describeWriterFailure('create_view', error));
  }
  return `View ${viewName} ${replace ? 'created or replaced' : 'created'} successfully.`;
};

export default tool;
