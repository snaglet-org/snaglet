import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_gmail_get_message',
  name: 'Gmail Get Message',
  description:
    'Fetch a single Gmail message by its id. Returns decoded headers (from/to/subject/date), labels, snippet, and the plain-text body. Subjects are RFC 2047-decoded so encoded-word subjects render as clean Unicode.',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['gmail', 'email', 'message', 'get', 'fetch', 'read', 'google'],
  parameters_schema: {
    type: 'object',
    properties: {
      messageId: {
        type: 'string',
        description:
          'The Gmail message id to fetch (for example, from google_gmail operation "search").',
      },
      format: {
        type: 'string',
        enum: ['full', 'metadata', 'minimal'],
        description:
          "Detail level. 'full' (default) includes the decoded body; 'metadata' headers only; 'minimal' ids/labels only.",
      },
    },
    required: ['messageId'],
  },
};

export default definition;
