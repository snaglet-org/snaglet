import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_docs_append',
  name: 'Google Docs: Append Text',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'docs', 'document', 'append', 'add', 'insert', 'text', 'write'],
  description:
    'Append plain text to the end of an existing Google Doc. Provide the documentId and the ' +
    'text to add (include a leading newline if you want it on its own line). Returns the ' +
    'documentId, the index the text was inserted at, and how many characters were appended. ' +
    'Requires the workspace Google integration connected with the documents scope.',
  parameters_schema: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'The ID of the Google Doc to append to.',
      },
      text: {
        type: 'string',
        description:
          'The plain text to append at the end of the document. Include a leading \\n to start a new line.',
      },
    },
    required: ['documentId', 'text'],
    additionalProperties: false,
  },
};

export default definition;
