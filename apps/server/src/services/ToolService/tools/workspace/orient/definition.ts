import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'orient',
  name: 'Orient',
  description:
    'Re-orient in the current Snaglet workspace, or fetch approximate city-level IP location with mode:"local". Your live coordinates (location, thread, routing, project scope) are already in your turn context — do not call this just to re-confirm them. Use workspace mode for the recently-touched-nodes list or after moving scope mid-run.',
  type: 'builtin',
  tier: 'core',
  keywords: ['orient', 'workspace', 'scope', 'project', 'location', 'near me'],
  parameters_schema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['workspace', 'local'],
        default: 'workspace',
      },
      recent_limit: {
        type: 'number',
        minimum: 1,
        maximum: 20,
        default: 5,
      },
    },
  },
  sort_order: 1,
};

export default definition;
