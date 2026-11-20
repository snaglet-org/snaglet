import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'pdf_generate',
  name: 'Generate PDF',
  description:
    'Generate a PDF file from provided text content. HTML input is reduced to plain text before rendering.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['pdf', 'generate', 'create', 'document', 'export', 'report'],
  parameters_schema: {
    type: 'object',
    required: ['content', 'outputPath'],
    properties: {
      content: {
        type: 'string',
        description: 'HTML or Markdown content to render as PDF',
      },
      options: {
        type: 'object',
        description: 'Reserved for future renderer options. Currently ignored.',
      },
      outputPath: {
        type: 'string',
        description: 'Where to save the generated PDF',
      },
      contentType: {
        enum: ['html', 'markdown'],
        type: 'string',
        default: 'markdown',
        description:
          'Interpretation hint for the input content. HTML is converted to plain text before rendering.',
      },
    },
  },
  sort_order: 38,
};

export default definition;
