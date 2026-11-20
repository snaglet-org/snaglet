import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import {
  buildFlatCapabilitySchema,
  describeOperationRequirements,
  type CapabilityOperation,
} from '@server/services/ToolService/lib/capabilitySchema';
import createEvent from '@server/services/ToolService/handlers/integrations/google/schemas/google-calendar-create-event';
import deleteEvent from '@server/services/ToolService/handlers/integrations/google/schemas/google-calendar-delete-event';
import getEvent from '@server/services/ToolService/handlers/integrations/google/schemas/google-calendar-get-event';
import getFreebusy from '@server/services/ToolService/handlers/integrations/google/schemas/google-calendar-get-freebusy';
import listCalendars from '@server/services/ToolService/handlers/integrations/google/schemas/google-calendar-list-calendars';
import listEvents from '@server/services/ToolService/handlers/integrations/google/schemas/google-calendar-list-events';
import searchEvents from '@server/services/ToolService/handlers/integrations/google/schemas/google-calendar-search-events';
import updateEvent from '@server/services/ToolService/handlers/integrations/google/schemas/google-calendar-update-event';

const operations = [
  { operation: 'create_event', definition: createEvent },
  { operation: 'delete_event', definition: deleteEvent },
  { operation: 'get_event', definition: getEvent },
  { operation: 'get_freebusy', definition: getFreebusy },
  { operation: 'list_calendars', definition: listCalendars },
  { operation: 'list_events', definition: listEvents },
  { operation: 'search_events', definition: searchEvents },
  { operation: 'update_event', definition: updateEvent },
] satisfies CapabilityOperation[];

const definition: BuiltinToolDefinition = {
  id: 'google_calendar',
  name: 'Google Calendar',
  description: `Google Calendar capability with a flat operation union. ${describeOperationRequirements(operations)}.`,
  type: 'builtin',
  providerId: 'google-workspace',
  tier: 'standard',
  destructive: true,
  keywords: ['google', 'calendar', 'event', 'schedule', 'freebusy', 'meeting'],
  parameters_schema: buildFlatCapabilitySchema(operations),
};

export default definition;
