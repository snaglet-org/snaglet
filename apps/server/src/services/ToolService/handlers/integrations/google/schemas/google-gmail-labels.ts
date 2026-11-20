import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_labels',
  name: 'Gmail Labels',
  description:
    'List all Gmail labels in the mailbox. Returns label IDs, names, types, and unread/total counts.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'gmail', 'email', 'labels', 'folders', 'categories', 'mail'],
  parameters_schema: {
    type: 'object',
    properties: {},
  },
};

export default definition;
