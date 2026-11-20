# Doc

One core tool for markdown docs, including duplication, diffs, history and conversion.

**Tier:** core
**Type:** builtin

## Ops

| op        | does                                                         | replaces     |
| --------- | ------------------------------------------------------------ | ------------ |
| `get`     | read a doc by `id` or `path`, transclusions shown in place   | `get_doc`    |
| `outline` | the doc's headings with their lines and anchors              | —            |
| `create`  | new doc: `title`, `content`, `parent_id` / `parent_path`     | `create_doc` |
| `update`  | atomic find/replace `edits` (empty `old_text` = first write) | `edit_doc`   |
| `delete`  | delete (refused while transcluded unless `force`; `dry_run`) | `delete_doc` |

The tool names in the last column work as aliases that pin the op, and their
parameter names (`doc_id`, `doc_path`, create's `container_id` /
`container_path`) are accepted too. A field that belongs only to another op
(`edits` on a create, `force` on an update, …) is refused before anything
runs. Only `delete` is confirm-gated.

## Additional ops

| op                     | inputs and behavior                                                                                                                                                                                                   | legacy id                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `duplicate`            | `id` or `source_path`; optional `new_title`, `target_container_id` (null means root), `target_container_path`, `sort_order`, `allow_archived`. Keeps links and transclusions as written and rejects title collisions. | `duplicate_doc`                      |
| `diff`                 | `from_snapshot_id` or `from_content`, optional `to_snapshot_id`; `id` required unless both snapshots identify the doc. Optional `context_lines`, `max_diff_bytes`.                                                    | `diff_doc`                           |
| `snapshot`             | `id` or `path`; optional `label`, `reason`, `allow_archived`.                                                                                                                                                         | `doc_history {operation:'snapshot'}` |
| `list-snapshots`       | `id` or `path`; optional exact `label`, `limit`, `include_content`.                                                                                                                                                   | `doc_history {operation:'list'}`     |
| `restore`              | `snapshot_id`, optional defensive target `id`, `label`, `create_safety_snapshot`, `validate_only`. Takes a safety snapshot by default.                                                                                | `doc_history {operation:'restore'}`  |
| `delete-snapshot`      | `snapshot_id`, optional defensive target `id`. Permanently deletes only that snapshot, never the live doc.                                                                                                            | `doc_history {operation:'delete'}`   |
| `convert-to-container` | `id`, optional `category:'project'`. Creates a same-title container at the doc's placement and moves the original doc inside as overview; its id, content, links and history survive.                                 | `convert_doc_to_container`           |

### Fields not listed in the schema

To keep every turn small, the advertised schema lists only the fields of
`get`, `outline`, `create`, `update` and `delete`. The additional ops' fields above
(`new_title`, `target_container_id`, `target_container_path`,
`from_snapshot_id`, `to_snapshot_id`, `from_content`, `context_lines`,
`max_diff_bytes`, `label`, `reason`, `limit`, `include_content`,
`snapshot_id`, `create_safety_snapshot`, `category`) and the extras
`raw` (get, update), `include_archived` (get, outline), `sort_order` (create,
duplicate), `validate_only`, `create_backup` and `allow_archived` (update and
others) are left out. They
work exactly as described: pass them as normal fields.
`tool({op: "schema", name: "doc"})` returns their full schemas as
`unlisted_parameters`.

The ids in the last column (and workspace aliases) are aliases, callable with
their own parameter shapes. `doc_history` keeps its
required `operation` discriminator; its access rules cover only these four history
ops, never all of `doc`. The snapshot/list/restore/delete-snapshot aliases each pin their
individual op. Conflicting `op` input cannot redirect an alias.

For example: `doc {op:'restore', snapshot_id:'snapshot-…'}` or
`doc {op:'convert-to-container', id:'doc-…'}`.

The sections below are the references for each op. Where
they say `doc_id` / `doc_path`, `id` / `path` work too.

---

## op `get` (was `get_doc`)

### Description

Read a doc by `id` or `doc_path`. A transclusion, `![title](doc-id)`, shows
another doc's content in place, kept in sync. By default the content comes
back with each transclusion replaced, where it stands, by the transcluded
doc's content between tags:

```
<transcluded-doc id="doc-456" title="Goals">
…the content of doc-456…
</transcluded-doc>
```

- Transclusions inside transcluded docs expand the same way, three levels
  deep.
