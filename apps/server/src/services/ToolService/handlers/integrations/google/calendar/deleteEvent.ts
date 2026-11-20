import { google } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface DeleteEventInput {
  eventId?: string;
  calendarId?: string;
  notifyAttendees?: boolean;
}

const tool = async (input: DeleteEventInput, _context: ToolHandlerContext): Promise<string> => {
  const eventId = input.eventId?.trim();
  if (!eventId) {
    throw new Error('eventId is required');
  }

  const calendarId = input.calendarId?.trim() || 'primary';

  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: 'v3', auth });

  await calendar.events.delete({
    calendarId,
    eventId,
    sendUpdates: input.notifyAttendees ? 'all' : 'none',
  });

  return JSON.stringify({
    calendarId,
    eventId,
    deleted: true,
  });
};

export default tool;
