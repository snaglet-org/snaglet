import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_delete_file',
  name: 'Google Drive: Delete File',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  // Deletes Drive files (optionally hard-deleting past the trash) — panel
  // confirm-gates it.
  destructive: true,
  keywords: ['google', 'drive', 'delete', 'remove', 'trash', 'file', 'folder', 'cleanup'],
  description:
    'Delete a file or folder in the connected Google Workspace Drive by its file ID. ' +
    'By default the item is moved to the Drive trash (recoverable). Set permanent to true ' +
    'for an irreversible hard delete that bypasses the trash. Returns the fileId, the name ' +
    '(captured before removal when available), and whether the deletion was permanent. ' +
    'Obtain fileId from google_drive operation "search_files" or google_drive_admin operation "create_folder". ' +
    'Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description:
          'The Drive file or folder ID to delete. Obtain it from google_drive operation "search_files" ' +
          'or google_drive_admin operation "create_folder".',
      },
      permanent: {
        type: 'boolean',
        description:
          'Optional. When true, permanently deletes the item (irreversible, bypasses trash). ' +
          'When false or omitted, the item is moved to the Drive trash and can be recovered.',
      },
    },
    required: ['fileId'],
    additionalProperties: false,
  },
};

export default definition;
