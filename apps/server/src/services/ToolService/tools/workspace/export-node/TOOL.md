# export_node

Write a workspace node to a real file on this computer.

## Not to be confused with `bulk_export`

They sound alike and both live under `workspace`:

- **`export_node`** (this tool) writes an actual **file to a folder on disk**, formatted for a
  person to open — markdown for docs/threads/memories, original bytes for images.
- **`bulk_export`** returns a **JSON tree as tool output**. Nothing is written to disk. It is the
  backup/clone counterpart to `bulk_import`.

If someone asks you to "save this to my Desktop", that is `export_node`.

## Kinds

| `kind`         | What lands on disk                                                       |
| -------------- | ------------------------------------------------------------------------ |
| `doc`          | `<title>.md` — YAML frontmatter, then the doc body verbatim              |
| `thread`       | `<title> (<threadId>).md` — one transcript, compaction boundaries inline |
| `image`        | the stored bytes, extension from the stored MIME type                    |
| `own_memories` | one `.md` holding every memory **you** have                              |

## `own_memories` is yours only

There is no `agent_id` parameter, and passing an `id` is an error. The agent whose memories get
exported is always the agent making the call. This is not a limitation to work around: memories are
owned per agent, and a tool that could name another agent would be a way to read someone else's.
If a user asks you to export a different agent's memories, tell them to do it from that agent's
settings in the app.

## The destination

`dest_dir` must be an **existing folder**, given as an absolute path, and outside Snaglet's own storage
(`~/.snaglet`). Symlinks are resolved before that check, so a link pointing into Snaglet storage is refused
too. Snaglet creates nothing — if the folder does not exist, the export fails rather than guessing.

## Files are never overwritten

A name collision produces `Notes (2).md`, not a replaced file. **Report `path` from the result, not
the name you asked for** — they differ whenever a collision happened, and a user told the wrong path
will not find their file.

`file_name` is optional and its extension is not authoritative: Snaglet sets the extension from the
content type. Asking for `notes.txt` on a doc produces `notes.md`.

## Threads

Default is every message. `message_limit` exports only the newest N; the file then declares itself
truncated in both the frontmatter and a visible banner, and compaction boundaries whose messages
fall outside the window are omitted rather than referenced. Prefer the default unless the user asks
for a slice or the thread is very large.
