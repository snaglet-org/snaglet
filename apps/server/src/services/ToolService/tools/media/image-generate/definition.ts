import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'image_generate',
  name: 'Generate Image',
  description:
    'Generate an image from a text prompt using whichever image-capable provider is configured — OpenAI (gpt-image-1, DALL-E 3 fallback), Gemini (gemini-2.5-flash-image), or Together (FLUX). The image is filed into the active project\'s Images container (or root Images container for a flat thread) and attached inline to the result so you can SEE the output and iterate. Include the returned <image id="…"/> marker in your reply to show it to the user. Move the image after creation to place it elsewhere.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['image', 'generate', 'create', 'picture', 'art', 'visual', 'dalle', 'flux', 'gemini'],
  parameters_schema: {
    type: 'object',
    required: ['prompt'],
    properties: {
      prompt: {
        type: 'string',
        description: 'Text description of the image to generate',
      },
      provider: {
        enum: ['auto', 'openai', 'gemini', 'together'],
        type: 'string',
        default: 'auto',
        description:
          'Image provider. auto picks the first with a configured credential (openai → gemini → together).',
      },
      size: {
        enum: ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'],
        type: 'string',
        default: '1024x1024',
        description:
          'Requested dimensions — mapped to the nearest size each provider supports; Gemini chooses its own.',
      },
      style: {
        enum: ['natural', 'vivid'],
        type: 'string',
        default: 'vivid',
        description: 'Style hint (DALL-E 3 only; ignored elsewhere).',
      },
      container_id: {
        type: 'string',
        description:
          "Optional container selecting the enclosing project. Initial placement is always that project's Images container, or the root Images container without a project.",
      },
    },
  },
  sort_order: 20,
};

export default definition;
