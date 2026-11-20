import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_calendar_search_events',
  name: 'Google Calendar: Search Events',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'calendar', 'search', 'find', 'events', 'meetings'],
  description:
    'Search calendar events by free-text query across all time (past and future), not ' +
    'just upcoming. Use this to locate a specific event by name/keyword when you do not ' +
    'know its date. Distinct from list_events, which browses an upcoming time window. ' +
    'Read-only. Returns matching events with start/end, location, and attendees. ' +
    'Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Required free-text search matched against event summary, description, ' +
          'location, and attendees.',
      },
      calendarId: {
        type: 'string',
        description: "Calendar to search. Defaults to the primary calendar ('primary').",
      },
      timeMin: {
        type: 'string',
        description:
          'Optional ISO 8601 lower bound for event start time. Omit to search all past events.',
      },
      timeMax: {
        type: 'string',
        description:
          'Optional ISO 8601 upper bound for event start time. Omit to search all future events.',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum number of events to return (1-100). Defaults to 25.',
        minimum: 1,
        maximum: 100,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export default definition;
