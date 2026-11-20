import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'list_imessage_conversations',
  name: 'List iMessage Conversations',
  type: 'builtin',
  tier: 'standard',
  description:
    'List recent iMessage and SMS conversations from the macOS Messages app, ordered by most recent activity. Returns chat ID, participants, last message preview, and timestamp. Queries the local ~/Library/Messages/chat.db. Requires Full Disk Access.',
  keywords: ['imessage', 'sms', 'list', 'conversations', 'chats', 'messages', 'inbox'],
  parameters_schema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Maximum number of conversations to return. Defaults to 20.',
        default: 20,
      },
    },
    required: [],
  },
};

export default definition;
