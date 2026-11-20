import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_create_folder',
  name: 'Google Drive: Create Folder',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'folder', 'create', 'mkdir', 'directory'],
  description:
    'Create a new folder in the connected Google Workspace Drive. Provide a name and, ' +
    'optionally, a parentId to nest the folder under an existing folder (omit parentId to ' +
    'create it at the Drive root). Returns the created folderId, name, and webViewLink. ' +
    'Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'The name for the new folder.',
      },
      parentId: {
        type: 'string',
        description:
          'Optional. The Drive folder ID to create this folder inside. ' +
          'Obtain it from google_drive operation "search_files". Omit to create at the Drive root.',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export default definition;
