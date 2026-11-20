import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface ListCalendarsInput {
  minAccessRole?: string;
  showHidden?: boolean;
}

/**
 * Lists the calendars on the connected Google Workspace account's calendar list
 * (calendarList.list). Read-only. Pages through all results via nextPageToken so the
 * caller never silently truncates. Credentials come from the workspace seam
 * getGoogleClient(); the handler never touches auth directly. Mirrors list-events.
 */
function formatCalendar(cal: calendar_v3.Schema$CalendarListEntry) {
  return {
    id: cal.id ?? null,
    summary: cal.summary ?? '(no name)',
    description: cal.description ?? null,
    timeZone: cal.timeZone ?? null,
    primary: Boolean(cal.primary),
    accessRole: cal.accessRole ?? null,
    selected: Boolean(cal.selected),
    backgroundColor: cal.backgroundColor ?? null,
  };
}

const VALID_ROLES = ['freeBusyReader', 'reader', 'writer', 'owner'];

const tool = async (input: ListCalendarsInput, _context: ToolHandlerContext): Promise<string> => {
  if (input.minAccessRole && !VALID_ROLES.includes(input.minAccessRole)) {
    throw new Error(`minAccessRole must be one of: ${VALID_ROLES.join(', ')}`);
  }

  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const calendars: ReturnType<typeof formatCalendar>[] = [];
  let pageToken: string | undefined;

  do {
    const res = await calendar.calendarList.list({
      minAccessRole: input.minAccessRole || undefined,
      showHidden: input.showHidden ?? undefined,
      maxResults: 250,
      pageToken,
    });
    for (const cal of res.data.items ?? []) {
      calendars.push(formatCalendar(cal));
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return JSON.stringify({
    count: calendars.length,
    calendars,
  });
};

export default tool;
