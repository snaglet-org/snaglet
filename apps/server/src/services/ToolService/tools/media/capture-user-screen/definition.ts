import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'capture_user_screen',
  name: 'Capture User Screen',
  description:
    'Take one fresh, temporary frame from the exact screen or window selected by the user in the browser. Screen access must be active. Pixels are attached for this turn, never captured periodically, and deleted at turn end. Repeated calls in one turn reuse the single frame.',
  type: 'builtin',
  tier: 'core',
  contextRequirement: 'agent-required',
  keywords: ['screen', 'screenshot', 'capture', 'display', 'window', 'vision', 'desktop'],
  parameters_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  sort_order: 75,
};

export default definition;
