import {
  parseTableDateTime,
  tableDateTimeLocalDate,
  tableDateTimeToUtc,
  userTimeZone,
} from '@snaglet/shared/utils';

/** Native datetime-local controls accept milliseconds, while stored values can keep microseconds. */
export function toDateTimeInput(
  value: string | null | undefined,
  timeZone = userTimeZone()
): string {
  if (!value) return '';
  const parsed = parseTableDateTime(value);
  const utc = parsed && tableDateTimeToUtc(value, timeZone);
  if (!parsed || !utc) return '';
  const date = tableDateTimeLocalDate(value, timeZone);
  if (!date || date.length !== 10) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(utc))
      .map((part) => [part.type, part.value])
  );
  const fraction = parsed.micros.slice(0, 3).replace(/0+$/, '');
  const seconds =
    parts.second === '00' && !fraction ? '' : `:${parts.second}${fraction ? `.${fraction}` : ''}`;
  return `${date}T${parts.hour}:${parts.minute}${seconds}`;
}

/** Preserve untouched precision (and an overlap's original offset) until the wall time changes. */
export function fromDateTimeInput(
  value: string,
  currentValue: string | null | undefined,
  timeZone = userTimeZone()
): string | null {
  if (!value.trim()) return null;
  const utc = tableDateTimeToUtc(value, timeZone);
  if (!utc) return value;
  if (currentValue) {
    const displayed = toDateTimeInput(currentValue, timeZone);
    if (displayed && tableDateTimeToUtc(displayed, timeZone) === utc) return currentValue;
  }
  return utc;
}
