import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import calendarRoutes from '@server/domains/calendar/calendar.routes';
import { createEventOp } from '@server/services/ToolService/handlers/calendar/events';
import { emitCalendarChanged } from '@server/realtime/surfaces/calendar';
import { emitAutomationsChanged } from '@server/realtime/surfaces/automations';
import { createCalendarOp } from '@server/services/ToolService/handlers/calendar/calendars';
import { runWithActor } from '@server/realtime/actorContext';
import { Calendars, mapCalendarForeignKeyError } from '@snaglet/db/tables/calendars';
import request from 'supertest';
import { getDb, getDbClient, transaction } from '@snaglet/db';
import {
  calendarDeletionAuth,
  deleteCalendar,
  previewCalendarDeletion,
} from '@server/domains/calendar/calendarDeletion';
import {
  createCalendar,
  createEvent,
  deleteEvent,
  listCalendars,
  updateEvent,
} from '@server/domains/calendar/calendarService';
import { getPanelToken } from '@server/middleware/panelAuth';
import { errorHandler } from '@server/middleware/errorHandler';

jest.mock('@server/realtime/surfaces/automations', () => ({ emitAutomationsChanged: jest.fn() }));
jest.mock('@server/realtime/surfaces/calendar', () => ({ emitCalendarChanged: jest.fn() }));
jest.mock('@server/realtime/surfaces/tables', () => ({ emitTableFieldsChanged: jest.fn() }));

beforeAll(async () => {
  await getDbClient();
});
beforeEach(async () => {
  await getDb().query('UPDATE public.table_fields SET calendar_id = NULL');
  await getDb().query("DELETE FROM public.nodes WHERE type = 'calendar_event'");
  await getDb().query('DELETE FROM public.calendars');
});

const eventInput = (calendarId: string, title: string) => ({
  calendarId,
  title,
  time: {
    kind: 'timed',
    timeZone: 'UTC',
    startAt: '2030-01-01T10:00:00Z',
    endAt: '2030-01-01T11:00:00Z',
  },
});

