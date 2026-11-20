import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_reply',
  name: 'Gmail Reply',
  description:
    'Reply to an existing Gmail message. Sends the reply in the same thread as the original message.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'gmail', 'email', 'reply', 'respond', 'thread', 'mail'],
  parameters_schema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description:
          'The Gmail message ID to reply to. Get it from google_gmail operation "list", "search", or "get_message".',
      },
      body: {
        type: 'string',
        description: 'Plain-text body of the reply.',
      },
      replyAll: {
        type: 'boolean',
        description:
          'If true, reply to all recipients (To + Cc). Defaults to false (reply to sender only).',
      },
    },
    required: ['messageId', 'body'],
  },
};

export default definition;