- A transclusion of part of a doc (`![](doc-456#h=launch)`,
  `![](doc-456#L3-L9)`) shows only that part and adds `part="h=launch"`.
- A target that can't be shown is one self-closing tag with no content:
  `missing="true"` (no such doc), `archived="true"`, `missing="part"` (the
  heading or lines are gone), `skipped="loop"` (the doc is already on the path
  from the doc you read, so expanding it would repeat forever) or
  `skipped="depth"` (a fourth level) or `skipped="size"` (the expanded text
  would pass 200,000 characters, about 50k tokens; the doc's own text is never
  cut). Markers count against that limit too: a run of them with only blank
  space between becomes one, `<transcluded-doc skipped="size" count="12"/>`,
  and past the limit a skipped transclusion keeps its own `![…](doc-…)` line.
- Titles are escaped (`&quot;`, `&lt;`, `&gt;`, `&amp;`), so a title can't end
  the attribute or the tag. Content is not escaped: it is the doc's own text.
  When a transcluded doc's text itself looks like a `<transcluded-doc>` tag,
  the read's `warnings` says so.

`raw: true` returns the stored source instead, with the `![title](doc-id)`
lines as written.

A part link as the `id` (`doc-…#L12-L20`, `doc-…#h=rate-limits`) returns only
that part, cut from the stored source: the line numbers links use are the
source's, so transclusions inside the part stay unexpanded. `lines` says what
was served.

### Parameters

- `id` (string, optional): the doc id, e.g. `doc-1111111111111-aaaaaaaaa`, or a
  part link. Legacy alias: `doc_id`.
- `doc_path` (string, optional): human-readable path (e.g.
  `/Projects/Snaglet/overview`).
- `raw` (boolean, optional): return the stored source. Default `false`.
- `include_archived` (boolean, optional): read an archived doc.

Either `id` or `doc_path` must be provided, but not both.

### Output

```typescript
{
  id: string;
  title: string;
  content: string; // transclusions shown in place, or the source with `raw`
  container_id: string | null;
  sort_order: number;
  created_by: string | null; // members.id of the creator (agent or user)
  last_edited_by: string | null; // members.id of the last title/content editor
  // Docs this doc transcludes directly, in order; omitted when none.
  transclusions?: Array<
    | { id: string; title: string }
    | { id: string; title: string; archived: true }
    | { id: string; missing: true }
  >;
  // Unarchived docs that transclude this one, the first 20 by title;
  // omitted when none, and on part reads. Read from the link index, which can
  // miss a transclusion whose label has escaped brackets, or one written
  // before this doc was archived and restored: treat it as "at least".
  transcluded_in?: Array<{ id: string; title: string }>;
  transcluded_in_total?: number; // when more than 20 do
}
```

A doc is never a task by itself: a task is a row in a Database table that may
link this doc for its prose through a `doc` relation field (read the row with
`table` op `read`). Task status, due date, assignee and priority live on that row,
not on the doc.

### Example

```json
{
  "id": "doc-123",
  "title": "Project Plan",
  "content": "# Project Plan\n\nGoals:\n<transcluded-doc id=\"doc-456\" title=\"Goals\">\n1. Launch by Q2\n</transcluded-doc>",
  "container_id": "container-xyz",
  "sort_order": 1,
  "created_by": "member-…",
  "last_edited_by": "member-…",
  "transclusions": [{ "id": "doc-456", "title": "Goals" }]
}
```

### Errors

- Not found, or archived without `include_archived`.
- Both or neither of `id` and `doc_path`.
- A path that does not resolve.

---

## op `outline`

The headings of a doc, to find a block before reading it. `id` or
`doc_path`, plus `include_archived` (an archived doc is not found without it,
as with `get`). A part link as the `id` outlines the whole doc.

```typescript
{
  id: string;
  title: string;
  total_lines: number; // lines in the stored source; 0 for an empty doc
  headings: Array<{
    level: number; // 1-6
    text: string; // inline markdown stripped
    line: number; // 1-indexed line in the stored source
    anchor: string; // "#h=setup", "#h3=setup" or "#h=usage-1"
  }>;
}
```

- Lines count the stored source, as `#L…` part reads and `search`'s
  `content_range` do: `doc-…#L13-L20` reads the block that starts at a heading
  on line 13.
