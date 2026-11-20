import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_share_file',
  name: 'Google Drive: Share File',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'share', 'permission', 'grant', 'access', 'file'],
  description:
    'Grant access to a file in the connected Google Workspace Drive by creating a permission. ' +
    'Specify the role (reader, writer, commenter, owner) and the grantee type (user, group, ' +
    'domain, anyone). For user/group grants provide emailAddress; for domain grants provide ' +
    'domain. Returns the created permissionId — keep it to revoke access later via the Drive ' +
    'permissions API. A notification email is sent for user/group grants unless ' +
    'sendNotificationEmail is set to false (it is always off for type "anyone"). Also returns ' +
    'shareLink (the file’s webViewLink) when available. Requires the workspace Google ' +
    'integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      fileId: {
        type: 'string',
        description:
          'The Drive file ID to share. Obtain it from google_drive operation "search_files".',
      },
      role: {
        type: 'string',
        enum: ['reader', 'writer', 'commenter', 'owner'],
        description: 'The access level to grant. Defaults to "reader".',
      },
      type: {
        type: 'string',
        enum: ['user', 'group', 'domain', 'anyone'],
        description:
          'The grantee scope. "user"/"group" require emailAddress; "domain" requires domain; ' +
          '"anyone" makes the file accessible to anyone with the link. Defaults to "user".',
      },
      emailAddress: {
        type: 'string',
        description:
          'Email address of the user or group to share with. Required when type is "user" or "group".',
      },
      domain: {
        type: 'string',
        description: 'Domain to share with (e.g. "example.com"). Required when type is "domain".',
      },
      sendNotificationEmail: {
        type: 'boolean',
        description:
          'Optional. Whether Google sends a notification email to the grantee. Defaults to true ' +
          'for user/group grants; always false for type "anyone".',
      },
    },
    required: ['fileId'],
    additionalProperties: false,
  },
};

export default definition;
