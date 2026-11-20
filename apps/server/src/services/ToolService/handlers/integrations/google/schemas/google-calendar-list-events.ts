import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_calendar_list_events',
  name: 'Google Calendar: List Events',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'calendar', 'events', 'schedule', 'agenda', 'meetings'],
  description:
    'List upcoming events from the connected Google Workspace calendar within an ' +
    'optional date range. Read-only. Returns event summaries with start/end times, ' +
    'location, and attendees. Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: "Calendar to query. Defaults to the primary calendar ('primary').",
      },
      timeMin: {
        type: 'string',
        description: 'ISO 8601 lower bound for event start time (inclusive). Defaults to now.',
      },
      timeMax: {
        type: 'string',
        description: 'ISO 8601 upper bound for event start time (exclusive). Optional.',
      },
      query: {
        type: 'string',
        description: 'Free-text search to filter events by summary/description. Optional.',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of events to return (1-100). Defaults to 25.',
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export default definition;
