import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'read_imessage',
  name: 'Read iMessage',
  type: 'builtin',
  tier: 'standard',
  description:
    'Read recent messages from a conversation in the macOS Messages app. Queries the local ~/Library/Messages/chat.db SQLite database. Returns messages in chronological order. Requires Full Disk Access granted to the Snaglet server process.',
  keywords: ['imessage', 'sms', 'text', 'read', 'messages', 'conversation', 'inbox'],
  parameters_schema: {
    type: 'object',
    properties: {
      contact: {
        type: 'string',
        description:
          'Phone number (+1XXXXXXXXXX) or email of the contact whose conversation you want to read.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of messages to return (newest first). Defaults to 25.',
        default: 25,
      },
    },
    required: ['contact'],
  },
};

export default definition;
