import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_drive_advanced_search',
  name: 'Google Drive: Advanced Search',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: [
    'google',
    'drive',
    'search',
    'advanced',
    'filter',
    'mimetype',
    'date',
    'folder',
    'pagination',
  ],
  description:
    'Advanced search of the connected Google Workspace Drive. Read-only. Supports full-text ' +
    'or name-only matching, MIME-type filtering, parent-folder scoping, modified-date ranges, ' +
    'trashed toggle, result ordering, and pagination via nextPageToken. At least one filter is ' +
    'required. Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Text to match. By default searches full-text content; set searchScope to "name" to match file names only. For raw Drive query syntax, use rawQuery instead.',
      },
      rawQuery: {
        type: 'string',
        description:
          'Raw Drive API query expression passed through to files.list q untouched (e.g. "name = \'exact name\'", "starred = true", "sharedWithMe", or compound "a or b"). When set, query/searchScope/mimeType/parentFolderId/modified* structured filters are ignored; only trashed=false is AND-ed on unless includeTrashed is true. Use this when the structured filters cannot express your query.',
      },
      searchScope: {
        type: 'string',
        enum: ['content', 'name'],
        description:
          'Where to apply query: "content" (full-text, default) or "name" (file name only).',
      },
      mimeType: {
        type: 'string',
        description:
          'Optional MIME type filter. Common: "application/vnd.google-apps.document" (Docs), "application/vnd.google-apps.spreadsheet" (Sheets), "application/vnd.google-apps.folder", "application/pdf".',
      },
      parentFolderId: {
        type: 'string',
        description:
          'Optional Drive folder ID to restrict results to direct children of that folder.',
      },
      modifiedAfter: {
        type: 'string',
        description:
          'Only files modified after this RFC 3339 date (e.g. "2024-01-31" or "2024-01-31T00:00:00Z").',
      },
      modifiedBefore: {
        type: 'string',
        description: 'Only files modified before this RFC 3339 date.',
      },
      includeTrashed: {
        type: 'boolean',
        description: 'Include trashed files. Defaults to false.',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum files to return (1-100). Defaults to 20.',
        minimum: 1,
        maximum: 100,
      },
      pageToken: {
        type: 'string',
        description:
          'Pagination token from a previous response nextPageToken to fetch the next page.',
      },
      orderBy: {
        type: 'string',
        enum: [
          'modifiedTime',
          'modifiedTime desc',
          'createdTime',
          'createdTime desc',
          'name',
          'name desc',
        ],
        description: 'Result ordering. Defaults to "modifiedTime desc".',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export default definition;