- `anchor` is the fragment a heading link uses: `doc-…#h=usage-1` reads that
  heading's section. A repeated name gets `-1`, `-2`, … in document order; a
  name also used at another level pins its level (`#h3=setup`).
- Headings inside fenced code are not headings.
- A transcluded doc's headings are not in this doc's source, so they are not
  listed and add no lines: outline that doc to see them.

---

## op `create` (was `create_doc`)

### Overview

Create a new document in the workspace. Documents can contain markdown content and are organized within containers.

### Parameters

#### Required

- **title** (string): The title of the document

#### Optional

- **content** (string): The content of the document. Markdown is supported. Defaults to empty string if not provided.
- **parent_id** (string): The ID of the container to create the document in — the `container-<timestamp>-<random>` form, NOT a display name. If no parent is provided at all, the doc lands in the calling thread's container, or at root level. (Legacy alias: `container_id`.)
- **parent_path** (string): Alternative to `parent_id`. Slash-delimited path like `/Snaglet/docs` or `/Coding/Projects` (case-insensitive). A bare name (no slashes) matches a root-level container by name. Cannot be used with `parent_id`. (Legacy alias: `container_path`.)
- **sort_order** (integer): Display order within the container. Auto-assigned (max + 1) if not provided.

### Tasks are table rows, not docs

A task is a row in a Database table the user or agent defines (for example a `select` field for status, a `date` for due, a `relation` of kind `member` or `agent` for assignee) — write it with `table` op `write`. When a task needs prose, create a doc with this tool and link it from the row through a `relation` field of kind `doc`; the doc stays the title and Markdown body, the row holds the structured state. Changing a status is a field edit on the row, never a doc move.

### Parameter Resolution Rules

1. **Path vs Container ID**: You must provide either `parent_path` OR `parent_id` (or their legacy aliases `container_path` / `container_id`), not both
2. **Default location**: Provide neither to create in the calling thread's container (root for free-floating threads)
3. **Path Resolution**: Case-insensitive. `/snaglet/docs` matches a container named "Snaglet" with a child "docs"
4. **Loud failure**: A parent reference that is provided but does not resolve is an ERROR — the doc is never silently created at root. Look containers up with `workspace_tree` or `resolve_path` first
5. **Lenient keys**: A bare `container` / `parent` / `container_name` / `parent_name` key is tolerated and resolved as an id first, then as a path/name — but prefer the canonical `parent_id` / `parent_path`
6. **Sort Order**: Automatically incremented if omitted (finds max sort_order in target container + 1)

### Return Value

Returns JSON with:

- `success` (boolean): Whether the operation succeeded
- `doc` (object): The created document — `id`, `title`, `container_id`, `content`, `sort_order`, `created_at`, and `created_by` (the `members.id` of the acting agent/user, stamped automatically; not settable — a creation stamp is derived, never supplied)
- `link` (string): Markdown-formatted link to the document

### Examples

#### Create doc in a specific container by ID

```typescript
await create_doc({
  title: 'Architecture Notes',
  content: '# System Architecture\n\nKey design decisions...',
  container_id: 'container-1234567890-abcd1234',
});
```

#### Create doc using path

```typescript
await create_doc({
  title: 'Meeting Notes',
  content: '## Weekly Standup\n\n- Progress updates...',
  parent_path: '/Snaglet/docs',
});
```

#### Create doc at root level

```typescript
await create_doc({
  title: 'Quick Note',
  content: 'Some quick thoughts...',
  // No container_id or path = root level
});
```

#### Create empty doc (content optional)

```typescript
await create_doc({
  title: 'Placeholder',
  container_id: 'container-1234567890-abcd1234',
  // content defaults to empty string
});
```

#### Create doc with custom sort order

```typescript
await create_doc({
  title: 'Pinned Document',
  content: 'Important content',
  container_id: 'container-1234567890-abcd1234',
  sort_order: 1, // Will appear first
});
```

### Error Cases

- **Missing title**: Throws validation error
- **Both path and container_id provided**: Throws "Cannot specify both container_id and path"
- **Invalid path**: Throws "Container not found at path: {path}" plus lookup guidance
- **Invalid container_id**: Throws "Container not found: {container_id}" plus lookup guidance; when the value matches a container NAME, the error includes that container's real id
- **Unresolvable `container`/`parent` reference**: Throws, naming the value — the doc is never silently created at root
- **Conflicting parent references**: Throws when two parent keys carry different values

