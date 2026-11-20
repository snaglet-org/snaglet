import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'resolve_path',
  name: 'Resolve Path',
  description:
    'Resolve either a Snaglet workspace path or a filesystem path. domain:"workspace" (default) returns node identity and minimal metadata without loading content; domain:"filesystem" expands and normalizes an OS path and reports existence/type.',
  type: 'builtin',
  tier: 'core',
  keywords: ['path', 'resolve', 'workspace', 'filesystem', 'lookup', 'exists', 'absolute'],
  parameters_schema: {
    type: 'object',
    required: ['path'],
    properties: {
      domain: {
        type: 'string',
        enum: ['workspace', 'filesystem'],
        default: 'workspace',
      },
      path: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: ['doc', 'container'] },
      strict: { type: 'boolean', default: false },
      basePath: {
        type: 'string',
        description: 'Filesystem-only base path for relative input.',
      },
    },
  },
  sort_order: 6,
};

export default definition;
