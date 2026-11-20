# Node

One tool for any workspace node by id: read it, browse the tree, move or
rename it, archive or restore it.

**Tier:** core
**Type:** builtin

## Ops

| op        | does                                                             | replaces                 |
| --------- | ---------------------------------------------------------------- | ------------------------ |
| `get`     | one node by `id`, or a batch existence check over `ids`          | `get_node`, `verify_ids` |
| `tree`    | the workspace tree as ready-to-paste links                       | `workspace_tree`         |
| `move`    | move (`parent_id` / `parent_path`) and/or reorder (`sort_order`) | `move`                   |
| `rename`  | new `title` for a doc, container or image                        | `rename`                 |
| `archive` | archive a node and its subtree (hard-deleted after 30 days)      | `archive_node`           |
| `restore` | undo an archive, optionally into `parent_id`                     | `restore_node`           |

The tool names in the last column work as aliases that pin the op, and their
parameter names (`node_id`, `new_parent_id`, `new_parent_path`, `new_title`,
restore's `container_id`, tree's `container_id`) are accepted too.

### Fields not listed in the schema

To keep every turn small, the advertised schema leaves out `kind` (move,
rename and archive: a kind hint, `doc`, `container`, `thread` or `node`, when
a path is ambiguous; archive with `container` checks the target is one),
`include_archived` (get: return an archived node), `allow_archived` (move,
rename: act on an archived node), and rename's `update_inline_labels` and
`validate_only` (below). Pass them as normal fields.
`tool({op: "schema", name: "node"})` returns their full schemas as
`unlisted_parameters`.

## move and rename

They are separate ops so each old tool name pins exactly one op: an access
rule naming `move` never covers a rename, and one naming `rename` never covers
a move.

- **move:** at least one of `parent_id`, `parent_path` or `sort_order`. The
  node must exist and be live, and the destination must be a live container
  (a project for a thread; `null` = root, or flat for a thread). Passing
  `title` is refused.
- **rename:** `title` for a doc, container or image; non-empty, and an
  unchanged title is a no-op. A doc or container's title must not clash with
  a sibling in its container; images may share a name. Renaming an image
  renames its stored file too (as `image_update_metadata(name)` does), and an
  image is addressed by `id`, not `path`. `update_inline_labels` (default
  true) rewrites link labels pointing at a renamed doc. `validate_only: true`
  reports what would change and writes nothing. Threads are renamed with
  `thread(op:"update")`; a thread is refused. Placement fields are refused.
- Each op checks everything before it writes anything.

## tree

Scope precedence: `id` (container) > `path` > `name`. `scope:"current_project"`
renders the nearest project above the current thread. `kinds` limits the
rendered types (`container`, `doc`, `thread`).

```
📂 [Snaglet](container-…)  · 1d ago  · 🗂️ project
├── 📂 [docs](container-…)  · 2h ago
│   └── 📄 [README](doc-…)  · just now · 164w
└── 💬 Threads
    └── 💬 [Auth refactor thread](thread-…)  · 30m ago
💬 Threads
└── 💬 [Quick question](thread-…)  · 2d ago

12 container(s), 47 doc(s), 8 thread(s)
```

Loose docs and flat threads render at the root when unscoped.
