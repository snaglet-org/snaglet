import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_delete',
  name: 'Gmail Delete',
  description:
    'Permanently delete one or more Gmail messages. This action is irreversible — the message is removed, not trashed.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  // Permanent, irreversible message deletion — panel confirm-gates it.
  destructive: true,
  keywords: ['google', 'gmail', 'email', 'delete', 'permanent', 'remove', 'destroy', 'mail'],
  parameters_schema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'The Gmail message ID to permanently delete.',
      },
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of Gmail message IDs to permanently delete in batch.',
      },
    },
  },
};

export default definition;