### Path Format

- Paths are slash-delimited: `/parent/child/grandchild`
- Leading slash is required for non-root paths
- Case-insensitive matching
- Each segment represents a container name
- Must resolve to an existing container hierarchy

### Notes

- Document IDs are auto-generated with format: `doc-{timestamp}-{nanoid}`
- Content supports full markdown syntax
- Documents created at root level have `container_id = null` in the database
- Sort order is scoped to the parent container (each container has independent ordering)

---

## op `update` (was `edit_doc`)

**Category:** workspace  
**Status:** Production Ready

### Overview

Edit workspace documents using token-efficient find/replace operations. Designed for AI coding agents to make precise, surgical edits without sending entire documents back and forth.

### Key Features

- ✅ **Token-efficient**: Send only the changes, not full documents
- ✅ **Batch edits**: Multiple replacements in one atomic transaction, across every doc they touch
- ✅ **Empty-doc first write**: Seed an empty document with `old_text: ""`
- ✅ **Smart disambiguation**: Handle duplicate text via `context` or `occurrence`
- ✅ **Edits follow transclusions**: Text you read inside `<transcluded-doc>` edits that doc
- ✅ **Transclusion checks**: A new `![](doc-xxx)` must name a real doc and may not close a loop
- ✅ **Preview mode**: Validate changes before applying
- ✅ **Auto-backup**: Safety net for rollbacks
- ✅ **Rich error messages**: Fuzzy matching suggestions when text not found

### Parameters

```typescript
{
  id?: string,               // Direct document ID (legacy alias: doc_id)
  doc_path?: string,         // Human-readable path (e.g., "/Projects/overview")
  edits: [
    {
      old_text: string,      // Text to find (empty = first write, empty docs only)
      new_text: string,      // Replacement (empty = delete)
      context_before?: string, // Text right before old_text, to disambiguate
      context_after?: string,  // Text right after old_text, to disambiguate
      occurrence?: number,   // Which match (1-indexed, -1 = all)
    }
  ],
  raw?: boolean,             // Match the stored source only (default: false)
  validate_only?: boolean,   // Preview without applying (default: false)
  create_backup?: boolean,   // Snapshot each changed doc first (default: true)
  allow_archived?: boolean   // Edit an archived doc (default: false)
}
```

### Which doc an edit changes

`old_text` is matched against the doc as `get` shows it, transclusions
expanded. The server records, while expanding, which doc owns every stretch of
that text and where it sits in that doc; an edit is routed by those positions,
never by reading tags back out of the text.

- **Text of the doc itself**: the doc is edited.
- **Text inside one `<transcluded-doc>`**: THAT doc is edited, with its own
  backup snapshot, `last_edited_by`, history and realtime events, as if it had
  been edited directly. Every doc that transcludes it shows the change. The
  result's `edited_docs` and `message` say so.
- **A match that touches a `<transcluded-doc>` tag** (or runs from one doc's
  text into another's): refused, naming the docs. Edit each doc separately, or
  pass `raw: true` to change the transclusion line itself.
- **A `![title](doc-id)` line**, which only the stored source holds: when
  `old_text` is not in the expanded text but is in the source, the source is
  edited. That adds, removes or retargets a transclusion. When `old_text` is
  shown inside a transcluded doc and also sits inside a transclusion line (a
  label, say), the line's match counts as another occurrence after the shown
  ones, so the edit is ambiguous and the error says to pass `raw: true` for
  the line itself; `occurrence: -1` changes only the shown matches.
- **Text a transcluded doc holds but this doc doesn't show** (the doc is
  archived, too deep, past the size limit, a loop, or shown only in part) can't
  match; the error names that doc and why it is hidden.
- **A part that an edit removes**: when a batch renames a heading or cuts the
  lines that a `![](doc-…#h=…)` or `#L…` transclusion shows, the result warns,
  for every doc that transcludes that part, that it now shows as missing.
- **The same text in several places**: the usual ambiguity rules apply over
  the expanded text (`occurrence`, `context_before`, `context_after`), and the
  error lists which doc each match is in. `occurrence` counts matches in
  reading order, as you read them: a doc transcluded twice shows its text
  twice and counts twice. Whether text is ambiguous depends on places, so the
  same text of a doc shown twice is one place and edits that doc once.
  `occurrence: -1` changes every place, each in the doc that owns it, and is
  refused if any match touches a tag.

