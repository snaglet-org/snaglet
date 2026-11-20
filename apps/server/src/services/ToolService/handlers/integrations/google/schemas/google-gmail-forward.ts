import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_forward',
  name: 'Gmail Forward',
  description:
    'Forward an existing Gmail message to one or more recipients with an optional note prepended to the original body.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'gmail', 'email', 'forward', 'fwd', 'send', 'mail'],
  parameters_schema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The Gmail message ID to forward.',
      },
      to: {
        type: 'string',
        description: 'Recipient email address(es), comma-separated for multiple.',
      },
      note: {
        type: 'string',
        description: 'Optional note to prepend above the forwarded message body.',
      },
    },
    required: ['messageId', 'to'],
  },
};

export default definition;
