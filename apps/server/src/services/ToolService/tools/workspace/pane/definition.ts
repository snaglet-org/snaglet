import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

/**
 * pane(op): layout and navigate. The old ids get_user_pane_layout (layout) and
 * navigate_user_pane (navigate) are op-pinned aliases in toolAliases.ts.
 * Neither op is destructive.
 */
const definition: BuiltinToolDefinition = {
  id: 'pane',
  name: 'Pane',
  type: 'builtin',
  tier: 'core',
  sort_order: 910,
  aliases: ['get_user_pane_layout', 'navigate_user_pane'],
  description:
    "The user's split-pane UI. op layout: each pane's key, what it shows and its ratio, read live from the client; it is NOT in your context, so call it to see what the user is looking at. " +
    "op navigate: open a node in a pane. Default split keeps the user's chat visible; replace only a non-chat pane, or when asked.",
  keywords: [
    'ui',
    'pane',
    'layout',
    'split',
    'dashboard',
    'view',
    'navigate',
    'show',
    'open',
    'display',
  ],
  parameters_schema: {
    type: 'object' as const,
    properties: {
      op: { type: 'string', enum: ['layout', 'navigate'] },
      pane_key: {
        type: 'string',
        description:
          'navigate: a key from layout; split: the pane to split, replace: the pane to replace.',
      },
      mode: { type: 'string', enum: ['split', 'replace'], description: 'navigate; default split.' },
      split_zone: {
        type: 'string',
        enum: ['right', 'left', 'bottom', 'top'],
        description: 'navigate split: side for the new pane; default right.',
      },
      new_pane_ratio: {
        type: 'number',
        minimum: 0.15,
        maximum: 0.85,
        description: 'navigate split: new pane share, default 0.38 (0.3 = narrow side pane).',
      },
      target: {
        type: 'object',
        description: 'navigate: what to open.',
        properties: {
          kind: {
            type: 'string',
            enum: ['doc', 'thread', 'container', 'tool', 'image', 'providers'],
          },
          id: {
            type: 'string',
            description: 'The node id. Optional for providers (a provider id scrolls to it).',
          },
          agent_id: { type: 'string', description: 'thread only: the agent to focus.' },
        },
        required: ['kind'],
        additionalProperties: false,
      },
    },
    required: ['op'],
    additionalProperties: false,
  },
};

export default definition;
