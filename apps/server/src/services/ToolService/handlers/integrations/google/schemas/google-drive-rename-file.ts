import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_rename_file',
  name: 'Drive Rename File',
  description:
    'Rename a file or folder in Google Drive by setting a new name. Does not change the file content, location, or sharing.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'rename', 'file', 'folder', 'name'],
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file or folder to rename.',
      },
      name: {
        type: 'string',
        description: 'The new name for the file or folder.',
      },
    },
    required: ['fileId', 'name'],
  },
};

export default definition;