`raw: true` matches the stored source only.

The batch is one transaction across every doc it changes: if any edit fails,
or any changed doc would transclude itself or a doc that transcludes it,
nothing is written. Nor is anything written when a doc the batch changes was
saved, archived or deleted by someone else after the edit read it: the error
says which, and reading the doc again and retrying applies the edit to the
newer text. `validate_only` reports the same routing without writing.

### Response

#### Success

```json
{
  "success": true,
  "doc_id": "doc-123",
  "edits_applied": [{ "index": 0, "doc_id": "doc-456", "occurrences_found": 1, "applied_at": 18 }],
  "edited_docs": [
    { "id": "doc-456", "title": "Shared terms", "transcluded_in": 2, "backup_id": "snap-…" }
  ],
  "message": "Edit 0 changed \"Shared terms\" (doc-456), not \"Contract\": that text belongs to the transcluded doc. It is transcluded in 2 docs, so the change shows in each.",
  "warnings": []
}
```

`edits_applied[].doc_id` is the doc each edit changed and `applied_at` the
offset in that doc's source. `edited_docs[].transcluded_in` counts the docs that
transclude it. `backup_id` (top level) is the addressed doc's own snapshot when
it was edited. A warning per changed doc lists transclusions added or removed:

```json
{
  "edit_index": -1,
  "doc_id": "doc-123",
  "message": "Transclusions changed: 1 added, 0 removed",
  "affected_docs": [{ "doc_id": "doc-789", "title": "Timeline", "action": "added" }]
}
```

#### Validation Mode

The same fields, written nothing, plus a preview per doc:

```json
{
  "preview": [
    { "doc_id": "doc-456", "title": "Shared terms", "old_content": "…", "new_content": "…" }
  ]
}
```

#### Error

```json
{
  "error": "Edit 0: text not found. Nearest real text in doc: \"Launch Q3…\""
}
```

### Usage Examples

#### Example 1: Simple Replace

```typescript
edit_doc({
  doc_path: '/Projects/2024/Timeline',
  edits: [
    {
      old_text: 'Launch Q2',
      new_text: 'Launch Q1',
    },
  ],
});
```

#### Example 2: Replace All Occurrences

```typescript
edit_doc({
  id: 'doc-123',
  edits: [
    {
      old_text: 'Q2',
      new_text: 'Q1',
      occurrence: -1, // Replace ALL instances
    },
  ],
});
```

#### Example 3: Disambiguate with Context

```typescript
// Document has "Q2" in multiple places
edit_doc({
  id: 'doc-123',
  edits: [
    {
      old_text: 'Q2',
      new_text: 'Q1',
      context: 'Launch timeline:\nQ2', // Only match near this text
    },
  ],
});
```

#### Example 4: Batch Edits

```typescript
edit_doc({
  doc_path: '/Projects/Budget',
  edits: [
    { old_text: '$50k', new_text: '$75k' },
    { old_text: 'Jan 2024', new_text: 'Feb 2024' },
    { old_text: 'pending', new_text: 'approved' },
  ],
});
```

#### Example 5: Preview Before Applying

```typescript
// Step 1: Preview
const preview = await edit_doc({
  id: "doc-123",
  edits: [...],
  validate_only: true
})

// Step 2: Review preview.changes

// Step 3: Apply if looks good
await edit_doc({
  id: "doc-123",
  edits: [...],
  validate_only: false
})
```

#### Example 6: Delete Text

```typescript
edit_doc({
  id: 'doc-123',
  edits: [
    {
      old_text: 'This section is outdated.\n',
      new_text: '', // Empty = delete
    },
  ],
});
```

#### Example 7: Write Initial Content into an Empty Document

```typescript
// The target document must currently be empty. On a non-empty document,
// anchor the edit with the exact existing text instead.
edit_doc({
  id: 'doc-123',
  edits: [
    {
      old_text: '',
      new_text: '# New Document\n\nInitial content.',
    },
  ],
});
```

#### Example 8: Retarget a Transclusion

```typescript
// The stored source holds the ![title](doc-id) line, so it is edited there.
doc({
  op: 'update',
  id: 'doc-123',
  edits: [{ old_text: '![](doc-deleted)', new_text: '![](doc-correct)' }],
});
// warnings: [{ message: "Transclusions changed: 1 added, 1 removed", ... }]
```

