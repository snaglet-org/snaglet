import type { BuiltinToolDefinition } from '@server/services/ToolService/types';

const definition: BuiltinToolDefinition = {
  id: 'google_calendar_list_calendars',
  name: 'Google Calendar: List Calendars',
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  keywords: ['google', 'calendar', 'calendars', 'list', 'calendarlist'],
  description:
    'List the calendars on the connected Google Workspace account (calendarList). ' +
    'Read-only. Returns each calendar id, name, time zone, access role, and whether ' +
    'it is the primary calendar. Use the returned id with the other calendar tools. ' +
    'Requires the workspace Google integration to be connected.',
  parameters_schema: {
    type: 'object',
    properties: {
      minAccessRole: {
        type: 'string',
        description:
          'Only return calendars where the user has at least this access role. One of: ' +
          'freeBusyReader, reader, writer, owner. Optional.',
        enum: ['freeBusyReader', 'reader', 'writer', 'owner'],
      },
      showHidden: {
        type: 'boolean',
        description: 'Whether to include hidden calendars in the result. Defaults to false.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

export default definition;
