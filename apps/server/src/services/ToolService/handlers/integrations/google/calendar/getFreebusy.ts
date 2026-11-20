import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';

interface GetFreeBusyInput {
  timeMin?: string;
  timeMax?: string;
  calendarIds?: string[];
}

/**
 * Queries the Google Calendar freebusy endpoint (calendar.freebusy.query) to return
 * busy intervals for one or more calendars within a time window. Read-only. Mirrors the
 * list-events sibling: credential boundary is getGoogleClient() (workspace seam), the
 * handler never touches credentials, and the result is a JSON.stringify envelope.
 */
function isIsoString(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

const tool = async (input: GetFreeBusyInput, _context: ToolHandlerContext): Promise<string> => {
  if (!input.timeMin || !input.timeMin.trim()) {
    throw new Error('timeMin is required (ISO 8601 date-time string)');
  }
  if (!input.timeMax || !input.timeMax.trim()) {
    throw new Error('timeMax is required (ISO 8601 date-time string)');
  }
  if (!isIsoString(input.timeMin)) {
    throw new Error('timeMin must be a valid ISO 8601 date-time string');
  }
  if (!isIsoString(input.timeMax)) {
    throw new Error('timeMax must be a valid ISO 8601 date-time string');
  }

  const calendarIds =
    Array.isArray(input.calendarIds) && input.calendarIds.length > 0
      ? input.calendarIds.map((id) => id.trim()).filter(Boolean)
      : ['primary'];

  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      items: calendarIds.map((id) => ({ id })),
    },
  });

  const calendars = res.data.calendars ?? {};
  const result = Object.entries(calendars).map(([id, cal]) => {
    const c = cal as calendar_v3.Schema$FreeBusyCalendar;
    return {
      calendarId: id,
      busy: (c.busy ?? []).map((b) => ({ start: b.start ?? null, end: b.end ?? null })),
      errors: (c.errors ?? []).map((e) => ({ domain: e.domain ?? null, reason: e.reason ?? null })),
    };
  });

  return JSON.stringify({
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    calendars: result,
  });
};

export default tool;
