import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_search',
  name: 'Gmail Search',
  description:
    'Search the authenticated Google account mailbox using Gmail query syntax (e.g. "from:foo@bar.com subject:report newer_than:7d"). Returns matching messages with headers and snippet.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'gmail', 'email', 'search', 'find', 'mail', 'messages'],
  parameters_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Gmail search query. Supports operators like from:, to:, subject:, has:attachment, newer_than:, is:unread, label:.',
      },
      maxResults: {
        type: 'number',
        description: 'Max messages to return (1-50, default 10).',
      },
    },
    required: ['query'],
  },
};

export default definition;
