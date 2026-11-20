import { formatQueryRows, assertNoImmutableTables } from '@snaglet/db';
import { WorkspaceExecute } from '@snaglet/db/tables/table_query';
import type { ToolHandler } from '@server/services/ToolService/types';
import { describeWriterFailure } from '../_shared/writerErrors';

/**
 * database_execute runs agent SQL as the restricted `snaglet_workspace_writer`
 * login role — it can write custom Database tables (the `user_tables` schema)
 * and reach nothing in `public` (Snaglet's system tables). The role, enforced by
 * PostgreSQL, is the boundary; the denylist below is defense in depth, not the
 * primary guard.
 */
const tool: ToolHandler = async (input) => {
  const sql = String(input.sql ?? '').trim();
  if (!sql) throw new Error('sql is required');

  const forbiddenPatterns = [
    /\bdrop\s+database\b/i,
    /\b(create|alter|drop)\s+role\b/i,
    /\bgrant\b/i,
    /\brevoke\b/i,
    /\bcopy\b[\s\S]*\bprogram\b/i,
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(sql)) {
      throw new Error(
        'database_execute does not allow database-level admin or program execution statements'
      );
    }
  }

  assertNoImmutableTables(sql);

  try {
    const result = await WorkspaceExecute.execute(sql);
    return formatQueryRows(result.rows, result.rowCount);
  } catch (error: unknown) {
    throw new Error(describeWriterFailure('database_execute', error));
  }
};

export default tool;
