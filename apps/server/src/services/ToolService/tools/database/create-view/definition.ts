import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'create_view',
  name: 'Create View',
  description:
    'Create or replace a SQL view over custom Database tables. It runs as the restricted snaglet_workspace_writer role, so the view is created in the user_tables schema, owned by that role, and can read only custom Database tables — a view over a Snaglet system table (agents, credentials, …) fails and is rolled back. Views persist until manually dropped. **There is no companion `database_drop_view` tool** — to remove a view use `database_execute` with `DROP VIEW <name>`. Use `CREATE OR REPLACE VIEW` semantics to update an existing view safely.',
  type: 'builtin',
  tier: 'standard',
  // Not destructive: `destructive: true` makes agents ask the user first, and
  // creating a view confined to the custom schema (the writer role is the
  // guard) neither destroys data nor warrants a confirmation prompt.
  keywords: ['database', 'view', 'create', 'sql', 'query', 'virtual', 'table'],
  parameters_schema: {
    type: 'object',
    required: ['name', 'query'],
    properties: {
      name: {
        type: 'string',
        description:
          'View name. Must be a valid SQL identifier. Use a consistent naming convention (e.g. `v_<purpose>`) to distinguish views from tables.',
      },
      query: {
        type: 'string',
        description:
          'The SELECT statement that defines the view. Validated before creation — syntax errors will cause the call to fail.',
      },
    },
  },
  param_aliases: {
    view_name: ['name', 'viewName'],
    select_sql: ['query', 'selectSql'],
  },
  sort_order: 68,
};

export default definition;
