import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_docs_advanced_search',
  name: 'Google Docs: Advanced Search',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: [
    'google',
    'docs',
    'document',
    'search',
    'advanced',
    'fulltext',
    'filter',
    'date',
    'pagination',
  ],
  description:
    'Advanced search across the connected Google Workspace Docs. Read-only. Always scoped to ' +
    'Google Docs. Supports full-text content or name-only matching, parent-folder scoping, ' +
    'modified-date ranges, trashed toggle, ordering, and pagination via nextPageToken. ' +
    'Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Text to match. By default searches full-text document content; set searchScope to "name" to match document titles only.',
      },
      searchScope: {
        type: 'string',
        enum: ['content', 'name'],
        description: 'Where to apply query: "content" (full-text, default) or "name" (title only).',
      },
      parentFolderId: {
        type: 'string',
        description:
          'Optional Drive folder ID to restrict results to direct children of that folder.',
      },
      modifiedAfter: {
        type: 'string',
        description:
          'Only docs modified after this RFC 3339 date (e.g. "2024-01-31" or "2024-01-31T00:00:00Z").',
      },
      modifiedBefore: {
        type: 'string',
        description: 'Only docs modified before this RFC 3339 date.',
      },
      includeTrashed: {
        type: 'boolean',
        description: 'Include trashed documents. Defaults to false.',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum documents to return (1-100). Defaults to 20.',
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
