# Query Database

Run one read-only SELECT against the Snaglet Postgres database and return the rows as
a table.

**Tier:** standard
**Type:** builtin

## Parameters

| Name               | Type    | Required | Description                                                                                                  |
| ------------------ | ------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `sql`              | string  | Yes      | One `SELECT` or `WITH … SELECT` statement                                                                    |
| `limit`            | integer | No       | Rows returned at most, 1–500. Defaults to `100`; the output says when more matched.                          |
| `max_column_width` | integer | No       | Characters per cell before it is cut and marked `…[+N chars]`. Defaults to `100` (min `10`); `-1` = `20000`. |

## Example Input

```json
{
  "sql": "SELECT id, title, created_at FROM docs ORDER BY created_at DESC",
  "limit": 20,
  "max_column_width": 120
}
```

## Sandbox

The query runs through `WorkspaceQuery` (`packages/db/tables/table_query`) on a
separate pool whose login role is `snaglet_workspace_reader` — a non-superuser that
is a member of nothing — inside `BEGIN READ ONLY`. PostgreSQL itself enforces
the boundary:

- It reads the `public` tables classified in `WORKSPACE_READER_POLICY`
  (`packages/db/runtime/postgres/workspaceReader.ts`) and every table in
  `user_tables`. `search_path` is `public, user_tables`.
- It cannot read `user_provider_credentials`, `provider_fallback_credentials`,
  `mcp_api_keys`, `socket_sessions`, the columns `mcp_servers.args/url/headers/env`
  and `users.auth_provider_id`, or any unclassified table or view. Name the
  columns you need; `SELECT *` on a column-restricted table is denied.
- It cannot write, stack statements, create objects, or call superuser-only
  functions such as `pg_read_file`, `pg_ls_dir`, `lo_import` or `COPY … TO
PROGRAM`.
- Statements are canceled after 5 seconds (7 seconds client-side, with a
  server-side cancel).

Under `SNAGLET_DATABASE_URL` the tool needs `SNAGLET_WORKSPACE_READER_URL`; without it the
tool is refused rather than run as the app user. See
[Architecture](../../../../../../../../docs/architecture.md#agent-sql-roles).

## Notes

- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- Writes belong to `database_execute`, which is confirm-gated.
