import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_trash',
  name: 'Gmail Trash',
  description:
    'Move one or more Gmail messages to trash by message ID. Messages in trash are automatically deleted after 30 days.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'gmail', 'email', 'trash', 'delete', 'remove', 'mail'],
  parameters_schema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description:
          'The Gmail message ID to trash. Get it from google_gmail operation "list", "search", or "get_message".',
      },
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Array of Gmail message IDs to trash in batch. Use this for bulk operations instead of calling the tool repeatedly.',
      },
    },
  },
};

export default definition;
