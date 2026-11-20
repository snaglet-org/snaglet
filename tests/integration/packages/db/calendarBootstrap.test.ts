/**
 * The default calendar a fresh install gets: `bootstrapIfFresh` creates exactly
 * one default calendar in the local time zone (UTC when PostgreSQL does not
 * know that zone), and never creates another on a database it did not just
 * provision.
 */
import { expect, it, jest } from '@jest/globals';
import { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { bootstrapIfFresh } from '@snaglet/db/migrations';
import { DEFAULT_CALENDAR_TITLE } from '@snaglet/shared/types';
import { createEmptyTestDatabase } from '../../../support/pgTestCluster';

it('fresh bootstrap seeds exactly one Default, never reseeds an existing empty workspace', async () => {
  const target = createEmptyTestDatabase('calendarfresh');
  const db = new PostgresAdapter({ connectionString: target.url });
  try {
    expect(await bootstrapIfFresh(db)).toBe(true);
    expect((await db.query('SELECT title, is_default FROM public.calendars')).rows).toEqual([
      { title: DEFAULT_CALENDAR_TITLE, is_default: true },
    ]);
    expect(await bootstrapIfFresh(db)).toBe(false);
    expect((await db.query('SELECT id FROM public.calendars')).rows).toHaveLength(1);
    await db.query('DELETE FROM public.calendars');
    expect(await bootstrapIfFresh(db)).toBe(false);
    expect((await db.query('SELECT id FROM public.calendars')).rows).toEqual([]);
  } finally {
    await db.end();
    target.drop();
  }
});

it('fresh bootstrap falls back to UTC when the local timezone is unknown to PostgreSQL', async () => {
  const target = createEmptyTestDatabase('calendarbadzone');
  const db = new PostgresAdapter({ connectionString: target.url });
  const options = Intl.DateTimeFormat().resolvedOptions();
  const zone = jest.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...options,
    timeZone: 'Unknown/CalendarZone',
  });
  try {
    expect(await bootstrapIfFresh(db)).toBe(true);
    expect((await db.query('SELECT time_zone FROM public.calendars')).rows).toEqual([
      { time_zone: 'UTC' },
    ]);
  } finally {
    zone.mockRestore();
    await db.end();
    target.drop();
  }
});
