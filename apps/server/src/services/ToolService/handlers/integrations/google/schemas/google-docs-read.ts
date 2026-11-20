import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_docs_read',
  name: 'Google Docs: Read Document',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'docs', 'document', 'read', 'get', 'text', 'content'],
  description:
    'Read the plain text content of an existing Google Doc. Provide the documentId. Returns ' +
    'the document title, the extracted plain text content (paragraphs and table cells, in ' +
    'document order), and a charCount. Requires the workspace Google integration connected ' +
    'with the documents scope.',
  parameters_schema: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'The ID of the Google Doc to read.',
      },
    },
    required: ['documentId'],
    additionalProperties: false,
  },
};

export default definition;
