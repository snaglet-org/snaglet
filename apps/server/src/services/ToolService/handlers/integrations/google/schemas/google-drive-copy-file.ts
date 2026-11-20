import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_copy_file',
  name: 'Google Drive: Copy File',
  description:
    'Creates a copy of a file in Google Drive. Optionally set a new name and/or destination folder for the copy.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'file', 'copy', 'duplicate'],
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description: 'The ID of the file to copy.',
      },
      name: {
        type: 'string',
        description: 'Optional name for the new copy. Defaults to "Copy of <original>".',
      },
      parentFolderId: {
        type: 'string',
        description:
          'Optional destination folder ID for the copy. Defaults to the source file location.',
      },
    },
    required: ['fileId'],
  },
};

export default definition;
