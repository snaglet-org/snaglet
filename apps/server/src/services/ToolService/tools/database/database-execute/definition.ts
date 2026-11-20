import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'database_execute',
  name: 'Database Execute',
  description:
    'Execute raw SQL against the Snaglet database as the restricted snaglet_workspace_writer role. It can run any DDL (CREATE/ALTER/DROP) or DML (INSERT/UPDATE/DELETE) on custom Database tables (the user_tables schema) — but PostgreSQL itself denies all access to Snaglet system tables (agents, credentials, messages, memories, hooks, table_catalog, the migrations ledger, …), any CREATE in the public schema, and server-side file/program functions such as COPY … TO PROGRAM. Unqualified names resolve in user_tables. Each call runs in one transaction; a failed statement rolls back, but a committed DELETE or DROP has no undo. Prefer `table` (ops `write` and `delete`) for safe, undoable structured operations, and `database_query` to read workspace tables. Use this only when structured tools cannot do the job.',
  type: 'builtin',
  tier: 'standard',
  // Raw writes/DDL against custom tables with no undo — panel confirm-gates it.
  destructive: true,
  keywords: ['database', 'execute', 'sql', 'run', 'statement', 'raw'],
  parameters_schema: {
    type: 'object',
    required: ['sql'],
    properties: {
      sql: {
        type: 'string',
        description:
          'Raw SQL to execute. Runs immediately with no confirmation. Double-check WHERE clauses — an unfiltered DELETE or UPDATE affects every row in the table.',
      },
    },
    examples: [
      {
        sql: "UPDATE my_table SET status='done' WHERE id='row-abc123'",
      },
    ],
  },
  sort_order: 66,
};

export default definition;
