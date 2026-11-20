# Table

Read, write, change the schema of, and delete rows from the user's Database
tables. One tool, selected by `op`: `read`, `fields`, `query`, `write`,
`schema`, `delete`. Tables and fields are addressed by name.

**Tier:** core
**Type:** builtin

## Reading rows

- `{op: "read"}` lists tables; `{op: "read", table}` describes one.
- `{op: "read", table, ids}` returns those entries with their `rev`.
- `{op: "read", table, where, sort, columns, page, limit}` returns one page of
  entries. Every structured key is optional; any of them selects this read.
  It cannot be combined with `ids` or `max_cell`.

| Key       | Shape                        | Notes                                                         |
| --------- | ---------------------------- | ------------------------------------------------------------- |
| `where`   | `[{field, operator, value}]` | ANDed, at most 20. `is_empty` / `is_not_empty` take no value. |
| `sort`    | `[{field, direction}]`       | `direction` is `asc` (default) or `desc`; at most 8.          |
| `columns` | `[field name]`               | Values returned per entry. Default: every field.              |
| `page`    | integer, 1-based             | Default 1.                                                    |
| `limit`   | integer, 1-100               | Rows per page. Default 25. (With `sql`: 1-200, default 50.)   |

Operators by field type (an unsupported one is refused):

- text: `contains`, `not_contains`, `is`, `is_not`, `starts_with`, `ends_with`
- number: `eq`, `neq`, `gt`, `gte`, `lt`, `lte` (value as a decimal string)
- select: `is`, `is_not` (`contains`, `not_contains` when multiple)
- date / datetime: `is`, `before`, `after`, `on_or_before`, `on_or_after`
  (value `YYYY-MM-DD`)
- checkbox: `is` (value `true` / `false`)
- relation: `is_empty`, `is_not_empty`
- every type except checkbox also accepts `is_empty` / `is_not_empty`

Output is one line per entry (`id (rev …) {values}`) followed by the position,
e.g. `rows 26-50 of 120 in tasks; more: page 3`. Pass the `rev` back to
`write` `update` for a guarded edit.

## Other ops

See the `description` and `parameters_schema` in `definition.ts`; `op: "query"`
runs one read-only `SELECT` on `user_tables` and `op: "fields"` returns field
metadata.

## Fields not listed in the schema

To keep every turn small, the advertised schema leaves these out. They work
exactly as before: pass them as normal fields.
`tool({op: "schema", name: "table"})` returns their full schemas as
`unlisted_parameters`.

- `fields` (op `schema`): creates the table, all or nothing (may be `[]`; it
  also gets a text title field called `name`). Each item is
  `{name, type, description?, nullable?, default?, ref?, multiple?, range?,
options?, before?, repeats?, calendar?}`. `type` is `text`, `number`, `date`,
  `datetime`, `checkbox`, `relation` or `select`; `ref` is the related table, or
  `snaglet:doc|project|container|thread|image|post|agent`; `multiple` makes a
  relation or select a list; `range` gives a date or datetime an end
  (start/end); `options` are the select labels; `before` places the field;
  `repeats` lets a date or datetime row repeat; `calendar` binds a date field
  to a calendar (name or id, or `null`). A table created from a thread in a
  project belongs to that project, as a doc or thread an agent creates does;
  with no thread (an MCP client, hook or SDK code) or a thread with no
  project, it is workspace-wide. A `set_project` op in the same call wins:
  `ops: [{op: "set_project", project_id: null}]` keeps it workspace-wide. The
  result's first line says where the table landed.
- `ops` (op `schema`): alters an existing table, all or nothing. Each item is
  `{op, …}`: `add_field {field}`, `update_field {name, set, clear_repeats}`
  (`set.name` renames; in `set`, `options` is the full list, `{from, to}`
  renames one), `reorder_fields {names}` (all fields), `rename_table {name}`,
  `archive_field`, `delete_field` or `set_title_field {name}`,
  `restore_field {name, as}`, `archive_table`, `delete_table {clear_links}`,
  `restore_table {as}`, `set_project {project_id}` (`null`: workspace-wide).
  `as` is a new name when the old one is taken.
- `repeat` (op `write`): steps for repeating (↻) date fields, applied after
  the row writes, one per item: `{id, field, set | done | skip}`.
- `max_cell` (op `read` with `sql`): characters per cell, 40-4000, default 200.
- `clear_links` (op `delete`): required when other entries link to the
  entries being deleted; removes those links.
