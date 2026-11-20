# memory

Your long-term memory, owner-scoped (you only ever see and change your own).
Pick the operation with `op`:

- `search` — recall by relevance (vector + keyword). `query`, optional `limit`.
  Check here before asking the user for something you may already know.
- `create` — save a verified, durable, reusable fact. `content`, optional `key`;
  reusing a key updates that memory instead of duplicating it.
- `update` — change one existing memory. Target it with `memory_id` **or** `key`
  (exactly one), then `mode`:
  - `overwrite` — replace the content with `content`.
  - `append` — add `content` to the end, joined by `separator` (default newline).
  - `replace` — swap the literal `find` text for `replace_with` (first occurrence
    unless `all: true`). A `find` that is absent is an error, not a no-op.
    `update` never creates or blanks a memory.
- `delete` — remove by `memory_id`, or every memory whose key/content matches
  the substring `query`.

Old ids keep working as aliases pinned to one op: `memory_search`/`memory_recall`
→ search, `memory_save`/`memory_store` → create, `memory_edit` → update,
`memory_forget` → delete. Access rules naming an old id cover only that op.
