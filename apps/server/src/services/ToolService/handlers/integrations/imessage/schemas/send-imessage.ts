import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'send_imessage',
  name: 'Send iMessage',
  type: 'builtin',
  tier: 'standard',
  // Sends a real message to a real person — unrecallable side effect, panel
  // confirm-gates it.
  destructive: true,
  description:
    'Send an iMessage or SMS to a recipient via the macOS Messages app. Uses AppleScript to dispatch the message through Messages.app. The recipient can be a phone number (+1XXXXXXXXXX) or an email address registered with iMessage.',
  keywords: ['imessage', 'sms', 'text', 'message', 'send', 'apple', 'messages'],
  parameters_schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'The recipient phone number (e.g. +15551234567) or iMessage-registered email address.',
      },
      body: {
        type: 'string',
        description: 'The message body to send.',
      },
      service: {
        type: 'string',
        enum: ['iMessage', 'SMS'],
        description:
          'Force a specific service. Defaults to iMessage; falls back automatically if iMessage is unavailable.',
        default: 'iMessage',
      },
    },
    required: ['to', 'body'],
  },
};

export default definition;
