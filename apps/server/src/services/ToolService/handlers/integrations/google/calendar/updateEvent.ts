import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';
import { isoStamp } from '@snaglet/shared/utils';

interface UpdateEventInput {
  eventId?: string;
  calendarId?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  attendees?: string[];
}

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function isParsable(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function buildEndpoint(value: string, timeZone?: string): calendar_v3.Schema$EventDateTime {
  if (isDateOnly(value)) {
    return { date: value.trim() };
  }
  const point: calendar_v3.Schema$EventDateTime = { dateTime: isoStamp(value) };
  if (timeZone) point.timeZone = timeZone;
  return point;
}

const tool = async (input: UpdateEventInput, _context: ToolHandlerContext): Promise<string> => {
  const eventId = input.eventId?.trim();
  if (!eventId) {
    throw new Error('eventId is required');
  }

  const calendarId = input.calendarId?.trim() || 'primary';

  // start/end must be supplied together and share granularity when retiming.
  const hasStart = typeof input.start === 'string' && input.start.trim() !== '';
  const hasEnd = typeof input.end === 'string' && input.end.trim() !== '';
  if (hasStart !== hasEnd) {
    throw new Error('start and end must be provided together when retiming an event');
  }
  if (hasStart && hasEnd) {
    if (!isParsable(input.start as string)) {
      throw new Error('start must be a valid ISO 8601 date or date-time string');
    }
    if (!isParsable(input.end as string)) {
      throw new Error('end must be a valid ISO 8601 date or date-time string');
    }
    if (isDateOnly(input.start as string) !== isDateOnly(input.end as string)) {
      throw new Error(
        'start and end must use the same granularity (both dates or both date-times)'
      );
    }
  }

  const requestBody: calendar_v3.Schema$Event = {};
  if (typeof input.summary === 'string') requestBody.summary = input.summary.trim();
  if (typeof input.description === 'string') requestBody.description = input.description.trim();
  if (typeof input.location === 'string') requestBody.location = input.location.trim();
  if (hasStart && hasEnd) {
    requestBody.start = buildEndpoint(input.start as string, input.timeZone);
    requestBody.end = buildEndpoint(input.end as string, input.timeZone);
  }
  if (input.attendees && input.attendees.length > 0) {
    requestBody.attendees = input.attendees
      .map((email) => email.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
  }

  if (Object.keys(requestBody).length === 0) {
    throw new Error(
      'no fields to update; provide at least one of summary/description/location/start+end/attendees'
    );
  }

  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody,
    sendUpdates: requestBody.attendees ? 'all' : 'none',
  });

  return JSON.stringify({
    calendarId,
    eventId,
    updated: true,
    summary: res.data.summary ?? null,
    start: res.data.start?.dateTime ?? res.data.start?.date ?? null,
    end: res.data.end?.dateTime ?? res.data.end?.date ?? null,
    htmlLink: res.data.htmlLink ?? null,
  });
};

export default tool;
