import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_calendar_delete_event',
  name: 'Google Calendar: Delete Event',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  // Deletes a calendar event with no undo — panel confirm-gates it.
  destructive: true,
  keywords: ['google', 'calendar', 'event', 'delete', 'cancel', 'remove'],
  description:
    'Delete an event from the connected Google Workspace calendar by event id. ' +
    'Optionally notifies attendees of the cancellation. Returns confirmation of ' +
    'deletion. Requires the workspace Google integration to be connected with ' +
    'calendar write access.',
  parameters_schema: {
    type: 'object',
    properties: {
      eventId: {
        type: 'string',
        description: 'The id of the event to delete (as returned by create/list).',
      },
      calendarId: {
        type: 'string',
        description: 'Calendar the event lives on. Defaults to the primary calendar.',
      },
      notifyAttendees: {
        type: 'boolean',
        description: 'If true, sends cancellation notifications to attendees. Defaults to false.',
      },
    },
    required: ['eventId'],
    additionalProperties: false,
  },
};

export default definition;
