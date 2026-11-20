/**
 * Automation wakes in the calendar feed, against real PostgreSQL: once and
 * repeat automations appear on their calendar inside the window, a first-open
 * one only with the runs it made; past wakes take their schedule run's verdict
 * (done, skipped, or skipped with note 'failed'; no run means skipped); paused
 * or canceled ones and no calendar hide them (a paused one's past wakes too,
 * until resume); none can be moved or resized. Every (interval) automations are
 * never wakes: they come back in `intervals`, one span per day from their
 * anchor day, only while active, never deleted, and only on a requested calendar.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getDb } from '@snaglet/db';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: async () => ({ ok: true, reason: 'completed', wakeCount: 1, capHit: false }),
}));

import type { CalendarAutomationOccurrence, CalendarIntervalSpan } from '@snaglet/shared/types';
import { listOccurrences } from '@server/domains/calendar/occurrences';
import { automationService } from '@server/services/automations/AutomationService';

const AGENT = 'test-agent-a';
const THREAD = 'thread-1111111111111-calautoaa';
const PERSON = { kind: 'person' } as const;
const DAY = 86_400_000;

const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime();
const day = (offset: number) => new Date(today + offset * DAY).toISOString().slice(0, 10);
const at9 = (offset: number) => new Date(today + offset * DAY + 9 * 3_600_000).toISOString();

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await getDb().query<T>(text, params)).rows;
}

async function feed(): Promise<CalendarAutomationOccurrence[]> {
  const { occurrences } = await listOccurrences({ from: day(-3), to: day(4), tz: 'UTC' });
  return occurrences.filter((o): o is CalendarAutomationOccurrence => o.source === 'automation');
}

async function spans(calendarIds?: string[]): Promise<CalendarIntervalSpan[]> {
  const { intervals } = await listOccurrences({
    from: day(-3),
    to: day(4),
    tz: 'UTC',
    ...(calendarIds ? { calendarIds: calendarIds.join(',') } : {}),
  });
  return intervals;
}

/** Move an interval's anchor (when its timing was set) to `at`. */
async function anchorAt(scheduleId: string | null, at: string) {
  await sql(
    `UPDATE public.schedules SET schedule_json = jsonb_set(schedule_json, '{anchor}', to_jsonb($2::text))
      WHERE id = $1`,
    [scheduleId, at]
  );
}

const base = { prompt: 'Look at the build.', threadId: THREAD, agentId: AGENT };

