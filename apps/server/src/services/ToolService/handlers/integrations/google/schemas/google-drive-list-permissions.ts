import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_list_permissions',
  name: 'Google Drive: List Permissions',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'permissions', 'list', 'access', 'sharing', 'file'],
  description:
    'List all permissions (access grants) on a file in the connected Google Workspace Drive. ' +
    'Returns each permission with its permissionId, type (user, group, domain, anyone), role ' +
    '(reader, writer, commenter, owner), and the grantee (emailAddress or domain) where ' +
    'available. Use this to audit who has access to a file and to retrieve the permissionId ' +
    'needed by google_drive_admin operation "revoke_permission". Supports shared drives and pages through all ' +
    'permissions. Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description:
          'The Drive file ID whose permissions to list. Obtain it from google_drive operation "search_files".',
      },
    },
    required: ['fileId'],
    additionalProperties: false,
  },
};

export default definition;
