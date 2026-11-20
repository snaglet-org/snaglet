import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_list',
  name: 'Gmail List',
  description:
    'List Gmail messages with optional query and label filters. Returns each message hydrated with decoded from/subject/date headers, snippet, labels, plus pagination (nextPageToken). Subjects are RFC 2047-decoded so encoded-word subjects render as clean Unicode.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['gmail', 'email', 'list', 'inbox', 'messages', 'google'],
  parameters_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          "Gmail search query, same syntax as the Gmail search box (e.g. 'is:unread', 'from:alice subject:report').",
      },
      labelIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Filter to messages carrying ALL of these label ids (e.g. ['INBOX','UNREAD']).",
      },
      maxResults: {
        type: 'number',
        description: 'Max messages to return (1-100, default 25).',
      },
      pageToken: {
        type: 'string',
        description: 'Pagination token from a previous response (nextPageToken).',
      },
    },
    required: [],
  },
};

export default definition;
