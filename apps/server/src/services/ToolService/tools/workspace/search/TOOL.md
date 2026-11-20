# search

Use `kind` to select a focused backend:

- `all` / `workspace` for fused workspace knowledge
- `docs`, `containers`, `code`, `files`, `database`, or `conversations`

Table rows (Database entries) are not a `kind`: ask for them with
`kinds: ["entry"]`, alone (see Entries below).

Legacy search ids remain executable aliases with their `kind` pinned.

## Picking mode and kind

- `mode` defaults to `hybrid` (meaning + keywords): right for prior context,
  decisions, and paraphrased recall across docs/messages/memories/thread
  summaries. Pass `mode: 'keyword'` for exact strings, ids, tool/function
  names, and literal titles (lexical, with a trigram fallback on
  names/titles/paths when nothing matches). `semantic` is meaning only.
  Semantic/hybrid cover doc/message/memory/thread_summary/file; threads
  and containers are keyword-only (matched on authored titles/names).
- Narrow noise with `kinds: [...]`, `time_range`, and container/project scope
  (`container_id`, `path`).
- `kind: 'files'` finds WHERE a concept or behavior lives when you don't know
  the filename; `kind: 'code'` matches exact strings/symbols; `file` with
  `op: 'list'` and `mode: 'find'` matches names/globs.
- `kind: 'conversations'` answers "where did we discuss X / which thread
  decided Y" — read the thread before citing the decision.
- Old message → search `kinds: ['message']`, then `thread` with
  `op: 'read', mode: 'message_context'` to recover the surrounding conversation.
- Empty results mean "nothing matched", not "nothing exists" — rephrase,
  broaden `kinds`, or switch `mode` before concluding absence.

## Reading exact lines (`content_range`)

Use `query` first to find the item, then a second call with `id` +
`content_range` to read it. That order matters: search snippets tell you WHERE
to look, a ranged read is what you may quote.

```jsonc
{ "query": "retry backoff policy", "kinds": ["doc"] }        // discover
{ "id": "doc-…", "content_range": { "start_line": 40, "end_line": 80 } }  // read
```

- 1-indexed and **inclusive**. Supported kinds: `doc`, `message`, `memory`,
  and text `file`. Any other kind is reported per item, not silently skipped.
- Always re-reads the authoritative source (doc body, message content, memory
  content, the file on disk). Stored chunks and snippets are never reused, so
  the returned lines and `totalLines` reflect edits made since discovery.
- Doc ranges are raw Markdown with links and transclusions byte-exact; CRLF content
  keeps its line endings.
- Bounded on purpose: ≤500 lines per range, top 5 results when combined with
  `query` (a higher `limit` is rejected), ~24 KB per item and ~60 KB per
  response. Every truncation is stated in the output — page through long
  content with successive calls.
- `end_line` past the end clamps to the last line; a `start_line` past the end
  returns no lines rather than sliding the window down.
- Not available with a focused `kind` backend, `archived_only`, or
  `sort: 'recent'` — those routes have no authoritative content to range.

## Query syntax

- Docs/messages/memories/summaries/tools use Postgres websearch syntax
  (quoted phrases, `OR`, `-term`). Threads and containers use a
  case-insensitive substring match on names (projects are containers, so they
  surface as container hits).
- A literal node id in `query` still resolves directly, but prefer `id`/`ids`.

## Date phrases

`time_range` sets an explicit window (`from` inclusive, `to` exclusive, ISO;
`mode: 'filter'` excludes outside hits, `'boost'` only ranks inside hits
higher; `field` = `activity_at` (default) | `created_at` | `updated_at`).
`activity_at` means message created time, thread last-message time, and
node/tool updated time for most other kinds.

When `time_range` is omitted, date phrases in `query` are parsed (chrono-node):

- relative: "yesterday", "last week", "two weeks ago", "this month", "5 days ago"
- named periods: "february", "q3"
- ranges: "between january and march", "from monday to friday"
- instants: "at 3pm today"
- prefix "created" / "updated" / "modified" to target that field
  ("created yesterday", "updated last week"); otherwise `activity_at`.
- "recently" / "lately" apply a soft 30-day boost, not a hard filter.

