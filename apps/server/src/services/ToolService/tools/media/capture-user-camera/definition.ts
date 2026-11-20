import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'capture_user_camera',
  name: 'Capture User Camera',
  description:
    'Take one fresh, temporary camera frame only when the current request needs visual context and camera access is active. Pixels are attached for this turn, never captured periodically, and deleted at turn end unless the user explicitly asks to promote them. Repeated calls in one turn reuse the single frame.',
  type: 'builtin',
  tier: 'core',
  contextRequirement: 'agent-required',
  keywords: ['camera', 'webcam', 'vision', 'frame', 'capture', 'on demand'],
  parameters_schema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  sort_order: 76,
};

export default definition;
