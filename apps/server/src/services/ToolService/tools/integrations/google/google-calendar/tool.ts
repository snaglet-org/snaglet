import { createCapabilityRouter } from '@server/services/ToolService/lib/capabilityRouter';
import createEvent from '@server/services/ToolService/handlers/integrations/google/calendar/createEvent';
import deleteEvent from '@server/services/ToolService/handlers/integrations/google/calendar/deleteEvent';
import getEvent from '@server/services/ToolService/handlers/integrations/google/calendar/getEvent';
import getFreebusy from '@server/services/ToolService/handlers/integrations/google/calendar/getFreebusy';
import listCalendars from '@server/services/ToolService/handlers/integrations/google/calendar/listCalendars';
import listEvents from '@server/services/ToolService/handlers/integrations/google/calendar/listEvents';
import searchEvents from '@server/services/ToolService/handlers/integrations/google/calendar/searchEvents';
import updateEvent from '@server/services/ToolService/handlers/integrations/google/calendar/updateEvent';

export default createCapabilityRouter({
  create_event: createEvent,
  delete_event: deleteEvent,
  get_event: getEvent,
  get_freebusy: getFreebusy,
  list_calendars: listCalendars,
  list_events: listEvents,
  search_events: searchEvents,
  update_event: updateEvent,
});
