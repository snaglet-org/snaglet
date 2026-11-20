/**
 * /api/calendar routes over HTTP: the envelope, status codes, reorder 400,
 * and DELETE → restore of an event (the node is archived, never deleted).
 * Also checks the realtime frame: `calendar:changed` on the workspace
 * channel with `{ kind, calendarId?, eventId? }`.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';

const broadcast = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: (...args: unknown[]) => broadcast(...args) },
}));

import { errorHandler } from '@server/middleware';
import calendarRoutes from '@server/domains/calendar/calendar.routes';

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/calendar', calendarRoutes);
  server.use(errorHandler);
  return server;
}

async function clean(): Promise<void> {
  await getDb().query("DELETE FROM public.nodes WHERE type = 'calendar_event'");
  await getDb().query('DELETE FROM public.calendars');
}

describe('/api/calendar routes', () => {
  beforeEach(async () => {
    await clean();
    broadcast.mockClear();
  });
  afterAll(clean);

  it('lists empty without mutation, creates, patches and reorders', async () => {
    const listed = await request(app()).get('/api/calendar/calendars');
    expect(listed.status).toBe(200);
    expect(listed.body.data.calendars).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
    const defResponse = await request(app())
      .post('/api/calendar/calendars')
      .send({ title: 'First' });
    const def = defResponse.body.data.calendar;

    const created = await request(app()).post('/api/calendar/calendars').send({ title: 'Work' });
    expect(created.status).toBe(201);
    const work = created.body.data.calendar;
    expect(work.sortOrder).toBe(1);

    const patched = await request(app())
      .patch(`/api/calendar/calendars/${work.id}`)
      .send({ color: 'purple', expectedRevision: 1 });
    expect(patched.status).toBe(200);
    expect(patched.body.data.calendar).toMatchObject({ color: 'purple', revision: 2 });

    const partial = await request(app())
      .put('/api/calendar/calendars/order')
      .send({ calendarIds: [work.id] });
    expect(partial.status).toBe(400);
    expect(partial.body.error.message).toMatch(/every calendar/);
    const reordered = await request(app())
      .put('/api/calendar/calendars/order')
      .send({ calendarIds: [work.id, def.id] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.data.calendars.map((c: { id: string }) => c.id)).toEqual([
      work.id,
      def.id,
    ]);

    await request(app()).post(`/api/calendar/calendars/${work.id}/archive`).expect(404);
    await request(app()).post(`/api/calendar/calendars/${work.id}/restore`).expect(404);
  });

  it('takes palette ids, theme tokens and custom hex colors; anything else is a clear 400', async () => {
    const created = await request(app())
      .post('/api/calendar/calendars')
      .send({ title: 'Work', color: '#ABC' });
    expect(created.status).toBe(201);
    const work = created.body.data.calendar;
    expect(work.color).toBe('#aabbcc');

    const themed = await request(app())
      .patch(`/api/calendar/calendars/${work.id}`)
      .send({ color: 'theme:detail', expectedRevision: 1 });
    expect(themed.status).toBe(200);
    expect(themed.body.data.calendar).toMatchObject({ color: 'theme:detail', revision: 2 });

    const custom = await request(app())
      .patch(`/api/calendar/calendars/${work.id}`)
      .send({ color: '#3A7BD5', expectedRevision: 2 });
    expect(custom.body.data.calendar).toMatchObject({ color: '#3a7bd5', revision: 3 });
    const listed = await request(app()).get('/api/calendar/calendars');
    expect(listed.body.data.calendars.find((c: { id: string }) => c.id === work.id).color).toBe(
      '#3a7bd5'
    );

    for (const color of ['rgb(1, 2, 3)', 'theme:nope', '#12345', 'Blue']) {
      const bad = await request(app())
        .patch(`/api/calendar/calendars/${work.id}`)
        .send({ color, expectedRevision: 3 });
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toMatch(
        /^color must be null \(automatic\), a palette color \(blue, .*\), a theme color written theme:<token> .*, or a custom hex color like #3a7bd5\.$/
      );
    }
    const automatic = await request(app())
      .patch(`/api/calendar/calendars/${work.id}`)
      .send({ color: null, expectedRevision: 3 });
    expect(automatic.body.data.calendar).toMatchObject({ color: null, revision: 4 });
  });

  it('DELETE archives an event; restore brings it back with its data', async () => {
    const created = await request(app())
      .post('/api/calendar/events')
      .send({
        id: 'event-route-1',
        title: 'Dentist',
        location: 'Main St',
        time: {
          kind: 'timed',
          startAt: '2026-03-09T13:00:00Z',
          endAt: '2026-03-09T14:00:00Z',
          timeZone: 'America/New_York',
        },
      });
    expect(created.status).toBe(201);
    const event = created.body.data.event;

    const stale = await request(app()).delete(
      '/api/calendar/events/event-route-1?expectedRevision=7'
    );
    expect(stale.status).toBe(409);
    broadcast.mockClear();
    const deleted = await request(app()).delete(
      '/api/calendar/events/event-route-1?expectedRevision=1'
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ id: 'event-route-1' });
    expect(broadcast).toHaveBeenCalledWith('workspace', {
      type: 'calendar:changed',
      payload: { kind: 'event', calendarId: event.calendarId, eventId: 'event-route-1' },
    });
    const { rows } = await getDb().query<{ archived: boolean }>(
      'SELECT n.archived FROM public.nodes n JOIN public.calendar_events e ON e.id = n.id WHERE n.id = $1',
      ['event-route-1']
    );
    expect(rows).toEqual([{ archived: true }]);
    expect((await request(app()).get('/api/calendar/events/event-route-1')).status).toBe(404);
    const window = await request(app()).get(
      '/api/calendar/occurrences?from=2026-03-09&to=2026-03-10&tz=UTC'
    );
    expect(window.body.data.occurrences).toEqual([]);

    const restored = await request(app()).post('/api/calendar/events/event-route-1/restore');
    expect(restored.status).toBe(200);
    expect(restored.body.data.event).toEqual({ ...event, updatedAt: expect.any(String) });
    const again = await request(app()).get(
      '/api/calendar/occurrences?from=2026-03-09&to=2026-03-10&tz=UTC'
    );
    expect(again.body.data.occurrences.map((o: { key: string }) => o.key)).toEqual([
      'event:event-route-1',
    ]);
  });

  it('rejects a recurring event and a bad window with 400', async () => {
    const recurring = await request(app())
      .post('/api/calendar/events')
      .send({
        title: 'Daily',
        recurrence: ['RRULE:FREQ=DAILY'],
        time: { kind: 'all_day', startDate: '2026-03-09', endDate: '2026-03-10', timeZone: 'UTC' },
      });
    expect(recurring.status).toBe(400);
    const wide = await request(app()).get(
      '/api/calendar/occurrences?from=2026-01-01&to=2026-06-01'
    );
    expect(wide.status).toBe(400);
  });
});