## Project scope

- `project_scope` (`prioritize` | `only` | `all`, default `prioritize`) is about
  the project the calling thread is in.
- `only` keeps a workspace search to that project's subtree: its containers, docs,
  and the threads, messages and thread summaries inside it. Memories are not in
  any project, so they do not match under `only`. It does not apply to
  `kinds: ["entry"]` (table rows; use `project_id` there) or to the focused
  `kind` backends (`docs`, `containers`, `code`, `files`, `database`). In a thread with no
  project, `only` searches everywhere and says so. An explicit `path`,
  `container_id` or `name` wins over `project_scope`.
- `all` and `prioritize` search everywhere for a workspace search (the default
  is unchanged). For `kind: 'conversations'`, `prioritize` lists the project's
  threads first, `only` drops the rest, `all` leaves relevance order.

## Files

- `kinds` defaults to every searchable kind except `file` (files mirror code
  on disk and would flood non-code queries). Pass `kinds: ["file"]` to search
  them, or use a code-ish query (paths, extensions like `index.ts`,
  camelCase/snake_case symbols, "file"/"code"/"repo"), which adds a separate
  labeled file section.
- `scope_files: 'project'` (default) limits file hits to `project_id`, else the
  calling thread's project; if that project has no folder configured, file
  scoping is skipped. `'workspace'` searches files in every project. No effect
  on non-file kinds.

## Fields not listed in the schema

These still work exactly as before; they are left out of the schema only to
save bytes on every turn. Pass them as normal fields.
`tool({op: "schema", name: "search"})` returns their full schemas as
`unlisted_parameters`.

- Scoping: `container_id` (that container's subtree), `name` (the container
  with this name), `project_id` (file hits and `kinds: ["entry"]`),
  `include_archived` (boolean: archived nodes too, listed first and marked
  [ARCHIVED]). The scoping rules are under Project scope.
- File and code options: `scope_files` (`project` | `workspace`, see Files),
  `code_mode` (`name` | `content` | `both`, default `both`, for
  `kind: "code"`) and `glob` (a file glob for `kind: "files"`).
- `graph_depth` (0 | 1, default 0): for semantic/hybrid, backfill empty result
  slots with 1-hop link neighbors of the top hits (0.6 score decay). Keep 0
  unless you want exploratory neighbor expansion — hub nodes add noise.
- `thread_id`: for semantic/hybrid, boost results directly connected to this
  thread.
- `archived_only` (boolean): list archived nodes only (also the
  `workspace_list_archived` alias).
- `since` (ISO): lower bound for `sort: 'recent'`.
- `container_path`: container path scope for `sort: 'recent'`.
- Database (`kind: 'database'`, also the `database_search` alias): a structured
  read of one **custom Database table**. It runs as the read-only
  `snaglet_tables_reader` role (the same boundary as `table` op `query`), which is
  granted the `user_tables` schema only. Workspace tables (`agents`, `memories`,
  `messages`, `settings`, `nodes`, …), credential tables and catalog relations
  (`pg_settings`, `pg_roles`, `pg_views`, …) are refused with one plain "no such
  table" message before the query runs, so the backend never reveals whether a
  non-custom relation exists. Text cells are cut at 200 characters. For richer
  reads of a custom table, or SQL over custom tables, use the `table` tool (op
  `read` or `query`).
  - `table`: a custom Database table name (resolves in `user_tables`).
  - `columns`: columns to return.
  - `search_columns`: columns `query` is matched against.
  - `filters`: exact column filters (object).
  - `order_by`: sort column.
  - `order_direction`: `asc` (default) | `desc`.
  - `offset`: row offset (default 0).

## Entries (table rows)

`search({kinds: ["entry"], query, table?, filters?, sort?, limit?})` finds rows
of the custom Database tables by keyword, for questions like "the latest task
about memories" or "the embedding tables task".

- `query`: keywords, all of which must match (a "quoted phrase" stays whole).
  Each table's title field is ranked first, whatever it is called: an exact
  title, then a title that starts with the query, then a title that contains it,
  then other matches (text, select, number and date columns, linked titles).
  Empty `query` lists the newest rows.
