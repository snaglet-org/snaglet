import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'screenshot',
  name: 'Screenshot URL',
  description:
    'Capture a screenshot of a web page at a given URL (not the user\u2019s screen: use capture_user_screen).',
  type: 'builtin',
  tier: 'standard',
  keywords: ['screenshot', 'url', 'capture', 'page', 'image', 'web', 'render'],
  parameters_schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        description: 'The URL to screenshot',
      },
      width: {
        type: 'number',
        default: 1280,
        description: 'Viewport width in pixels',
      },
      height: {
        type: 'number',
        default: 800,
        description: 'Viewport height in pixels',
      },
    },
  },
  sort_order: 70,
};

export default definition;
