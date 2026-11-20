# Create View

Create or replace a SQL view from a single read-only SELECT or WITH query,
over custom Database tables. It runs as the restricted `snaglet_workspace_writer`
role, so the view is created in the `user_tables` schema, owned by that role, and
reads with its rights. PostgreSQL checks a view's sources when it is read, not
created, so the tool reads the new view once in the same transaction: a view
over a Snaglet system table (`agents`, credentials, …) fails there and is rolled
back, never left behind.

**Tier:** standard
**Type:** builtin

## Parameters

| Name      | Type    | Required | Description                                                    |
| --------- | ------- | -------- | -------------------------------------------------------------- |
| `replace` | boolean | No       | Replace the existing view when true                            |
| `name`    | string  | Yes      | SQL identifier for the view name                               |
| `query`   | string  | Yes      | Single read-only SELECT/WITH query used as the view definition |

## Example Input

```json
{
  "name": "v_example",
  "query": "SELECT * FROM tools LIMIT 5"
}
```

## Notes

- Under `SNAGLET_DATABASE_URL` the tool needs `SNAGLET_WORKSPACE_WRITER_URL`; without it
  the tool is refused (never run as the app database user).
- Validate inputs against `definition.ts` before changing handler behavior so docs, runtime, and DB metadata stay in sync.
- Legacy callers may continue sending `view_name` / `viewName` and
  `select_sql` / `selectSql`; runtime parameter aliases normalize the canonical
  `name` and `query` fields for the existing handler.
