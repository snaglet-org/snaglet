import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_calendar_update_event',
  name: 'Google Calendar: Update Event',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'calendar', 'event', 'update', 'edit', 'reschedule', 'patch'],
  description:
    'Update an existing event on the connected Google Workspace calendar by event id. ' +
    'Only the fields you provide are changed (patch semantics). Supports retiming, ' +
    'retitling, relocating, and editing attendees. start/end must share the same ' +
    'granularity (both ISO date-times for timed, both YYYY-MM-DD for all-day). ' +
    'Requires the workspace Google integration connected with calendar write access.',
  parameters_schema: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The id of the event to update (as returned by create/list).',
      },
      calendarId: {
        type: 'string',
        description: 'Calendar the event lives on. Defaults to the primary calendar.',
      },
      summary: { type: 'string', description: 'New event title.' },
      description: { type: 'string', description: 'New event body.' },
      location: { type: 'string', description: 'New event location.' },
      start: {
        type: 'string',
        description:
          'New start. ISO date-time for timed events, or YYYY-MM-DD for all-day. ' +
          'If provided, end must also be provided with matching granularity.',
      },
      end: {
        type: 'string',
        description: 'New end. Same granularity as start.',
      },
      timeZone: {
        type: 'string',
        description:
          'IANA time zone (e.g. America/New_York) applied to timed start/end. ' +
          'Ignored for all-day events.',
      },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replacement attendee email list. Triggers update notifications.',
      },
    },
    required: ['eventId'],
    additionalProperties: false,
  },
};

export default definition;