describe('automation occurrences', () => {
  beforeAll(async () => {
    await sql(
      `INSERT INTO public.agents (id, name) VALUES ($1, 'Test Agent A') ON CONFLICT DO NOTHING`,
      [AGENT]
    );
    await sql(
      `INSERT INTO public.members (id, kind, agent_id) VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING`,
      [`${AGENT}-member`, AGENT]
    );
    await sql(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread') ON CONFLICT DO NOTHING`, [
      THREAD,
    ]);
    await sql(
      `INSERT INTO public.threads (id, title) VALUES ($1, 'Calendar thread') ON CONFLICT DO NOTHING`,
      [THREAD]
    );
    const [member] = await sql<{ id: string }>(
      `SELECT id FROM public.members WHERE agent_id = $1`,
      [AGENT]
    );
    await sql(`INSERT INTO public.thread_participants (thread_id, member_id) VALUES ($1, $2)`, [
      THREAD,
      member!.id,
    ]);
  });
  beforeEach(async () => {
    await sql(`DELETE FROM public.automations`);
    await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
  });
  afterAll(async () => {
    await sql(`DELETE FROM public.automations`);
    await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
  });

  it('creates Default only for an unspecified calendar, preserving explicit null at zero', async () => {
    await sql('DELETE FROM public.calendars');
    const unbound = await automationService.create(
      { ...base, name: 'Unbound', calendarId: null, when: { every: '1h' } },
      PERSON
    );
    expect(unbound.calendarId).toBeNull();
    expect(await sql('SELECT id FROM public.calendars')).toEqual([]);
    const bound = await automationService.create(
      { ...base, name: 'Default', when: { every: '1h' } },
      PERSON
    );
    expect(bound.calendarId).toBeTruthy();
    expect(await sql('SELECT id FROM public.calendars WHERE is_default')).toEqual([
      { id: bound.calendarId },
    ]);
  });

  it('shows once and repeat wakes as fixed 15-minute blocks, and an Every as no wake', async () => {
    const once = await automationService.create(
      { ...base, name: 'Tomorrow', when: { at: `${day(1)}T14:30`, tz: 'UTC' } },
      PERSON
    );
    await automationService.create({ ...base, name: 'Hourly', when: { every: '1h' } }, PERSON);
    const list = await feed();
    expect(list).toEqual([
      {
        key: `automation:${once.id}:${day(1)}T14:30:00.000Z`,
        source: 'automation',
        calendarId: once.calendarId,
        title: 'Tomorrow',
        time: {
          kind: 'timed',
          start: `${day(1)}T14:30:00.000Z`,
          end: `${day(1)}T14:45:00.000Z`,
        },
        status: 'upcoming',
        canMove: false,
        canResize: false,
        automationId: once.id,
        agentId: AGENT,
        agentName: 'Test Agent A',
        threadId: THREAD,
        automationStatus: 'active',
      },
    ]);
  });

  it('maps past wakes to done, skipped and failed, and drops a paused one entirely', async () => {
    const daily = await automationService.create(
      {
        ...base,
        name: 'Morning',
        when: { repeat: 'FREQ=DAILY', at: '09:00', starts: day(-3), tz: 'UTC' },
      },
      PERSON
    );
    await sql(
      `UPDATE public.automations SET created_at = now() - interval '5 days' WHERE id = $1`,
      [daily.id]
    );
    for (const [offset, status, error] of [
      [-3, 'succeeded', null],
      [-2, 'failed', 'Provider exploded'],
    ] as const) {
      await sql(
        `INSERT INTO public.schedule_runs (id, schedule_id, scheduled_for, status, error, finished_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [`schedule_run-test-${offset}`, daily.scheduleId, at9(offset), status, error]
      );
    }
    const byStart = new Map(
      (await feed()).map((o) => [o.time.kind === 'timed' && o.time.start, o])
    );
    expect(byStart.get(at9(-3))).toMatchObject({ status: 'done' });
    expect(byStart.get(at9(-3))).not.toHaveProperty('note');
    expect(byStart.get(at9(-2))).toMatchObject({ status: 'skipped', note: 'failed' });
    expect(byStart.get(at9(-1))).toMatchObject({ status: 'skipped' });
    expect(byStart.get(at9(2))).toMatchObject({ status: 'upcoming', automationStatus: 'active' });

    await automationService.pause(daily.id, PERSON);
    // Paused: none of its wakes, past or upcoming, are on the calendar.
    expect((await feed()).filter((o) => o.automationId === daily.id)).toEqual([]);
    await automationService.resume(daily.id, PERSON);
    const back = new Map((await feed()).map((o) => [o.time.kind === 'timed' && o.time.start, o]));
    expect(back.get(at9(-3))).toMatchObject({ status: 'done' });
    expect(back.get(at9(2))).toMatchObject({
      status: 'upcoming',
      automationStatus: 'active',
      canMove: false,
    });
  });

  it('shows a first-open automation’s runs where they ran, and nothing ahead', async () => {
    const show = await automationService.create(
      { ...base, name: 'Morning show', when: { first_open: true, after: '05:00', tz: 'UTC' } },
      PERSON
    );
    // Nothing planned: it has no fixed time.
    expect((await feed()).filter((o) => o.automationId === show.id)).toEqual([]);
    const ranAt = new Date(today - 2 * DAY + 7.5 * 3_600_000).toISOString();
    await sql(
      `INSERT INTO public.schedule_runs (id, schedule_id, scheduled_for, status, finished_at)
       VALUES ('schedule_run-test-first-open', $1, $2, 'succeeded', now())`,
      [show.scheduleId, ranAt]
    );
    expect((await feed()).filter((o) => o.automationId === show.id)).toEqual([
      expect.objectContaining({
        key: `automation:${show.id}:${ranAt}`,
        status: 'done',
        canMove: false,
        canResize: false,
        automationStatus: 'active',
      }),
    ]);
  });

  it('shows nothing for a once or repeat with no calendar', async () => {
    const shown = await automationService.create(
      { ...base, name: 'Shown', when: { at: `${day(1)}T10:00`, tz: 'UTC' } },
      PERSON
    );
    await automationService.create(
      { ...base, name: 'Off once', when: { at: `${day(1)}T11:00`, tz: 'UTC' }, calendarId: null },
      PERSON
    );
    const offDaily = await automationService.create(
      {
        ...base,
        name: 'Off daily',
        when: { repeat: 'FREQ=DAILY', at: '09:00', tz: 'UTC' },
        calendarId: null,
      },
      PERSON
    );
    await automationService.update(shown.id, { calendarId: null }, PERSON);
    expect(await feed()).toEqual([]);
    await automationService.update(offDaily.id, { calendarId: shown.calendarId }, PERSON);
    expect((await feed()).map((o) => o.automationId)).toContain(offDaily.id);
  });

  it('hides canceled automations and those disconnected from a calendar', async () => {
    const gone = await automationService.create(
      { ...base, name: 'Gone', when: { at: `${day(1)}T10:00`, tz: 'UTC' } },
      PERSON
    );
    const archived = await automationService.create(
      { ...base, name: 'Disconnected calendar', when: { at: `${day(2)}T10:00`, tz: 'UTC' } },
      PERSON
    );
    await automationService.cancel(gone.id, PERSON);
    await sql('UPDATE public.automations SET calendar_id = NULL WHERE id = $1', [archived.id]);
    expect(await feed()).toEqual([]);
  });

  describe('Every automations', () => {
    it('come back as one span per day from the day they started, with no end', async () => {
      const every = await automationService.create(
        { ...base, name: 'Check inbox', when: { every: '15m', tz: 'UTC' } },
        PERSON
      );
      expect(every.calendarId).not.toBeNull(); // the Default calendar
      const startsAt = `${day(-1)}T10:00:00.000Z`;
      await anchorAt(every.scheduleId, startsAt);
      const list = await spans();
      expect(list.map((s) => s.day)).toEqual([day(-1), day(0), day(1), day(2), day(3)]);
      expect(list[0]).toEqual({
        key: `automation:${every.id}:span:${day(-1)}`,
        source: 'automation',
        kind: 'interval',
        automationId: every.id,
        calendarId: every.calendarId,
        name: 'Check inbox',
        day: day(-1),
        everyMs: 900_000,
        startsAt,
        nextRunAt: expect.any(String),
        agentId: AGENT,
        agentName: 'Test Agent A',
        threadId: THREAD,
      });
      // Not wakes: nothing in the items for it.
      expect(await feed()).toEqual([]);
    });

    it('an {every, at} one shows from its anchor day, not before', async () => {
      const anchored = await automationService.create(
        { ...base, name: 'Staggered', when: { every: '15m', at: `${day(2)}T19:07`, tz: 'UTC' } },
        PERSON
      );
      const list = (await spans()).filter((s) => s.automationId === anchored.id);
      expect(list.map((s) => s.day)).toEqual([day(2), day(3)]);
      expect(list[0]!.startsAt).toBe(`${day(2)}T19:07:00.000Z`);
    });

    it('start on the day they were set up, several side by side in start order', async () => {
      const later = await automationService.create(
        { ...base, name: 'Later', when: { every: '1h', tz: 'UTC' } },
        PERSON
      );
      const earlier = await automationService.create(
        { ...base, name: 'Earlier', when: { every: '2h', tz: 'UTC' } },
        PERSON
      );
      await anchorAt(later.scheduleId, `${day(1)}T23:30:00.000Z`);
      await anchorAt(earlier.scheduleId, `${day(-10)}T08:00:00.000Z`);
      const list = await spans();
      expect(list.filter((s) => s.automationId === earlier.id).map((s) => s.day)).toEqual([
        day(-3),
        day(-2),
        day(-1),
        day(0),
        day(1),
        day(2),
        day(3),
      ]);
      expect(list.filter((s) => s.automationId === later.id).map((s) => s.day)).toEqual([
        day(1),
        day(2),
        day(3),
      ]);
      expect(list.filter((s) => s.day === day(2)).map((s) => s.name)).toEqual(['Earlier', 'Later']);
    });

    it('are not drawn while paused, and come back on resume', async () => {
      const every = await automationService.create(
        { ...base, name: 'Paused one', when: { every: '30m', tz: 'UTC' } },
        PERSON
      );
      expect((await spans()).length).toBeGreaterThan(0);
      await automationService.pause(every.id, PERSON);
      expect(await spans()).toEqual([]);
      await automationService.resume(every.id, PERSON);
      const back = await spans();
      expect(back.length).toBeGreaterThan(0);
      expect(back.every((s) => s.automationId === every.id && s.nextRunAt)).toBe(true);
    });

    it('never show with no calendar, once deleted, or off the requested calendars', async () => {
      await automationService.create(
        { ...base, name: 'No calendar', when: { every: '1h', tz: 'UTC' }, calendarId: null },
        PERSON
      );
      const gone = await automationService.create(
        { ...base, name: 'Gone', when: { every: '1h', tz: 'UTC' } },
        PERSON
      );
      await automationService.cancel(gone.id, PERSON);
      expect(await spans()).toEqual([]);

      const shown = await automationService.create(
        { ...base, name: 'Shown', when: { every: '1h', tz: 'UTC' } },
        PERSON
      );
      expect((await spans([shown.calendarId!])).length).toBeGreaterThan(0);
      expect(await spans(['calendar-1111-other'])).toEqual([]);
      await sql('UPDATE public.automations SET calendar_id = NULL WHERE id = $1', [shown.id]);
      expect(await spans()).toEqual([]);
    });
  });
});
