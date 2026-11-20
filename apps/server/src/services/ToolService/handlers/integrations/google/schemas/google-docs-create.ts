import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_docs_create',
  name: 'Google Docs: Create Document',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'docs', 'document', 'create', 'write', 'draft'],
  description:
    'Create a new Google Doc in the connected Google Workspace with a title and optional ' +
    'initial body text. Returns the document id and a direct link. Requires the workspace ' +
    'Google integration to be connected with Docs write access.',
  parameters_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Title of the new document.',
      },
      body: {
        type: 'string',
        description:
          'Optional initial body text inserted at the start of the document. Plain text; ' +
          'newlines are preserved.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export default definition;
