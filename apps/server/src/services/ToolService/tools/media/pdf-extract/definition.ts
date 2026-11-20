import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'pdf_extract',
  name: 'Extract PDF Text',
  description:
    'Extract text and optional document metadata from a local PDF path or downloadable PDF URL. Returns a JSON payload as a string.',
  type: 'builtin',
  tier: 'standard',
  keywords: ['pdf', 'extract', 'text', 'parse', 'read', 'document'],
  parameters_schema: {
    type: 'object',
    required: ['source'],
    properties: {
      pages: {
        type: 'string',
        description: 'Page range to extract, e.g. "1-5" or "1,3,7". Defaults to all pages.',
      },
      source: {
        type: 'string',
        description: 'Local file path or URL to the PDF',
      },
      includeMetadata: {
        type: 'boolean',
        default: true,
      },
    },
  },
  sort_order: 24,
};

export default definition;
