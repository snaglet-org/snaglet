import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'database_query',
  name: 'Query Database',
  description:
    'Run one read-only SELECT (or WITH … SELECT) against the Snaglet Postgres database and return the rows as a table. ' +
    'It runs as the restricted snaglet_workspace_reader role in a READ ONLY transaction: it can read workspace tables ' +
    '(nodes, docs, containers, threads, messages, agents, memories, runs, calendars, table_catalog, …) ' +
    'and custom Database tables in the user_tables schema (search_path is public, user_tables). ' +
    'It cannot write, run more than one statement, call server-side file/program/admin functions, or read credentials: ' +
    'the tables user_provider_credentials, provider_fallback_credentials, mcp_api_keys and socket_sessions, ' +
    'the columns mcp_servers.args/url/headers/env and users.auth_provider_id, and any table not yet classified for it ' +
    'are denied — name only the columns you need (SELECT * on mcp_servers or users is denied). ' +
    'Queries are canceled after 5 seconds; at most `limit` rows (default 100, max 500) come back, and long cells ' +
    'end in …[+N chars]. Use database_execute for writes.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['database', 'query', 'sql', 'select', 'read', 'fetch'],
  parameters_schema: {
    type: 'object',
    required: ['sql'],
    properties: {
      sql: {
        type: 'string',
        description: 'One SELECT or WITH … SELECT statement (no trailing second statement).',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description:
          'Maximum rows to return. Defaults to 100; the output says when more rows matched.',
      },
      max_column_width: {
        type: 'integer',
        minimum: -1,
        description:
          'Maximum characters per cell before it is cut and marked …[+N chars]. Defaults to 100; values below 10 are raised to 10. Use -1 for the widest cut, 20000.',
      },
    },
    examples: [
      {
        sql: 'SELECT d.id, d.title FROM docs d JOIN nodes n ON n.id = d.id WHERE n.archived = false ORDER BY n.updated_at DESC LIMIT 20',
      },
      {
        sql: "SELECT tool, COUNT(*) FROM agent_activity_log WHERE action_type='tool_call' AND created_at > NOW() - INTERVAL '7 days' GROUP BY tool ORDER BY 2 DESC LIMIT 20",
      },
    ],
  },
  sort_order: 60,
};

export default definition;
