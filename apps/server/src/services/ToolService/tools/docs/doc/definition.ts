import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * doc(op) — core document CRUD, duplication, comparison, snapshots and conversion.
 *
 * Schema is flat (like `node`): each property says which op reads it. Each old
 * id is an op-pinned alias in toolAliases.ts, so an access rule naming one old
 * id covers exactly its op (allow: edit_doc never grants delete). Only delete
 * is confirm-gated, as delete_doc was.
 */
const definition: BuiltinToolDefinition = {
  id: 'doc',
  name: 'Doc',
  description:
    'Read, create, edit, duplicate, compare, snapshot or convert a markdown doc. ' +
    'op get: `id` or `path`; returns content with transclusions shown in place (3 levels, 200k characters at most), plus `created_by`/`last_edited_by`, `transclusions` and `transcluded_in` (may miss some); `raw:true` returns the stored source. ' +
    'op outline: the stored source\u2019s headings (not those of transcluded docs) as {level, text, line, anchor}, plus `total_lines`; read one block with `id` + `#L<line>-L<end>` or the anchor. ' +
    'op create: `title`, optional `content`, parent via `parent_id` (a container id) or `parent_path` (e.g. "/Snaglet/notes"); omit to use the calling thread\u2019s container. An unresolvable parent is an error, never root. A task can be a table row (`table` op `write`) and needs no doc of its own. ' +
    'op update: find/replace `edits` (atomic batch); to fill an empty doc use [{old_text: "", new_text: "..."}]. `old_text` matches the doc as get shows it: text inside a <transcluded-doc> tag edits that doc, a match touching a tag is refused; `raw:true` matches the stored source. Links [Title](kind:id) must point at real nodes \u2014 check unfamiliar ids with `node` (op get, `ids`) first. ' +
    'op delete: refused while other docs transclude or link to it unless `force:true`; `dry_run` lists them without deleting. ' +
    'op duplicate (a copy; references unchanged), diff (unified diff against older content or a snapshot), snapshot, list-snapshots, restore (snapshot_id; takes a safety snapshot first), delete-snapshot (snapshot_id; never the live doc), convert-to-container (a same-name container with the doc as overview; links and history survive; category:"project" makes a project). ' +
    'Their fields, and get/outline/update/create extras (raw, include_archived, validate_only, create_backup, allow_archived, sort_order), are not listed: tool({op:"schema", name:"doc"}) returns them as unlisted_parameters.',
  type: 'builtin',
  tier: 'core',
  // Per-op destructiveness: only delete is confirm-gated (delete_doc was destructive).
  destructiveOps: ['delete'],
  // Old ids stay findable via tool(op:search/schema); each is also an
  // op-pinned alias in toolAliases.ts.
  aliases: [
    'get_doc',
    'create_doc',
    'edit_doc',
    'delete_doc',
    'duplicate_doc',
    'diff_doc',
    'doc_history',
    'convert_doc_to_container',
    'workspace_duplicate_doc',
    'workspace_diff_doc',
    'workspace_convert_doc_to_container',
    'snapshot_doc',
    'list_doc_snapshots',
    'restore_snapshot',
    'delete_snapshot',
  ],
  keywords: [
    'workspace',
    'doc',
    'document',
    'folder',
    'markdown',
    'get',
    'read',
    'transclusion',
    'transclude',
    'create',
    'new doc',
    'edit',
    'update',
    'find replace',
    'delete',
    'remove',
    'duplicate',
    'clone',
    'copy',
    'diff',
    'compare',
    'snapshot',
    'history',
    'version',
    'restore',
    'revert',
    'backup',
    'convert',
    'graduate',
    'overview',
    'outline',
    'headings',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    properties: {
      op: {
        type: 'string',
        enum: [
          'get',
          'outline',
          'create',
          'update',
          'delete',
          'duplicate',
          'diff',
          'snapshot',
          'list-snapshots',
          'restore',
          'delete-snapshot',
          'convert-to-container',
        ],
      },
      id: {
        type: 'string',
        description:
          'All target ops: doc id (e.g. "doc-17831…"). get also takes a part link and returns only that part of the stored source: lines "doc-…#L12-L20" (#L12, #L12:5-L14:30) or a heading section "doc-…#h=rate-limits" (#h3= pins the level).',
      },
      path: {
        type: 'string',
        description: 'All target ops: instead of id, slash path like "/Projects/Snaglet/overview".',
      },
      title: { type: 'string', description: 'create: non-empty title, unique among siblings.' },
      content: { type: 'string', description: 'create: initial markdown (default "").' },
      parent_id: { type: 'string', description: 'create: parent container id.' },
      parent_path: { type: 'string', description: 'create: parent container path.' },
      edits: {
        type: 'array',
        description: 'update: find/replace operations, applied atomically.',
        items: {
          type: 'object',
          properties: {
            old_text: {
              type: 'string',
              description:
                'Text to find; "" only for the first write into an empty doc (rejected once it has content).',
            },
            new_text: { type: 'string', description: 'Replacement ("" deletes).' },
            context_before: { type: 'string', description: 'Disambiguate: text right before.' },
            context_after: { type: 'string', description: 'Disambiguate: text right after.' },
            occurrence: { type: 'number', description: 'Which match (1-based, -1 = all).' },
          },
          required: ['old_text', 'new_text'],
        },
      },
      force: {
        type: 'boolean',
        description: 'delete: delete even while other docs transclude or link to it.',
      },
      dry_run: { type: 'boolean', description: 'delete: report what would happen.' },
    },
  },
  // The rarer ops' fields and the get/create/update extras: accepted (tool.ts
  // checks fields against OP_FIELDS, never this schema) but not advertised, to
  // save tokens on every turn. tool(op:schema) returns them as
  // `unlisted_parameters`; TOOL.md lists them.
  unlisted_params: {
    include_archived: { type: 'boolean', description: 'get/outline: read an archived doc.' },
    raw: {
      type: 'boolean',
      description: 'get/update: the stored source, transclusions unexpanded (default false).',
    },
    sort_order: {
      type: 'number',
      description: 'create/duplicate: slot among sibling docs (duplicate accepts a finite number).',
    },
    validate_only: { type: 'boolean', description: 'update/restore: preview, write nothing.' },
    create_backup: { type: 'boolean', description: 'update: snapshot first (default true).' },
    allow_archived: {
      type: 'boolean',
      description: 'update/duplicate/snapshot: allow an archived doc.',
    },
    new_title: {
      type: 'string',
      description: 'duplicate: title for the copy. Defaults to "<source_title> (copy)" if omitted.',
    },
    target_container_id: {
      type: ['string', 'null'],
      description:
        "duplicate: optional container to place the copy in. Pass `null` for root. Defaults to the source's container. Mutually exclusive with `target_container_path`.",
    },
    target_container_path: {
      type: 'string',
      description:
        'duplicate: optional container path to place the copy in. Mutually exclusive with `target_container_id`.',
    },
    from_snapshot_id: {
      type: 'string',
      description:
        'diff: snapshot id to use as the "old" side. Mutually exclusive with `from_content`.',
    },
    to_snapshot_id: {
      type: 'string',
      description:
        'diff: optional second snapshot id to use as the "new" side instead of the doc\'s current content. Both snapshots must belong to the same doc.',
    },
    from_content: {
      type: 'string',
      description:
        'diff: raw content for the "old" side. Mutually exclusive with `from_snapshot_id`.',
    },
    context_lines: {
      type: 'number',
      description: 'diff: context lines around each hunk (default 3).',
    },
    max_diff_bytes: {
      type: 'number',
      description:
        'diff: if either side exceeds this many bytes, return a summary only (default 200000).',
    },
    label: {
      type: 'string',
      description:
        'snapshot: its label; list-snapshots: exact filter; restore: optional safety-snapshot label.',
    },
    reason: {
      type: 'string',
      description: 'snapshot: reason recorded with it.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 50,
      description: 'list-snapshots: maximum rows.',
    },
    include_content: {
      type: 'boolean',
      default: false,
      description: "list-snapshots: include each snapshot's full content.",
    },
    snapshot_id: {
      type: 'string',
      description: 'restore, delete-snapshot: the snapshot id (required).',
    },
    create_safety_snapshot: {
      type: 'boolean',
      default: true,
      description: 'restore: snapshot the current content first.',
    },
    category: {
      type: 'string',
      enum: ['project'],
      description:
        'convert-to-container: optional project category; omit for a non-project container.',
    },
  },
  // Alias parameter names work on doc itself. create's alias
  // container_id/container_path pass straight through to the create handler,
  // which rejects a conflicting pair.
  param_aliases: {
    id: ['doc_id'],
    path: ['doc_path'],
  },
  sort_order: 5,
};

export default definition;
