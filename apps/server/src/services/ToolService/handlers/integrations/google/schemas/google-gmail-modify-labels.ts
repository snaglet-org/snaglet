import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_modify_labels',
  name: 'Gmail Modify Labels',
  description:
    'Add or remove labels on one or more Gmail messages. Use this to archive (remove INBOX), star (add STARRED), mark read (remove UNREAD), mark unread (add UNREAD), or apply/remove any custom label.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: [
    'google',
    'gmail',
    'email',
    'labels',
    'archive',
    'star',
    'unread',
    'read',
    'mark',
    'move',
    'categorize',
    'mail',
  ],
  parameters_schema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description: 'Single Gmail message ID to modify.',
      },
      messageIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of Gmail message IDs to modify in batch.',
      },
      addLabelIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Label IDs to add (e.g. "STARRED", "UNREAD", "IMPORTANT", or a custom label ID).',
      },
      removeLabelIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to remove (e.g. "INBOX" to archive, "UNREAD" to mark read).',
      },
    },
  },
};

export default definition;
