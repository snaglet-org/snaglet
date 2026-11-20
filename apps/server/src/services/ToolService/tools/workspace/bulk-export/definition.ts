import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'bulk_export',
  name: 'Bulk Export',
  description:
    'Walk a workspace subtree and dump it as a nested JSON structure. Each node is `{ kind: "container"|"doc", name, children? (containers), content? (docs) }`. Specify the root via `root_id`, `root_path`, or neither (full workspace export). Toggle `include_content` to omit doc bodies for lightweight catalog exports. Pairs with `bulk_import` for backup/restore and workspace cloning.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['workspace', 'export', 'bulk', 'tree', 'dump', 'backup', 'json', 'serialize'],
  parameters_schema: {
    type: 'object',
    properties: {
      root_id: {
        type: 'string',
        description:
          'Direct id of the root container to export. Use "" or omit for the workspace root. Mutually exclusive with `root_path`.',
      },
      root_path: {
        type: 'string',
        description:
          'Slash-delimited path to the root container, e.g. `/Snaglet/docs`. Mutually exclusive with `root_id`.',
      },
      include_content: {
        type: 'boolean',
        default: true,
        description:
          "Include each doc's `content` field. Disable for a lightweight tree-only catalog.",
      },
      max_nodes: {
        type: 'integer',
        minimum: 1,
        maximum: 10000,
        default: 2000,
        description:
          'Hard cap on total exported nodes (containers + docs). Excess marked via `truncated: true`.',
      },
    },
  },
  sort_order: 10,
};

export default definition;
