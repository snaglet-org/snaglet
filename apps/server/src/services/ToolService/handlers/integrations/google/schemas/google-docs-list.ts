import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_docs_list',
  name: 'Google Docs: List Documents',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'docs', 'documents', 'list', 'drive'],
  description:
    'List Google Docs documents in the connected Google Workspace Drive. Read-only. ' +
    'Returns document names, ids, created/modified dates, owners, and direct links, ' +
    'most recently modified first. Optional full-text query narrows the results. ' +
    'Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Optional full-text search to narrow results. Searches document names and content. Omit to list all Docs.',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of documents to return (1-50). Defaults to 20.',
        minimum: 1,
        maximum: 50,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export default definition;
