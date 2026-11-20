# File

Local files on the host. One tool, six ops:

- `read`: a text file (`start_line`/`end_line` for a range), several files (`mode: 'multiple'`,
  `paths`), or an image (`mode: 'image'`, `path` or workspace image `id`).
- `list`: a directory (`mode: 'list'`, default), a name/glob search (`mode: 'find'`), or a
  repository tree (`mode: 'tree'`).
- `info`: type, size, timestamps and permissions for a path, without reading it.
- `create`: write `content` to `path`, creating or overwriting the file.
- `update`: change an existing file. Takes **exactly one** of:
  - `edits`: `[{old_text, new_text}]`, applied atomically; each `old_text` must match once.
    Prefer this.
  - `patch`: `*** Begin Patch` … `*** End Patch`, for multi-hunk or multi-file changes
    (`workdir` sets the base for relative paths).
  - `content`: a full rewrite of `path`. Use only when most of the file changes.
- `diff`: unified diff of `left` and `right` (each a path or raw text).

Path guards: allow/deny rules with a path specifier (for example `file_edit(/proj/**)`) bound
`create` and `update`. For a `patch`, every file the patch touches is checked.

These ids work as aliases: `file_read` → `read`, `file_list` → `list`,
`file_info` → `info`, `file_write` → `create`, `file_edit` → `update`, `apply_patch` →
`update` (`input` → `patch`), `diff_files` → `diff`.
