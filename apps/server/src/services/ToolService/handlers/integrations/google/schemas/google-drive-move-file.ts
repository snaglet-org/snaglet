import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_move_file',
  name: 'Drive Move File',
  description:
    'Move a file in Google Drive to a different folder by changing its parents. Adds the destination folder and removes the current parent(s) unless removeParents is specified.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'move', 'file', 'folder', 'organize'],
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file to move.',
      },
      addParents: {
        type: 'string',
        description: 'The ID of the destination folder to move the file into.',
      },
      removeParents: {
        type: 'string',
        description:
          'Optional comma-separated parent folder IDs to remove. If omitted, all current parents are removed (a clean move).',
      },
    },
    required: ['fileId', 'addParents'],
  },
};

export default definition;
