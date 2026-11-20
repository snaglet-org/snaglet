import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_search_files',
  name: 'Google Drive: Search Files',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'drive', 'files', 'search', 'documents', 'folders'],
  description:
    'Search the connected Google Workspace Drive for files and folders. Read-only. ' +
    'Returns file names, types, modification dates, owners, and direct links. Supports ' +
    'full-text search and optional MIME-type filtering. Requires the workspace Google ' +
    'integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Search query. Searches file names and full-text content. Examples: "meeting notes", "Q4 budget".',
      },
      mimeType: {
        type: 'string',
        description:
          'Optional MIME type filter. Common values: "application/vnd.google-apps.document" (Docs), "application/vnd.google-apps.spreadsheet" (Sheets), "application/vnd.google-apps.presentation" (Slides), "application/pdf", "application/vnd.google-apps.folder".',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of files to return (1-50). Defaults to 20.',
        minimum: 1,
        maximum: 50,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export default definition;
