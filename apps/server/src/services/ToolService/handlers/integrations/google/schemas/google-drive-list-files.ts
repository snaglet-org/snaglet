import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_list_files',
  name: 'Google Drive: List Files',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'files', 'list', 'folder', 'browse', 'contents'],
  description:
    'List the files and folders directly contained in a Google Drive folder. Read-only. ' +
    'When folderId is omitted, lists the contents of the user\'s root ("My Drive"). ' +
    "Distinct from search: this browses a folder's direct children without requiring a " +
    'query. Returns names, types, modification dates, owners, and direct links, with ' +
    'pagination. Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      folderId: {
        type: 'string',
        description:
          'ID of the folder to list. Omit to list the root of My Drive. Use the special value "root" for the root explicitly.',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of items to return (1-100). Defaults to 50.',
        minimum: 1,
        maximum: 100,
      },
      pageToken: {
        type: 'string',
        description:
          'Token for the next page of results, returned as nextPageToken from a prior call.',
      },
      orderBy: {
        type: 'string',
        description:
          'Sort order. Defaults to "folder,name" (folders first, then alphabetical). Allowed: folder,name, modifiedTime, modifiedTime desc, createdTime, createdTime desc, name, name desc, folder.',
      },
      includeTrashed: {
        type: 'boolean',
        description: 'Include trashed files. Defaults to false.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export default definition;
