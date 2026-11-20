import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'vision_mode',
  name: 'Vision Mode',
  description:
    "Grant or revoke on-demand visual access for the current chat thread. Starting Vision Mode never captures periodically: it only permits one fresh temporary frame when an agent semantically needs screen or camera context. Choose source='screen', 'camera', or 'both'. Unpromoted frames are deleted at turn end and the whole temporary session is deleted on stop.",
  type: 'builtin',
  tier: 'core',
  keywords: ['vision', 'screen share', 'camera', 'webcam', 'perception', 'start', 'stop', 'status'],
  aliases: ['vision_control', 'visual_mode'],
  parameters_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['start', 'stop', 'status'],
        description: 'Start, stop, or inspect vision mode for the current chat thread.',
      },
      source: {
        type: 'string',
        enum: ['screen', 'camera', 'both'],
        description: "Permitted on-demand source for action='start'. Defaults to screen.",
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  sort_order: 76,
};

export default definition;
