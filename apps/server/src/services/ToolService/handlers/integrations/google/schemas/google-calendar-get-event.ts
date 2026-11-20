import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_calendar_get_event',
  name: 'Google Calendar: Get Event',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'calendar', 'event', 'get', 'fetch', 'details'],
  description:
    'Fetch a single event from the connected Google Workspace calendar by event id. ' +
    'Read-only. Returns full event detail including summary, start/end, location, ' +
    'status, organizer, and attendees. Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The id of the event to fetch (as returned by create/list).',
      },
      calendarId: {
        type: 'string',
        description: "Calendar the event lives on. Defaults to the primary calendar ('primary').",
      },
    },
    required: ['eventId'],
    additionalProperties: false,
  },
};

export default definition;
