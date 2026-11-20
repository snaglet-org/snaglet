import { describe, expect, it, vi } from 'vitest';

vi.mock('./calendarApi', () => ({ calendarApi: {} }));
vi.mock('@desktop/utils/toast', () => ({ showToast: vi.fn(), dismissToast: vi.fn() }));

import { withEndTime } from './eventActions';

const NY = 'America/New_York'; // EDT (UTC-4) through Oct 2026

function timed(startAt: string, endAt: string) {
  return { kind: 'timed' as const, startAt, endAt, timeZone: NY };
}

describe('withEndTime', () => {
  // Mon Oct 12 09:00 → Wed Oct 14 10:00, New York.
  const offsite = timed('2026-10-12T13:00:00.000Z', '2026-10-14T14:00:00.000Z');

  it("keeps a multi-day event's end on its own day", () => {
    expect(withEndTime(offsite, 17 * 60, NY)).toEqual({
      ...offsite,
      endAt: '2026-10-14T21:00:00.000Z',
    });
    // Earlier than the start's time of day is still after the start.
    expect(withEndTime(offsite, 8 * 60, NY).endAt).toBe('2026-10-14T12:00:00.000Z');
  });

  it('same day: an end before the start moves on a day (overnight)', () => {
    const standup = timed('2026-10-12T13:00:00.000Z', '2026-10-12T14:00:00.000Z');
    expect(withEndTime(standup, 11 * 60, NY).endAt).toBe('2026-10-12T15:00:00.000Z');
    expect(withEndTime(standup, 8 * 60, NY).endAt).toBe('2026-10-13T12:00:00.000Z');
  });

  it("an end at the midnight after the start's day belongs to that day", () => {
    // Mon 22:00 → Tue 00:00 reads "Mon 10 – 12 AM"; 23:00 is Monday's.
    const late = timed('2026-10-13T02:00:00.000Z', '2026-10-13T04:00:00.000Z');
    expect(withEndTime(late, 23 * 60, NY).endAt).toBe('2026-10-13T03:00:00.000Z');
  });
});