describe('app-only permanent calendar deletion', () => {
  it('requires the actual app panel credential, not a claimed actor or sidecar token', async () => {
    const app = express();
    app.delete('/calendar', calendarDeletionAuth, (_req, res) => res.sendStatus(204));
    app.use(errorHandler);
    await request(app).delete('/calendar').expect(403);
    const previousToken = process.env.SNAGLET_AUTH_TOKEN;
    process.env.SNAGLET_AUTH_TOKEN = 'valid-test-sidecar-token';
    try {
      await request(app)
        .delete('/calendar')
        .set('X-Snaglet-Sidecar-Token', 'valid-test-sidecar-token')
        .expect(403);
      await request(app)
        .delete('/calendar')
        .set('X-Snaglet-Token', 'valid-test-sidecar-token')
        .expect(403);
      await request(app)
        .delete('/calendar')
        .set('X-Snaglet-Panel-Token', 'valid-test-sidecar-token')
        .expect(403);
    } finally {
      if (previousToken === undefined) delete process.env.SNAGLET_AUTH_TOKEN;
      else process.env.SNAGLET_AUTH_TOKEN = previousToken;
    }

    await request(app)
      .delete('/calendar')
      .set('X-Snaglet-Sidecar-Token', 'agent-token')
      .set('X-Snaglet-Actor-Kind', 'user')
      .expect(403);
    await request(app)
      .delete('/calendar')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .expect(204);
  });

  it('deletes active and archived native events/reminders, promotes remaining default, rejects stale preview', async () => {
    const original = await transaction(async (tx) => (await Calendars.ensureDefault(tx)).calendar);
    const remaining = await createCalendar({ title: 'Remaining' });
    const { event: first } = await createEvent(eventInput(original.id, 'First'));
    const { event: second } = await createEvent(eventInput(original.id, 'Archived'));
    await deleteEvent(second.id, second.revision);
    await getDb().query("INSERT INTO public.reminder_settings(kind,event_id) VALUES ('event',$1)", [
      first.id,
    ]);
    const preview = await previewCalendarDeletion(original.id);
    expect(preview.events).toBe(1);
    const { event: third } = await createEvent(eventInput(original.id, 'Concurrent addition'));
    await expect(deleteCalendar(original.id, preview.token)).rejects.toThrow('changed');
    const fresh = await previewCalendarDeletion(original.id);
    await deleteCalendar(original.id, fresh.token);
    expect(
      (
        await getDb().query('SELECT id FROM public.calendar_events WHERE id = ANY($1)', [
          [first.id, second.id, third.id],
        ])
      ).rows
    ).toEqual([]);
    expect(
      (
        await getDb().query('SELECT * FROM public.reminder_settings WHERE event_id = $1', [
          first.id,
        ])
      ).rows
    ).toEqual([]);
    expect((await listCalendars()).map((c) => [c.id, c.isDefault])).toEqual([[remaining.id, true]]);
  });

  it('deletes recurrence exceptions before roots and preserves unrelated workspace nodes', async () => {
    const calendar = await transaction(async (tx) => (await Calendars.ensureDefault(tx)).calendar);
    const db = getDb();
    await db.query(
      "INSERT INTO public.nodes(id,type) VALUES ('delete-root','calendar_event'),('delete-exception','calendar_event'),('keep-linked','doc')"
    );
    await db.query(
      `INSERT INTO public.calendar_events(id,calendar_id,time_kind,time_zone,start_date,end_date,recurrence)
      VALUES ('delete-root',$1,'all_day','UTC','2030-01-01','2030-01-02',ARRAY['RRULE:FREQ=DAILY'])`,
      [calendar.id]
    );
    await db.query(
      `INSERT INTO public.calendar_events(id,calendar_id,time_kind,time_zone,start_date,end_date,recurring_event_id,original_start_date)
      VALUES ('delete-exception',$1,'all_day','UTC','2030-01-02','2030-01-03','delete-root','2030-01-02')`,
      [calendar.id]
    );
    const preview = await previewCalendarDeletion(calendar.id);
    expect(preview.events).toBe(2);
    await deleteCalendar(calendar.id, preview.token);
    expect(
      (await db.query("SELECT id FROM public.nodes WHERE id IN ('delete-root','delete-exception')"))
        .rows
    ).toEqual([]);
    expect(
      (await db.query("SELECT id FROM public.nodes WHERE id='keep-linked'")).rows
    ).toHaveLength(1);
  });

  it('promotes the first remaining sidebar calendar rather than the oldest', async () => {
    const original = await transaction(async (tx) => (await Calendars.ensureDefault(tx)).calendar);
    const older = await createCalendar({ title: 'Older but last in sidebar' });
    const first = await createCalendar({ title: 'Newer but first in sidebar' });
    await getDb().query(
      `UPDATE public.calendars SET sort_order = 10, created_at = '2020-01-01' WHERE id = $1`,
      [older.id]
    );
    await getDb().query(
      `UPDATE public.calendars SET sort_order = 1, created_at = '2021-01-01' WHERE id = $1`,
      [first.id]
    );
    const preview = await previewCalendarDeletion(original.id);
    await deleteCalendar(original.id, preview.token);
    expect((await Calendars.findById(first.id))?.isDefault).toBe(true);
    expect((await Calendars.findById(older.id))?.isDefault).toBe(false);
  });

  it('allows last deletion and repeated reads stay empty; explicit event creation creates a new default', async () => {
    const old = await transaction(async (tx) => (await Calendars.ensureDefault(tx)).calendar);
    const { event } = await createEvent(eventInput(old.id, 'Gone'));
    await deleteCalendar(old.id, (await previewCalendarDeletion(old.id)).token);
    expect((await getDb().query('SELECT * FROM public.calendars')).rows).toEqual([]);
    expect(
      (await getDb().query('SELECT id FROM public.nodes WHERE id = $1', [event.id])).rows
    ).toEqual([]);
    expect(await listCalendars()).toEqual([]);
    expect(await listCalendars()).toEqual([]);
    await createEvent({ ...eventInput('', 'Explicit new event'), calendarId: undefined });
    const [replacement] = await listCalendars();
    expect(replacement.id).not.toBe(old.id);
    expect(replacement.isDefault).toBe(true);
    expect(
      (
        await getDb().query('SELECT * FROM public.calendar_events WHERE calendar_id = $1', [
          replacement.id,
        ])
      ).rows
    ).toHaveLength(1);
  });

  it('disconnects inactive fields and automations while preserving rows, reminders, schedules and settings', async () => {
    const calendar = await transaction(async (tx) => (await Calendars.ensureDefault(tx)).calendar);
    const db = getDb();
    await db.query(
      "INSERT INTO public.table_catalog(id,name,table_name,origin) VALUES ('delete-table','delete_preservation','delete_preservation','custom')"
    );
    await db.query(
      'CREATE TABLE user_tables.delete_preservation(id uuid PRIMARY KEY, _snaglet_due date)'
    );
    await db.query(
      "INSERT INTO user_tables.delete_preservation VALUES ('11111111-1111-4111-8111-111111111111','2030-01-01')"
    );
    await db.query(
      `INSERT INTO public.table_fields(id,table_id,column_name,name,type,nullable,position,calendar_id,state,managed)
      VALUES ('delete-field','delete-table','_snaglet_due','Due','date',true,0,$1,'archived',false)`,
      [calendar.id]
    );
    await db.query(
      "INSERT INTO public.reminder_settings(kind,table_id,field_id,entry_id) VALUES ('table_entry','delete-table','delete-field','11111111-1111-4111-8111-111111111111')"
    );
    await db.query("INSERT INTO public.agents(id,name) VALUES ('delete-agent','Delete agent')");
    await db.query("INSERT INTO public.nodes(id,type) VALUES ('delete-thread','thread')");
    await db.query("INSERT INTO public.threads(id,title) VALUES ('delete-thread','Delete thread')");
    await db.query(
      "INSERT INTO public.schedules(id,name,schedule_kind,action_kind) VALUES ('delete-schedule','Keep','interval','automation')"
    );
    await db.query(
      `INSERT INTO public.automations(id,name,prompt,tz,thread_id,agent_id,when_kind,every_ms,calendar_id,schedule_id)
      VALUES ('delete-automation','Keep','Keep running','UTC','delete-thread','delete-agent','interval',900000,$1,'delete-schedule')`,
      [calendar.id]
    );
    await db.query(`INSERT INTO public.table_entry_repeats(table_id,field_id,entry_id,value)
      VALUES ('delete-table','delete-field','11111111-1111-4111-8111-111111111111','{"rrule":"FREQ=DAILY","dtstart":"2030-01-01","current":"2030-01-01","tz":"UTC"}')`);
    await db.query(`INSERT INTO public.table_entry_occurrences(table_id,field_id,entry_id,occurrence,kind)
      VALUES ('delete-table','delete-field','11111111-1111-4111-8111-111111111111','2029-12-31','done')`);
    const repeats = (
      await db.query("SELECT * FROM public.table_entry_repeats WHERE field_id='delete-field'")
    ).rows;
    const history = (
      await db.query("SELECT * FROM public.table_entry_occurrences WHERE field_id='delete-field'")
    ).rows;
    const before = (await db.query("SELECT * FROM public.table_fields WHERE id='delete-field'"))
      .rows[0];
    const schedule = (await db.query("SELECT * FROM public.schedules WHERE id='delete-schedule'"))
      .rows;
    const reminders = (
      await db.query("SELECT * FROM public.reminder_settings WHERE field_id='delete-field'")
    ).rows;
    const preview = await previewCalendarDeletion(calendar.id);
    expect(preview).toMatchObject({ dateFields: 0, automations: 1 });
    await deleteCalendar(calendar.id, preview.token);
    expect(
      (
        await db.query(
          "SELECT calendar_id,revision,state FROM public.table_fields WHERE id='delete-field'"
        )
      ).rows[0]
    ).toEqual({ calendar_id: null, revision: Number(before.revision) + 1, state: 'archived' });
    expect((await db.query('SELECT * FROM user_tables.delete_preservation')).rows).toHaveLength(1);
    expect(
      (await db.query("SELECT * FROM public.reminder_settings WHERE field_id='delete-field'")).rows
    ).toEqual(reminders);
    expect(
      (await db.query("SELECT * FROM public.schedules WHERE id='delete-schedule'")).rows
    ).toEqual(schedule);
    expect(
      (
        await db.query(
          "SELECT calendar_id,status,schedule_id FROM public.automations WHERE id='delete-automation'"
        )
      ).rows[0]
    ).toEqual({ calendar_id: null, status: 'active', schedule_id: 'delete-schedule' });
    expect(await listCalendars()).toEqual([]);
    expect(await listCalendars()).toEqual([]);
    await createEvent({ ...eventInput('', 'Explicit new event'), calendarId: undefined });
    expect(
      (await db.query("SELECT * FROM public.table_entry_repeats WHERE field_id='delete-field'"))
        .rows
    ).toEqual(repeats);
    expect(
      (await db.query("SELECT * FROM public.table_entry_occurrences WHERE field_id='delete-field'"))
        .rows
    ).toEqual(history);
    const [replacement] = await listCalendars();
    expect(replacement.id).not.toBe(calendar.id);
    expect(
      (await db.query('SELECT id FROM public.table_fields WHERE calendar_id=$1', [replacement.id]))
        .rows
    ).toEqual([]);
    expect(
      (await db.query('SELECT id FROM public.automations WHERE calendar_id=$1', [replacement.id]))
        .rows
    ).toEqual([]);
  });

  it('uses the real router for missing calendars, missing confirmation and double deletion', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/calendar', calendarRoutes);
    app.use(errorHandler);
    const token = getPanelToken();
    await request(app)
      .get('/api/calendar/calendars/missing/deletion')
      .set('X-Snaglet-Panel-Token', token)
      .expect(404);
    const calendar = await createCalendar({ title: 'HTTP delete' });
    const url = `/api/calendar/calendars/${calendar.id}`;
    await request(app).delete(url).set('X-Snaglet-Panel-Token', token).send({}).expect(400);
    const preview = await previewCalendarDeletion(calendar.id);
    jest.mocked(emitCalendarChanged).mockClear();
    jest.mocked(emitAutomationsChanged).mockClear();
    await request(app)
      .delete(url)
      .set('X-Snaglet-Panel-Token', token)
      .send({ token: preview.token })
      .expect(200);
    expect(emitCalendarChanged).toHaveBeenCalledWith({ kind: 'calendar', calendarId: calendar.id });
    expect(emitAutomationsChanged).toHaveBeenCalledTimes(1);
    await request(app)
      .delete(url)
      .set('X-Snaglet-Panel-Token', token)
      .send({ token: preview.token })
      .expect(404);
  });

  it('preserves the current default when deleting a nondefault calendar', async () => {
    const original = await transaction(async (tx) => (await Calendars.ensureDefault(tx)).calendar);
    const other = await createCalendar({ title: 'Other' });
    await deleteCalendar(other.id, (await previewCalendarDeletion(other.id)).token);
    expect(
      (await listCalendars())
        .filter((calendar) => calendar.isDefault)
        .map((calendar) => calendar.id)
    ).toEqual([original.id]);
  });

  it('lets an agent create an event without a calendar in an empty workspace', async () => {
    const result = await createEventOp({ title: 'Agent event', start: '2030-01-01', tz: 'UTC' });
    expect(result).toMatchObject({ created: true });
    const calendars = await listCalendars();
    expect(calendars).toHaveLength(1);
    expect(calendars[0].isDefault).toBe(true);
  });

  it('lets an agent explicitly create the first calendar', async () => {
    expect(await listCalendars()).toEqual([]);
    const result = await runWithActor(
      { actorKind: 'agent', actorId: 'calendar-maker', actorName: 'Calendar maker' },
      () => createCalendarOp({ title: 'Agent calendar' })
    );
    expect(result).toMatchObject({
      created: true,
      calendar: { title: 'Agent calendar', default: true },
    });
    expect((await listCalendars()).map((calendar) => calendar.title)).toEqual(['Agent calendar']);
  });

  it('atomically makes the first explicitly created calendar the only default under contention', async () => {
    const [work, personal] = await Promise.all([
      createCalendar({ title: 'Work' }),
      createCalendar({ title: 'Personal' }),
    ]);
    const calendars = await listCalendars();
    expect(calendars).toHaveLength(2);
    expect(calendars.filter((calendar) => calendar.isDefault)).toHaveLength(1);
    expect([work, personal].filter((calendar) => calendar.isDefault)).toHaveLength(1);
    const event = await createEvent({
      ...eventInput(work.id, 'Default placement'),
      calendarId: undefined,
    });
    expect(event.event.calendarId).toBe(calendars.find((calendar) => calendar.isDefault)!.id);
  });

  it('preview stays a plain read while deletion bounds waiting on a concurrent calendar writer', async () => {
    const calendar = await createCalendar({ title: 'Busy' });
    let release!: () => void;
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = transaction(async (tx) => {
      await tx.query('SELECT id FROM public.calendars WHERE id=$1 FOR UPDATE', [calendar.id]);
      locked();
      await wait;
    });
    await holding;
    try {
      const preview = await previewCalendarDeletion(calendar.id);
      await expect(deleteCalendar(calendar.id, preview.token)).rejects.toThrow(
        'Calendar data is being edited. Please try again.'
      );
    } finally {
      release();
      await writer;
    }
    expect((await previewCalendarDeletion(calendar.id)).events).toBe(0);
  });

  it('waits for an in-flight event edit and refuses its stale snapshot without affecting another calendar', async () => {
    const calendar = await createCalendar({ title: 'Editing' });
    const other = await createCalendar({ title: 'Independent' });
    const { event } = await createEvent(eventInput(calendar.id, 'Before'));
    const preview = await previewCalendarDeletion(calendar.id);
    let release!: () => void;
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = transaction(async (tx) => {
      await tx.query(
        'UPDATE public.calendar_events SET title=$2, revision=revision+1 WHERE id=$1',
        [event.id, 'After']
      );
      locked();
      await wait;
    });
    await holding;
    try {
      await createEvent(eventInput(other.id, 'Unrelated write'));
      await expect(deleteCalendar(calendar.id, preview.token)).rejects.toThrow('being edited');
    } finally {
      release();
      await writer;
    }
    await expect(deleteCalendar(calendar.id, preview.token)).rejects.toThrow('changed');
    expect(
      (
        await getDb().query('SELECT id FROM public.calendar_events WHERE calendar_id=$1', [
          other.id,
        ])
      ).rows
    ).toHaveLength(1);
  });

  it('blocks deletion behind an uncommitted new FK binding, then rejects the stale token', async () => {
    const calendar = await createCalendar({ title: 'New binding' });
    const preview = await previewCalendarDeletion(calendar.id);
    let release!: () => void;
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = transaction(async (tx) => {
      await tx.query("INSERT INTO public.nodes(id,type) VALUES ('pending-event','calendar_event')");
      await tx.query(
        `INSERT INTO public.calendar_events(id,calendar_id,time_kind,time_zone,start_date,end_date)
        VALUES ('pending-event',$1,'all_day','UTC','2030-01-01','2030-01-02')`,
        [calendar.id]
      );
      locked();
      await wait;
    });
    await holding;
    try {
      expect((await previewCalendarDeletion(calendar.id)).events).toBe(0);
      await expect(deleteCalendar(calendar.id, preview.token)).rejects.toThrow('being edited');
    } finally {
      release();
      await writer;
    }
    await expect(deleteCalendar(calendar.id, preview.token)).rejects.toThrow('changed');
    await deleteCalendar(calendar.id, (await previewCalendarDeletion(calendar.id)).token);
  });

  it.each(['create', 'move'])(
    'calendar FK protection rejects a late %s and only calendar FK errors map to 400',
    async (operation) => {
      const source = await createCalendar({ title: 'Source' });
      const existing = await createEvent(eventInput(source.id, 'Existing'));
      const calendar = await createCalendar({ title: 'Late binding' });
      let release!: () => void;
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deleter = transaction(async (tx) => {
        await tx.query('SELECT id FROM public.calendars WHERE id=$1 FOR UPDATE', [calendar.id]);
        locked();
        await wait;
        await tx.query('DELETE FROM public.calendars WHERE id=$1', [calendar.id]);
      });
      await holding;
      // Register the rejection before releasing deletion: no unhandled promise.
      const insertion =
        operation === 'create'
          ? createEvent(eventInput(calendar.id, 'Too late'))
          : updateEvent(existing.event.id, {
              calendarId: calendar.id,
              expectedRevision: existing.event.revision,
            });
      const rejected = expect(insertion).rejects.toMatchObject({
        statusCode: 400,
        message: 'That calendar no longer exists',
      });
      // Wait until validation has read the old row, while FK acquisition waits.
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await deleter;
      await rejected;
      const unrelated = { code: '23503', constraint: 'calendar_events_created_by_fkey' };
      try {
        mapCalendarForeignKeyError(unrelated);
      } catch (error) {
        expect(error).toBe(unrelated);
      }
    }
  );

  it('serializes concurrent default deletions and subsequent default creation', async () => {
    const a = await transaction(async (tx) => (await Calendars.ensureDefault(tx)).calendar);
    const b = await createCalendar({ title: 'Second' });
    const [pa, pb] = await Promise.all([
      previewCalendarDeletion(a.id),
      previewCalendarDeletion(b.id),
    ]);
    const results = await Promise.allSettled([
      deleteCalendar(a.id, pa.token),
      deleteCalendar(b.id, pb.token),
      listCalendars(),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(2);
    const calendars = await listCalendars();
    expect(calendars.filter((c) => c.isDefault)).toHaveLength(calendars.length ? 1 : 0);
  });
});
