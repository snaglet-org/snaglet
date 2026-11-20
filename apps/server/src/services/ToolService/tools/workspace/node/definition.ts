import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * node(op): get, tree, move, rename, archive and restore for workspace nodes.
 * Old ids map to ops: get_node and verify_ids (get), workspace_tree (tree),
 * move, rename, archive_node (archive), restore_node (restore). move and
 * rename are separate ops so each old id pins exactly one op and access rules
 * stay op-level (allow: move never grants a rename).
 *
 * Schema is flat (like `thread`): each property says which op reads it. Old
 * ids are op-pinned aliases in toolAliases.ts and map their parameter names
 * (new_parent_id → parent_id, new_title → title, node_id → id, …).
 * No op is confirm-gated: archive is reversible for 30 days.
 */
const definition: BuiltinToolDefinition = {
  id: 'node',
  name: 'Node',
  description:
    'Any workspace node (doc, container, thread, message, memory, image) by id. ' +
    'op get: one node (`id`) — type, placement, timestamps, title, a container\u2019s category and ' +
    'project facets; `include_children` lists a container\u2019s children (and a project\u2019s threads). ' +
    'Or batch-check `ids` (\u226420) exist before writing them anywhere: quote only ids it confirms. ' +
    'op tree: the workspace tree as ready-to-paste links (\ud83d\udcc2 container, \ud83d\udcc4 doc, \ud83d\udcac thread, ' +
    '\ud83d\uddc2\ufe0f project); scope with `id` (container), `path`, `name`, or `scope:"current_project"`. ' +
    'op move: `parent_id`/`parent_path` (null or "/" = root) and/or `sort_order`; a thread\u2019s ' +
    'parent is a project (null = flat). op rename: `title` (docs, containers and images; an image\u2019s stored file is renamed too). op archive: archive with its subtree (hidden, hard-deleted ' +
    'after 30 days); op restore undoes it, optionally into `parent_id`. ' +
    'kind, include_archived, allow_archived, update_inline_labels and validate_only are not listed: tool({op:"schema", name:"node"}) returns them as unlisted_parameters.',
  type: 'builtin',
  tier: 'core',
  destructiveOps: [],
  aliases: [
    'get_node',
    'verify_ids',
    'workspace_tree',
    'move',
    'rename',
    'archive_node',
    'restore_node',
  ],
  keywords: [
    'node',
    'get node',
    'node by id',
    'what is this id',
    'children',
    'verify',
    'exists',
    'integrity',
    'fabricated',
    'tree',
    'library',
    'browse',
    'navigate',
    'structure',
    'move',
    'reorganize',
    'reorder',
    'rename',
    'title',
    'archive',
    'trash',
    'soft delete',
    'restore',
    'unarchive',
    'undelete',
  ],
  parameters_schema: {
    type: 'object',
    required: ['op'],
    additionalProperties: false,
    properties: {
      op: { type: 'string', enum: ['get', 'tree', 'move', 'rename', 'archive', 'restore'] },
      id: {
        type: 'string',
        description:
          'Node id (tree: the container to scope to). move/rename/archive: or use `path`.',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 20,
        description:
          'get: batch existence check instead of `id`. Table ids (table-builtin-…, table-<13 digits>-…) report type `table`.',
      },
      path: {
        type: 'string',
        description: 'Slash path from root, e.g. "/Snaglet/docs". archive: containers only.',
      },
      include_children: { type: 'boolean', description: 'get: list direct children.' },
      name: { type: 'string', description: 'tree: scope by container name.' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['container', 'doc', 'thread'] },
        description: 'tree: node types to render (default all).',
      },
      scope: {
        type: 'string',
        enum: ['workspace', 'current_project'],
        description: 'tree: current_project = the nearest project above this thread.',
      },
      parent_id: {
        type: ['string', 'null'],
        description: 'move: new parent container (null = root/flat). restore: target container.',
      },
      parent_path: { type: 'string', description: 'move: new parent by path ("/" = root).' },
      sort_order: { type: 'number', description: 'move: slot among siblings (0 = top).' },
      title: { type: 'string', description: 'rename: new title (docs, containers and images).' },
    },
  },
  // Ambiguity hints and safety switches (kind, include_archived,
  // update_inline_labels, validate_only, allow_archived): accepted (the
  // handlers read input directly; nothing checks it against parameters_schema)
  // but not advertised, to save tokens on every turn. tool(op:schema) returns
  // them as `unlisted_parameters`; TOOL.md lists them.
  unlisted_params: {
    kind: {
      type: 'string',
      enum: ['doc', 'container', 'thread', 'node'],
      description:
        'move/rename: kind hint when a path is ambiguous. archive: container validates the id/path is one.',
    },
    include_archived: { type: 'boolean', description: 'get: return an archived node.' },
    update_inline_labels: {
      type: 'boolean',
      description: 'rename: rewrite inline link labels pointing at a renamed doc (default true).',
    },
    validate_only: {
      type: 'boolean',
      description: 'rename: report what would change, write nothing.',
    },
    allow_archived: { type: 'boolean', description: 'move/rename: allow an archived node.' },
  },
  // Alias parameter names work on node itself (the old ids also map them in
  // toolAliases.ts, including the op-specific container_id).
  param_aliases: {
    id: ['node_id'],
    parent_id: ['new_parent_id'],
    parent_path: ['new_parent_path'],
    title: ['new_title'],
  },
  sort_order: 1,
};

export default definition;
