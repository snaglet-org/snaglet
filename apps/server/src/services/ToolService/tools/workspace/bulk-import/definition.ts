import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'bulk_import',
  name: 'Bulk Import',
  description:
    'Import a nested workspace tree (the shape produced by `bulk_export`) under a target container. Each tree node is `{ kind: "container"|"doc", name|title, children?, content? }`. `mode: "create"` (default) fails if any name collides with an existing sibling; `mode: "merge"` reuses existing containers by name and updates docs whose title already exists. `dry_run: true` validates the import plan and reports what would happen without writing. Pairs with `bulk_export` for backup/restore and cloning across workspaces.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['workspace', 'import', 'bulk', 'tree', 'restore', 'clone', 'upsert', 'merge'],
  parameters_schema: {
    type: 'object',
    required: ['tree'],
    properties: {
      tree: {
        type: 'object',
        description:
          'Tree root. Either a container node `{ kind: "container", name, children }` or a single doc `{ kind: "doc", title, content }`. Top-level container nodes are imported AT the parent (their `name` is used); a special name `"<workspace>"` causes the children to be imported directly under the parent without creating a wrapper.',
      },
      parent_id: {
        type: 'string',
        description:
          'Direct id of the parent container to import under. Mutually exclusive with `parent_path`. Omit both for workspace root.',
      },
      parent_path: {
        type: 'string',
        description:
          'Slash-delimited path to the parent container. Mutually exclusive with `parent_id`.',
      },
      mode: {
        type: 'string',
        enum: ['create', 'merge'],
        default: 'create',
        description:
          '`create`: error on sibling name/title conflicts. `merge`: reuse existing containers by name and overwrite doc content for matching titles.',
      },
      dry_run: {
        type: 'boolean',
        default: false,
        description:
          'When true, validate the import plan and report planned actions without writing.',
      },
    },
  },
  sort_order: 11,
};

export default definition;
