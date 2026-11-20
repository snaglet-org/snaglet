import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'get_current_datetime',
  name: 'Get Current Date & Time',
  description:
    'Current date and time (ISO 8601, weekday, human-readable, unix ms, timezone). You have no clock: call it before reasoning about "today", "now", deadlines or relative times.',
  type: 'builtin',
  tier: 'core',
  keywords: ['date', 'time', 'datetime', 'today', 'now', 'clock', 'timestamp', 'timezone'],
  aliases: ['now', 'today', 'current_time', 'current_datetime'],
  parameters_schema: {
    type: 'object',
    properties: {
      compat: {
        type: 'string',
        enum: ['standard', 'date_time'],
        default: 'standard',
        description: 'date_time: the legacy localized JSON shape',
      },
      timezone: {
        type: 'string',
        description: "IANA name, e.g. 'Europe/London'; default the server's zone",
      },
      locale: {
        type: 'string',
        default: 'en-US',
        description: 'date_time mode only',
      },
      includeUnix: {
        type: 'boolean',
        default: true,
        description: 'date_time mode only',
      },
    },
  },
};

export default definition;
