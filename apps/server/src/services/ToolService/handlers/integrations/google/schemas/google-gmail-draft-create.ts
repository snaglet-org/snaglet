import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_draft_create',
  name: 'Gmail Create Draft',
  description:
    'Create a draft email in Gmail without sending it. The draft will appear in the Drafts folder for review and manual sending later.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'gmail', 'email', 'draft', 'compose', 'write', 'mail'],
  parameters_schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: 'Recipient email address(es), comma-separated for multiple.',
      },
      subject: {
        type: 'string',
        description: 'Email subject line.',
      },
      body: {
        type: 'string',
        description: 'Plain-text body of the draft email.',
      },
      cc: {
        type: 'string',
        description: 'Cc recipients, comma-separated.',
      },
      bcc: {
        type: 'string',
        description: 'Bcc recipients, comma-separated.',
      },
      inReplyTo: {
        type: 'string',
        description:
          'Optional message ID to create the draft as a reply to. Threads the draft in the same conversation.',
      },
    },
    required: ['to', 'subject', 'body'],
  },
};

export default definition;
