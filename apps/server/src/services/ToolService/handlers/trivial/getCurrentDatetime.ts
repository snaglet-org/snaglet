import type { ToolHandler, ToolHandlerRichResult } from '@server/services/ToolService/types';

const toolHandler: ToolHandler = async (args) => {
  const params = (args ?? {}) as { timezone?: string };
  const now = new Date();

  const requested =
    params.timezone && params.timezone.trim().length > 0 ? params.timezone.trim() : null;
  const resolvedTimezone = requested ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Validate timezone. Intl throws RangeError for unknown IANA names.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: resolvedTimezone }).format(now);
  } catch {
    const result: ToolHandlerRichResult = {
      output: `Invalid timezone: '${resolvedTimezone}'. Use an IANA timezone name like 'America/Los_Angeles' or 'UTC'.`,
      rawContent: { error: 'invalid_timezone', requested: resolvedTimezone },
    };
    return result;
  }

  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimezone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: resolvedTimezone,
    weekday: 'long',
  });
  const dateOnlyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolvedTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const data = {
    iso: now.toISOString(),
    unix_ms: now.getTime(),
    unix_s: Math.floor(now.getTime() / 1000),
    timezone: resolvedTimezone,
    date: dateOnlyFormatter.format(now), // YYYY-MM-DD in resolved tz
    weekday: weekdayFormatter.format(now),
    human_date: dateFormatter.format(now),
    human_time: timeFormatter.format(now),
  };

  const result: ToolHandlerRichResult = {
    output: `${data.human_date} at ${data.human_time} (${data.timezone}) — ISO: ${data.iso}`,
    rawContent: data,
  };
  return result;
};

export default toolHandler;
