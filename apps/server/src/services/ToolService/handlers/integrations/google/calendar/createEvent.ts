import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { ToolHandlerContext } from '@server/services/ToolService/types';
import { getGoogleClient } from '@server/integrations/google/getGoogleClient';
import { isoStamp } from '@snaglet/shared/utils';

interface CreateEventInput {
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

const tool = async (input: CreateEventInput, _context: ToolHandlerContext): Promise<string> => {
  const summary = input.summary?.trim();
  if (!summary) {
    throw new Error('summary is required');
  }
  if (!input.start || !isParsable(input.start)) {
    throw new Error('start must be a valid ISO 8601 date or date-time string');
  }
  if (!input.end || !isParsable(input.end)) {
    throw new Error('end must be a valid ISO 8601 date or date-time string');
  }
  if (isDateOnly(input.start) !== isDateOnly(input.end)) {
    throw new Error('start and end must use the same granularity (both dates or both date-times)');
  }

  const calendarId = input.calendarId?.trim() || 'primary';

  const requestBody: calendar_v3.Schema$Event = {
    summary,
    description: input.description?.trim() || undefined,
    location: input.location?.trim() || undefined,
    start: buildEndpoint(input.start, input.timeZone),
    end: buildEndpoint(input.end, input.timeZone),
  };

  if (input.attendees && input.attendees.length > 0) {
    requestBody.attendees = input.attendees
      .map((email) => email.trim())
      .filter(Boolean)
      .map((email) => ({ email }));
  }

  const auth = await getGoogleClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const res = await calendar.events.insert({
    calendarId,
    requestBody,
    sendUpdates: requestBody.attendees ? 'all' : 'none',
  });

  return JSON.stringify({
    calendarId,
    created: true,
    id: res.data.id ?? null,
    summary: res.data.summary ?? summary,
    start: res.data.start?.dateTime ?? res.data.start?.date ?? null,
    end: res.data.end?.dateTime ?? res.data.end?.date ?? null,
    htmlLink: res.data.htmlLink ?? null,
  });
};

export default tool;