### Edit Types

| Operation         | `old_text`       | `new_text`        | `context`/`occurrence`      |
| ----------------- | ---------------- | ----------------- | --------------------------- |
| **Replace**       | "old value"      | "new value"       | Optional                    |
| **Delete**        | "text to remove" | "" (empty)        | Optional                    |
| **Initial write** | "" (empty)       | "initial content" | Only when doc is empty/NULL |
| **Replace All**   | "old value"      | "new value"       | `occurrence: -1`            |

For non-empty documents, use the exact existing text as `old_text` to anchor a find/replace edit.

### Disambiguation Strategies

#### Using `occurrence`

```typescript
// Document has "Q2" 3 times
{
  old_text: "Q2",
  new_text: "Q1",
  occurrence: 2  // Replace only the 2nd instance
}
```

#### Using `context`

```typescript
// Document has "budget" in Finance and Marketing sections
{
  old_text: "budget",
  new_text: "forecast",
  context: "## Finance"  // Only match near this heading
}
```

#### Replace All

```typescript
{
  old_text: "old",
  new_text: "new",
  occurrence: -1  // Replace ALL instances
}
```

### Transclusion checks

When a batch adds a `![](doc-xxx)` line, the tool:

1. **Fails** if the new target doc doesn't exist.
2. **Fails** if the change would make a doc transclude itself or any doc that
   transcludes it, directly or through a chain. The error names the chain:
   `Transclusion loop: "A" (doc-a) → "B" (doc-b) → "A" (doc-a)`.
3. **Warns** with the transclusions each changed doc gained or lost.

A loop already in stored data does not block edits that leave it as it is.

### Error Handling

#### Text Not Found

```json
{
  "error": "Edit 0 failed: text 'Launch Q2' not found in document. Did you mean: Launch, Q2024, Quarterly"
}
```

#### Ambiguous Match

```json
{
  "error": "Edit 0 failed: text 'Q2' appears 3 times. Specify 'occurrence' (1-3) or 'context' to disambiguate.\n\nMatches found:\n  1. Line 5: ...Launch Q2...\n  2. Line 12: ...Q2 goals...\n  3. Line 18: ...Q2 timeline..."
}
```

#### Invalid Occurrence

```json
{
  "error": "Edit 0 failed: occurrence 5 requested but text only appears 3 time(s)"
}
```

#### Empty `old_text` on a Non-Empty Document

An empty `old_text` is only valid for the initial write into a document whose content is empty or
`NULL`. To edit a non-empty document, use exact existing text as `old_text` to anchor the
find/replace operation.

```json
{
  "error": "Edit 0 failed: pure insert (empty old_text) is only supported on empty docs"
}
```

### Backup System

#### Auto-Backup (Default)

```typescript
edit_doc({
  id: "doc-123",
  edits: [...],
  create_backup: true  // Default
})

// Response includes backup ID for rollback:
// { "backup_id": "backup-1234567890-abc123" }
```

#### Skip Backup

```typescript
edit_doc({
  id: "doc-123",
  edits: [...],
  create_backup: false  // No backup created
})
```

### Edge Cases

#### Empty Edits Array

```typescript
// ❌ Error: At least one edit is required
edit_doc({
  id: 'doc-123',
  edits: [],
});
```

#### Both id and doc_path

```typescript
// ❌ Error: Cannot specify both id and doc_path
edit_doc({
  id: "doc-123",
  doc_path: "/Projects/Overview",
  edits: [...]
})
```

#### Neither id nor doc_path

```typescript
// ❌ Error: Must specify either id or doc_path
edit_doc({
  edits: [...]
})
```

#### Overlapping Edits

```typescript
// Edits applied in array order
edit_doc({
  id: 'doc-123',
  edits: [
    { old_text: 'Q2 2024', new_text: 'Q1 2024' }, // Applied first
    { old_text: 'Q2', new_text: 'Q1' }, // Applied second (may not find Q2 anymore)
  ],
});
```

**Best practice:** Order edits from most specific to least specific, or use `context` to avoid conflicts.

### Best Practices

#### 1. Use Preview Mode for Complex Edits

