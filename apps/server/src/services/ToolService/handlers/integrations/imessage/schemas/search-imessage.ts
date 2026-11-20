import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'search_imessage',
  name: 'Search iMessage',
  type: 'builtin',
  tier: 'standard',
  description:
    'Search message content across all iMessage and SMS conversations in the macOS Messages app. Performs a case-insensitive text search against the local ~/Library/Messages/chat.db. Returns matching messages with sender, timestamp, and conversation context. Requires Full Disk Access.',
  keywords: ['imessage', 'sms', 'search', 'find', 'messages', 'text', 'query'],
  parameters_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text to search for in message bodies.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return. Defaults to 20.',
        default: 20,
      },
    },
    required: ['query'],
  },
};

export default definition;
