import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_send',
  name: 'Gmail Send',
  description:
    'Send an email from the authenticated Google account via the Gmail API. Constructs an RFC 822 message and submits it base64url-encoded.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'gmail', 'email', 'send', 'mail'],
  parameters_schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Recipient email address (comma-separate multiple).',
      },
      subject: {
        type: 'string',
        description: 'Email subject line.',
      },
      body: {
        type: 'string',
        description: 'Plain-text body of the email.',
      },
      cc: {
        type: 'string',
        description: 'Optional Cc recipients (comma-separated).',
      },
      bcc: {
        type: 'string',
        description: 'Optional Bcc recipients (comma-separated).',
      },
    },
    required: ['to', 'subject', 'body'],
  },
};

export default definition;
