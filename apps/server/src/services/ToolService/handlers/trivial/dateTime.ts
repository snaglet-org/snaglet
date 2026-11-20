import type { ToolHandler } from '@server/services/ToolService/types';

function assertValidTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

const tool: ToolHandler = async (input) => {
  const timezone = String(input.timezone ?? 'UTC');
  assertValidTimezone(timezone);

  const locale = String(input.locale ?? 'en-US');
  const includeUnix = input.includeUnix !== false;
  const now = new Date();

  const formatted = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(now);

  const output: Record<string, unknown> = {
    iso: now.toISOString(),
    timezone,
    locale,
    formatted,
  };

  if (includeUnix) {
    output.unixMs = now.getTime();
    output.unixSeconds = Math.floor(now.getTime() / 1000);
  }

  return JSON.stringify(output, null, 2);
};

export default tool;