- Without `table`, the tables are matched to the query first (lexical, no
  embeddings): by table name, field names, select option labels and field
  descriptions (words like "latest", "recent", "about" are ignored for this;
  there is no table description). Ties go to the table edited most recently.
  Only the best 3 are searched. A word that named the best table by its name
  says which table to read, so it is left out of the row search: `query:
"task memories"` reads the rows of `tasks` for "memories", and `query:
"tasks"` lists its newest rows. The reply's `table_match` says which tables
  were `chosen` and why, what the rows were searched for (`searched_for`) and
  names the next candidates in `also_matched`; name one with `table` to widen.
  Put only what to look for in `query`: the server does not read "latest" or
  "about" (use `sort: "recent"`).
- If the chosen tables hold no row for the words, every table (up to 40) is
  searched for them and `table_match.widened` says so. A query no table's
  metadata answers to ("memories" with no such table) is searched across up
  to 40 tables. `match_tables` (boolean, default true): `false` skips the
  matching and always searches up to 40 tables.
- `table`: one table by name (exact, then a unique prefix or close match). A
  name that matches several tables, an archived table or a Snaglet table is refused
  with the reason. Without it, up to 40 tables are searched and the reply says
  how many were left out (`tables_omitted`); pass `table` or `project_id` to
  reach them.
- `filters`: `[{field, operator, value}]` with the field names and operators
  of `table` op:query `where` (for example
  `[{"field":"Status","operator":"is","value":"Doing"}]`). Needs `table`.
- `sort`: `relevance` (default) or `recent`, which orders by creation time,
  newest first. "Latest" means `sort: "recent"`; the server does not read
  natural language.
- `limit`: 1–50, default 10 (not per table).
- Each result has `id`, `ref` (`entry:<table id>/<id>`, a link), `title`,
  `table`, `project`, `snippet` (a short excerpt of the first text field,
  other than the title, containing your first keyword) and `created_at`. It
  never returns whole rows: read one with `table` op:read `{table, ids}`.
- **Month, week and day phrases** in `query` filter rows by a date: `this/next/last month`,
  `a few months ago`, `3 months ago`, `in 2 months`, `in June`, `June 2027`,
  `next June`; `this/next/last week` (Monday to Sunday), `a few weeks ago`,
  `3 weeks ago`, `in 2 weeks`, `the next 2 weeks` / `the past week` (counted from
  today); `today`, `tomorrow`, `yesterday`, `3 days ago`, `a few days ago` (2 to 4 back),
  `in 2 days`, `in a few days`, `the next 5 days` / `the past 3 days`, `June 20`;
  `friday` (next one, today counts), `this/next/last friday`, `this/next/last weekend`;
  `this/next/last year`, `3 years ago`, `a few years ago`, `in 2 years`, `the past 2 years`,
  `in 2025`; `before/until June`, `by June`, `after June`, `since March` are
  open ranges (the nearest upcoming month, or the latest past one for `since`;
  the reply's `time.range` says which). A date field's name word ("due") picks
  that field, else any date field, else when the row was created. Soonest
  first (newest first for the past). Fillers are ignored; other words must
  still match. A **named** month (not an open range) also finds rows whose text
  says it; `found_by` is `date`, `text` or `both`. Limits: days are not
  parsed yet ("june 20" ignores the 20), and a capitalized month word ("March
  madness") starts a filter.
- `kinds: ["entry"]` cannot be combined with other kinds or `content_range`.
- Search by meaning is on by default for custom tables up to 10,000 rows; a
  person can turn it off per table, and a bigger table stays off until a person
  turns it on (`table` cannot). A table that grows past the cap keeps what is
  indexed but indexes no more rows until a person confirms; `semantic.note` says so. For the tables searched that have it on, `mode` (default
  `hybrid`) fuses the keyword ranking with the rows nearest the query in
  meaning, so "cat" can find "Feline care guide"; `mode: "keyword"` skips it and
  `mode: "semantic"` orders by meaning. Each result says `match`: `keyword`,
  `meaning` or `both`. The reply's `semantic` names the tables used and any
  still being indexed (keyword results are complete while one builds). A
  field filter keeps the search keyword-only.
