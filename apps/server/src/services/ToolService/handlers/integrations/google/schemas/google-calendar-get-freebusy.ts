import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_calendar_get_freebusy',
  name: 'Google Calendar: Get Free/Busy',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'calendar', 'freebusy', 'availability', 'busy', 'schedule', 'free'],
  description:
    'Query free/busy information for one or more Google Workspace calendars within a ' +
    'time window. Read-only. Returns the busy intervals for each calendar so you can ' +
    'determine availability. Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      timeMin: {
        type: 'string',
        description: 'ISO 8601 lower bound of the query window (inclusive). Required.',
      },
      timeMax: {
        type: 'string',
        description: 'ISO 8601 upper bound of the query window (exclusive). Required.',
      },
      calendarIds: {
        type: 'array',
        items: { type: 'string' },
        description: "Calendars to query. Defaults to ['primary'] if omitted.",
      },
    },
    required: ['timeMin', 'timeMax'],
    additionalProperties: false,
  },
};

export default definition;
