import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'check_imessage',
  name: 'Check iMessage Availability',
  type: 'builtin',
  tier: 'standard',
  description:
    'Check whether a phone number or email address is registered with iMessage (as opposed to SMS-only). Uses AppleScript to query the Messages.app service. Useful before sending to confirm the message will be sent as iMessage rather than SMS.',
  keywords: ['imessage', 'check', 'availability', 'registered', 'sms', 'apple'],
  parameters_schema: {
    type: 'object',
    properties: {
      contact: {
        type: 'string',
        description:
          'Phone number (+1XXXXXXXXXX) or email address to check for iMessage availability.',
      },
    },
    required: ['contact'],
  },
};

export default definition;
