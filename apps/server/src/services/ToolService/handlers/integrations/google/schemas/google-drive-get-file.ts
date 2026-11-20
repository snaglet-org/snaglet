import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_get_file',
  name: 'Drive Get File',
  description:
    'Fetch metadata for a single Google Drive file by ID without running a search. ' +
    'Returns name, mimeType, size, parents, owners, timestamps, and links.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'file', 'metadata', 'get', 'fetch'],
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'Drive file ID (from google_drive operation "search_files").',
      },
      fields: {
        type: 'string',
        description:
          'Optional Drive fields selector to override the default field set ' +
          "(e.g. 'id, name, mimeType, parents').",
      },
    },
    required: ['fileId'],
  },
};

export default definition;
