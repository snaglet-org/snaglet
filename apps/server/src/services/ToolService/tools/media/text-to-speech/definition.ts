import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'text_to_speech',
  name: 'Text to Speech',
  description:
    'Convert text into spoken audio with OpenAI text-to-speech. Saves audio to outputPath when provided, otherwise returns base64 audio data.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['speech', 'tts', 'audio', 'voice', 'speak', 'sound'],
  parameters_schema: {
    type: 'object',
    required: ['text'],
    properties: {
      text: {
        type: 'string',
        description: 'Text to convert to speech',
      },
      speed: {
        type: 'number',
        default: 1,
        maximum: 4,
        minimum: 0.25,
      },
      voice: {
        enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
        type: 'string',
        default: 'nova',
      },
      format: {
        enum: ['mp3', 'opus', 'aac', 'flac'],
        type: 'string',
        default: 'mp3',
      },
      outputPath: {
        type: 'string',
        description: 'Optional file path to save the generated audio',
      },
    },
  },
  sort_order: 25,
};

export default definition;
