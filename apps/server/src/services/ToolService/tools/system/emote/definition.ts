import { EMOTION_IDS } from '@snaglet/shared/cursor/emotions';
import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { AVATAR_EMOTES } from '@snaglet/shared/constants/agentCursor';
const definition: BuiltinToolDefinition = {
  id: 'emote',
  name: 'Emote',
  type: 'builtin',
  tier: 'standard',
  description:
    'Set an expression (neutral, happy, thinking, focused, curious, surprised, sleepy, worried, proud, stumped, angry, embarrassed, annoyed), alone or combined with a brief animation on your own avatar: spin, hyper, laugh, cry, celebrate or angry (angry = a quick side-to-side shake with the angry face). Visual only; no cursor claim or real input. First place your avatar with computer op:point. Optional reason is a public caption, not private reasoning.',
  keywords: ['avatar', 'animation', 'emote', 'spin', 'happy', 'laugh', 'cry', 'celebrate', 'angry'],
  parameters_schema: {
    type: 'object',
    anyOf: [{ required: ['animation'] }, { required: ['emotion'] }],
    additionalProperties: false,
    properties: {
      emotion: {
        type: 'string',
        enum: [...EMOTION_IDS],
        description: 'Existing expression; use alone or combine with animation',
      },
      animation: { type: 'string', enum: [...AVATAR_EMOTES] },
      reason: { type: 'string', maxLength: 200 },
    },
  },
};
export default definition;
