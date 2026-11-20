import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_calendar_create_event',
  name: 'Google Calendar: Create Event',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'calendar', 'event', 'create', 'schedule', 'meeting', 'invite'],
  description:
    'Create an event on the connected Google Workspace calendar. Supports timed and ' +
    'all-day events, location, description, and attendee invitations. Returns the ' +
    'created event id and html link. Requires the workspace Google integration to be ' +
    'connected with calendar write access.',
  parameters_schema: {
    type: 'object',
    properties: {
      calendarId: {
        type: 'string',
        description: 'Calendar to create the event on. Defaults to the primary calendar.',
      },
      summary: {
        type: 'string',
        description: 'Event title/summary.',
      },
      description: {
        type: 'string',
        description: 'Optional event description / body.',
      },
      location: {
        type: 'string',
        description: 'Optional event location (free text).',
      },
      start: {
        type: 'string',
        description:
          'Event start. ISO 8601 date-time (e.g. "2025-06-01T14:00:00-07:00") for a timed event, ' +
          'or a date (e.g. "2025-06-01") for an all-day event.',
      },
      end: {
        type: 'string',
        description:
          'Event end. ISO 8601 date-time for a timed event, or a date for an all-day event. ' +
          'Must match the granularity of `start`.',
      },
      timeZone: {
        type: 'string',
        description:
          'IANA time zone for timed events (e.g. "America/Los_Angeles"). Optional; defaults to the calendar time zone.',
      },
      attendees: {
        type: 'array',
        description: 'Optional list of attendee email addresses to invite.',
        items: { type: 'string' },
      },
    },
    required: ['summary', 'start', 'end'],
    additionalProperties: false,
  },
};

export default definition;
