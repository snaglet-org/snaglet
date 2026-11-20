import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'ocr_image',
  name: 'Extract Text from Image',
  description:
    'Extract text from a local image path or downloadable image URL using the macOS Vision OCR pipeline.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['ocr', 'image', 'extract', 'text', 'recognize', 'scan', 'vision'],
  parameters_schema: {
    type: 'object',
    required: ['source'],
    properties: {
      source: {
        type: 'string',
        description: 'Local file path or URL to the image',
      },
      language: {
        type: 'string',
        description: 'Expected language hint (e.g. en, ja, zh). Auto-detected if omitted.',
      },
      languages: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Optional list of OCR language hints',
      },
    },
  },
  sort_order: 32,
};

export default definition;
