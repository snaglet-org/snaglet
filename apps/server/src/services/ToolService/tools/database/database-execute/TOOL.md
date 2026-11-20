# Database Execute

Execute raw SQL (DDL or DML) against the Snaglet database as the restricted
`snaglet_workspace_writer` login role. The role — not the handler — is the security
boundary: PostgreSQL lets it write custom Database tables (the `user_tables`
schema) but denies all access to Snaglet system tables in `public`, any `CREATE` in
`public`, and server-side file/program functions. Confirmation is required by
default (`destructive: true`).

**Tier:** standard
**Type:** builtin

## Parameters

| Name  | Type   | Required | Description                                     |
| ----- | ------ | -------- | ----------------------------------------------- |
| `sql` | string | Yes      | Raw SQL to execute against the Snaglet database |

## Example Input

```json
{
  "sql": "UPDATE companies SET status = 'won' WHERE id = '...'"
}
```

## Notes

- Runs as `snaglet_workspace_writer` in one transaction; a failed statement rolls
  back, but a committed `DELETE`/`DROP` has no undo. Unqualified names resolve
  in `user_tables`.
- Reaching a system table, `CREATE` in `public`, or `COPY … TO PROGRAM` fails
  inside PostgreSQL, not just in the handler's denylist.
- Under `SNAGLET_DATABASE_URL` the tool needs `SNAGLET_WORKSPACE_WRITER_URL`; without it
  the tool is refused (never run as the app database user).
- Validate inputs against `definition.ts` before changing handler behavior so
  docs, runtime, and DB metadata stay in sync.