```typescript
// Always preview batch edits
const preview = await edit_doc({
  id: "doc-123",
  edits: [...multiple edits...],
  validate_only: true
})

if (preview.would_succeed) {
  // Review preview.changes
  await edit_doc({ ...same params..., validate_only: false })
}
```

#### 2. Disambiguate Explicitly

```typescript
// ✅ Good: Explicit disambiguation
edit_doc({
  edits: [{ old_text: 'Q2', new_text: 'Q1', occurrence: 1 }],
});

// ❌ Bad: Assumes only one match
edit_doc({
  edits: [{ old_text: 'Q2', new_text: 'Q1' }], // May fail if Q2 appears multiple times
});
```

#### 3. Order Edits Carefully

```typescript
// ✅ Good: Most specific first
edit_doc({
  edits: [
    { old_text: 'Launch Q2 2024', new_text: 'Launch Q1 2024' },
    { old_text: 'Q2', new_text: 'Q1', occurrence: -1 },
  ],
});
```

#### 4. Keep Backups Enabled

```typescript
// ✅ Good: Default backup enabled
edit_doc({ edits: [...] })

// ⚠️ Risky: No rollback option
edit_doc({ edits: [...], create_backup: false })
```

#### 5. Use Context for Semantic Matching

```typescript
// ✅ Good: Semantic context
edit_doc({
  edits: [
    {
      old_text: 'budget',
      new_text: 'forecast',
      context: '## Finance Section', // Clear intent
    },
  ],
});
```

### Implementation Notes

- **Atomic transactions**: All edits succeed or all fail, across every doc they change
- **Applied in order**: Edits in array order, each against the result of the ones before
- **Transclusion validation**: New targets must exist and may not close a loop
- **Fuzzy matching**: Suggests alternatives when text not found
- **Line tracking**: Position reported for each change
- **Unicode safe**: Handles special characters correctly

### See Also

- `get_doc` - Fetch document content
- `create_doc` - Create new documents
- `workspace_search` - Search across documents

---

## op `delete` (was `delete_doc`)

### Description

Delete a doc, refused while other docs transclude it or link to it.

**By default**, refuses to delete a doc that another doc transcludes
(`![](doc-xxx)`) or links to (`[title](doc-xxx)`, a `#L…` or `#h=…` part link
included), archived docs included; a reference inside code doesn't count.
The error and `dry_run` say which docs
transclude it and which only link to it. Pass `force: true` to delete anyway:
a transclusion then shows a `<transcluded-doc id="…" missing="true"/>` marker
and a link breaks; the response lists both.

Deleting a doc cascades to its `doc_snapshots` (FK `ON DELETE CASCADE`).

### Parameters

- `id` (string, optional) — legacy alias: `doc_id`
- `doc_path` (string, optional)
- `force` (boolean, default `false`) — delete even while other docs transclude or link to it
- `dry_run` (boolean, default `false`) — report what WOULD happen without deleting

Either `id` or `doc_path` must be provided, but not both.

### Output

```typescript
{
  success: true;
  doc_id: string;
  doc_title: string;
  deleted: boolean;          // false if dry_run
  dry_run: boolean;
  forced: boolean;
  transcluded_in: Array<{ id: string; title: string; archived?: true }>;
  linked_from: Array<{ id: string; title: string; archived?: true }>; // link only
  snapshots_deleted: number; // number of doc_snapshots rows cascaded
  warnings: string[];
}
```

### Behavior matrix

| transclude or link | force | dry_run | result                                          |
| -----------------: | :---- | :------ | :---------------------------------------------- |
|                  0 | any   | false   | DELETED                                         |
|                  0 | any   | true    | dry-run report, no delete                       |
|                 >0 | false | any     | THROWS — names which transclude and which link  |
|                 >0 | true  | false   | DELETED + a warning for each kind               |
|                 >0 | true  | true    | dry-run report listing those docs in the result |

### Errors

- **Document not found**: throws if `id` / `doc_path` does not resolve
- **Conflicting input**: throws if both `id` and `doc_path` are provided
- **Missing input**: throws if neither is provided
- **Refusing to delete "X" (...): of the other docs, N transclude it (…) and M only link to it (…)**:
  thrown when any doc refers to it and `force=false`

### Related tools

- `snapshot_doc` — capture state before deleting
- `doc` op `update` with `raw: true` — remove the transclusions and links first
- `doc` op `get` — `transcluded_in` lists the docs that transclude a doc
