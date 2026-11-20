# clone_node

Copy/paste a workspace node with fresh ids — the agent-facing face of the
tree's Cmd/Ctrl+C → Cmd/Ctrl+V gesture. One tool call clones a node (and, for
containers, its whole subtree) and hands back the new root id, a ready-to-paste
link, and the total node count.

This tool calls the shared clone engine directly, so its behavior is identical
to the mouse gesture and the `POST /api/clone` route — there is exactly one
clone implementation.

## Per-kind semantics

- **doc** — content is copied verbatim. Links and transclusions pointing
  OUTSIDE the copy keep pointing at the originals (a single doc has nothing else in the copy
  to re-point to). The doc's own metadata columns carry over.
- **container** — the WHOLE subtree is cloned recursively (child docs and
  containers, each by its own kind rule, plus the threads scoped to any
  project in the subtree, which follow their cloned project), capped at
  **200 nodes** — an oversized subtree fails fast with a clear error and writes
  nothing. References between docs that both live INSIDE the copied subtree are
  re-pointed to their clones; references that leave the subtree stay on the
  originals. Project facets (`folder_path`, `github_url`, file indexing) are
  intentionally **not** cloned — a copy has no real project folder, so a cloned
  project container lands as a plain/uninitialized container instead of a second
  row pointing at the original's folder.
- **thread** — cloned **config-only**: a fresh, empty thread in the **same
  project** with the same title, dispatch config, thread- and per-participant
  system prompts/overrides, and the same participant set. Messages, memories,
  and summaries are **not** carried over. Agents are actors (not nodes) and are
  never cloned — participant rows keep pointing at the same principals.
  Threads attach to a project, not a non-project container, so `target_container_id` does not
  apply to them.

Other node kinds under a container (images, files) are skipped by the recursion.
Agents are never cloned.

Colliding titles get a ` (n)` suffix against the active same-kind siblings in
the target (e.g. `Plan` → `Plan (1)`). The whole clone is written in a single
transaction: a mid-write failure rolls the entire subtree back — the tree never
shows a half-cloned node.

## When to use

- Duplicate a whole container/project scaffold (its docs, sub-containers, and
  thread shapes) in one shot.
- Spin up a fresh thread with the same participants and config as an existing
  one, without carrying its history.
- Copy a doc as a sibling. For a single doc **with a custom title**, prefer
  `doc` (op `duplicate`) (it wraps this same engine and adds title/path resolution).

## Parameters

- `id` (string, required) — the node to clone (doc, container, or thread).
- `target_container_id` (string | null, optional) — where to paste:
  - **omit** → paste beside the original (into the source's own parent);
  - `null` or `""` → paste at the workspace root;
  - a container id → paste inside that container.
- `sort_order` (number, optional) — explicit position under the target;
  omitted → appended (max sibling `sort_order` + 1). A thread copy is a new
  thread: it starts at the top of its project's thread list (0) unless given
  a slot, and the threads at or after its slot shift down by one.
- `allow_archived` (boolean, default `false`) — allow an archived source.

## Returns

```json
{
  "success": true,
  "kind": "container",
  "node": {
    "id": "container-…",
    "title": "Auth refactor (1)",
    "container_id": "container-…",
    "sort_order": 3
  },
  "node_count": 7,
  "link": "[Auth refactor (1)](container-…)",
  "message": "Cloned container container-… → \"Auth refactor (1)\" (container-…); 7 node(s) created"
}
```
