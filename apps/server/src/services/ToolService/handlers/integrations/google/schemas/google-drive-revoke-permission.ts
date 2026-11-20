import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_revoke_permission',
  name: 'Google Drive: Revoke Permission',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'permission', 'revoke', 'remove', 'unshare', 'access', 'file'],
  description:
    'Revoke a single access grant on a file in the connected Google Workspace Drive by deleting ' +
    'a permission. Provide the fileId and the permissionId (obtain it from ' +
    'google_drive operation "list_permissions" or from google_drive_admin operation "share_file"). ' +
    'This removes that grantee\u2019s access. Owner permissions cannot be revoked this way (the ' +
    'Drive API rejects deleting an owner). Supports shared drives. Requires the workspace ' +
    'Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description:
          'The Drive file ID the permission belongs to. Obtain it from google_drive operation "search_files".',
      },
      permissionId: {
        type: 'string',
        description:
          'The ID of the permission to revoke. Obtain it from google_drive operation "list_permissions" or google_drive_admin operation "share_file".',
      },
    },
    required: ['fileId', 'permissionId'],
    additionalProperties: false,
  },
};

export default definition;
