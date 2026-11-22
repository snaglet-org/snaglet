/**
 * AutomationService against real PostgreSQL, with the agent wake
 * (dispatchToThread) mocked: the one owned schedule kept in step with each
 * row, delete/restore and the archive drawer, calendar choice, guardrails,
 * firing, the scheduler's missed-run rule, daily windows, first open of the
 * day, the network guard, notifications, and undo of a person's pause or
 * resume.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { getDb, transaction } from '@snaglet/db';
import { createCalendar } from '@server/domains/calendar/calendarService';
import { Automations } from '@snaglet/db/tables/automations';
import { Reminders } from '@snaglet/db/tables/reminders';
import { firstOpenSlot, isWithinIntervalWindow } from '@snaglet/shared/utils';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn(), sendToClient: jest.fn() },
}));
const dispatchMock = jest.fn<(input: Record<string, unknown>) => Promise<unknown>>();
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: (input: Record<string, unknown>) => dispatchMock(input),
}));

import {
  AUTOMATED_RUN_NOW_REFUSAL,
  AUTOMATED_RUN_REFUSAL,
  automationService,
  type AutomationActor,
} from '@server/services/automations/AutomationService';
import { runWithActor } from '@server/realtime/actorContext';
import { wsService } from '@server/services/WebSocketService';
import {
  AUTOMATION_SCHEDULE_REFUSAL,
  ScheduleRunSkipped,
  scheduleService,
} from '@server/services/ScheduleService';
import { assertReminderItemExists } from '@server/domains/reminders/reminderInput';
import { systemAwake } from '@server/services/systemActivity/fullWake';
import { NetworkNotReadyError, networkGuard } from '@server/services/systemActivity/networkGuard';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';
const THREAD_A = 'thread-1111111111111-autoaaaaa';
const THREAD_B = 'thread-1111111111111-autobbbbb';
const PERSON: AutomationActor = { kind: 'person' };
const agentA = (runId: string | null = 'run-1111111111111-aaaaaaaaa'): AutomationActor => ({
  kind: 'agent',
  agentId: AGENT_A,
  threadId: THREAD_A,
  runId,
});
const AUTOMATED_A: AutomationActor = {
  kind: 'agent',
  agentId: AGENT_A,
  threadId: THREAD_A,
  runId: 'run-1111111111111-automated',
  wakeOrigin: { kind: 'automation', automationId: 'automation-1111111111111-origin' },
};

const COMPLETED = { ok: true, reason: 'completed', wakeCount: 1, capHit: false };

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await getDb().query<T>(text, params)).rows;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function seed(): Promise<void> {
  for (const [agent, name] of [
    [AGENT_A, 'Test Agent A'],
    [AGENT_B, 'Test Agent B'],
  ] as const) {
    await sql(`INSERT INTO public.agents (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      agent,
      name,
    ]);
    await sql(
      `INSERT INTO public.members (id, kind, agent_id) VALUES ($1, 'agent', $2) ON CONFLICT DO NOTHING`,
      [`${agent}-member`, agent]
    );
  }
  for (const [thread, agent] of [
    [THREAD_A, AGENT_A],
    [THREAD_B, AGENT_B],
  ] as const) {
    await sql(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread') ON CONFLICT DO NOTHING`, [
      thread,
    ]);
    await sql(
      `INSERT INTO public.threads (id, title) VALUES ($1, 'Test thread') ON CONFLICT DO NOTHING`,
      [thread]
    );
    const [member] = await sql<{ id: string }>(
      `SELECT id FROM public.members WHERE agent_id = $1`,
      [agent]
    );
    await sql(
      `INSERT INTO public.thread_participants (thread_id, member_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [thread, member!.id]
    );
  }
}

async function clean(): Promise<void> {
  await sql(`DELETE FROM public.automations`);
  await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
  await sql(`DELETE FROM public.notifications WHERE type = 'automation'`);
  await sql(`DELETE FROM public.messages WHERE thread_id = ANY($1)`, [[THREAD_A, THREAD_B]]);
  await sql(`DELETE FROM public.runs WHERE thread_id = ANY($1)`, [[THREAD_A, THREAD_B]]);
}

/** Schedules owned by `automationId` (by their action), with the link the row holds. */
async function ownedSchedules(automationId: string) {
  return sql<{
    id: string;
    enabled: boolean;
    schedule_kind: string;
    next_run_at: string | null;
    linked: boolean;
  }>(
    `SELECT s.id, s.enabled, s.schedule_kind, s.next_run_at,
            EXISTS (SELECT 1 FROM public.automations a WHERE a.id = $1 AND a.schedule_id = s.id) AS linked
       FROM public.schedules s
      WHERE s.action_kind = 'automation' AND s.action_json->>'automationId' = $1`,
    [automationId]
  );
}

async function runsOfSchedule(scheduleId: string) {
  return sql<{ status: string }>(
    `SELECT status FROM public.schedule_runs WHERE schedule_id = $1 ORDER BY started_at`,
    [scheduleId]
  );
}

async function notices() {
  return sql<{ title: string; body: string; thread_id: string; agent_id: string }>(
    `SELECT title, body, thread_id, agent_id FROM public.notifications WHERE type = 'automation' ORDER BY created_at`
  );
}

const USER_A = 'test-user-a';
const USER_B = 'test-user-b';

/** Two signed-in people with members (USER_A, USER_B), for the undo tests. */
async function seedUsers(): Promise<void> {
  for (const [user, email] of [
    [USER_A, 'user-a@example.com'],
    [USER_B, 'user-b@example.com'],
  ] as const) {
    await sql(
      `INSERT INTO public.users (id, email, name, auth_provider_id) VALUES ($1, $2, 'Test User', $1)
       ON CONFLICT DO NOTHING`,
      [user, email]
    );
    await sql(
      `INSERT INTO public.members (id, kind, user_id) VALUES ($1, 'user', $2) ON CONFLICT DO NOTHING`,
      [`${user}-member`, user]
    );
  }
}

async function dropUsers(): Promise<void> {
  await sql(`DELETE FROM public.members WHERE user_id = ANY($1)`, [[USER_A, USER_B]]);
  await sql(`DELETE FROM public.users WHERE id = ANY($1)`, [[USER_A, USER_B]]);
}
/** Run `fn` as a signed-in person (the ambient actor HTTP requests carry). */
const asUser =
  (userId: string) =>
  <T>(fn: () => Promise<T>): Promise<T> =>
    runWithActor({ actorKind: 'user', actorId: userId, actorName: 'Test User' }, fn);

const hourly = (name = 'Hourly check') => ({
  name,
  prompt: 'Look at the build.',
  when: { every: '1h' },
  threadId: THREAD_A,
  agentId: AGENT_A,
});

describe('AutomationService', () => {
  beforeAll(seed);
  beforeEach(async () => {
    await clean();
    dispatchMock.mockReset();
    dispatchMock.mockResolvedValue(COMPLETED);
  });
  afterEach(() => scheduleService.stop());
  afterAll(clean);

  describe('keeping one owned schedule in step', () => {
    it('create, update, pause, resume and cancel each leave exactly one matching schedule', async () => {
      const once = await automationService.create(
        {
          name: 'Check in',
          prompt: 'Look at the build.',
          when: { in: '2h' },
          threadId: THREAD_A,
          agentId: AGENT_A,
        },
        agentA()
      );
      expect(once).toMatchObject({
        status: 'active',
        when: { kind: 'once' },
        createdByAgentId: AGENT_A,
      });
      expect(once.calendarId).not.toBeNull(); // the Default calendar
      let schedules = await ownedSchedules(once.id);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({ enabled: true, schedule_kind: 'once', linked: true });
      expect(new Date(schedules[0]!.next_run_at!).toISOString()).toBe(once.nextRunAt);

      const repeat = await automationService.update(
        once.id,
        {
          when: {
            repeat: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
            at: '09:00',
            tz: 'America/Los_Angeles',
          },
        },
        agentA()
      );
      expect(repeat.whenText).toMatch(/^every weekday at 9:00 AM/);
      schedules = await ownedSchedules(once.id);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({ schedule_kind: 'rrule', enabled: true, linked: true });

      const paused = await automationService.pause(once.id, agentA());
      expect(paused).toMatchObject({ status: 'paused', pausedReason: 'agent', nextRunAt: null });
      schedules = await ownedSchedules(once.id);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({ enabled: false, next_run_at: null });

      const resumed = await automationService.resume(once.id, agentA());
      expect(resumed).toMatchObject({ status: 'active', pausedReason: null });
      expect((await ownedSchedules(once.id))[0]).toMatchObject({ enabled: true, linked: true });

      const canceled = await automationService.cancel(once.id, agentA());
      expect(canceled).toMatchObject({ status: 'cancelled', scheduleId: null, nextRunAt: null });
      // The schedule stays, disabled and unlinked, for its runs and a restore.
      schedules = await ownedSchedules(once.id);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({
        id: once.scheduleId,
        enabled: false,
        next_run_at: null,
        linked: false,
      });
      await expect(automationService.cancel(once.id, agentA())).rejects.toThrow(
        `Automation ${once.id} is canceled.`
      );
      await expect(automationService.pause(once.id, agentA())).rejects.toThrow(
        `Automation ${once.id} is canceled.`
      );

      // Undo of a cancel is a resume: back on the schedule it kept.
      const back = await automationService.resume(once.id, agentA());
      expect(back.status).toBe('active');
      expect(back.scheduleId).toBe(once.scheduleId);
      schedules = await ownedSchedules(once.id);
      expect(schedules).toHaveLength(1);
      expect(schedules[0]).toMatchObject({ enabled: true, linked: true, id: once.scheduleId });
      expect(new Date(schedules[0]!.next_run_at!).toISOString()).toBe(back.nextRunAt);
    });

    it('the generic schedules API refuses automation rows', async () => {
      const a = await automationService.create(hourly(), PERSON);
      await expect(scheduleService.setEnabled(a.scheduleId!, false)).rejects.toThrow(
        AUTOMATION_SCHEDULE_REFUSAL
      );
      await expect(scheduleService.runNow(a.scheduleId!)).rejects.toThrow(
        AUTOMATION_SCHEDULE_REFUSAL
      );
      expect((await ownedSchedules(a.id))[0]).toMatchObject({ enabled: true });
    });

    it('boot reconcile recreates a missing schedule, fixes a stale flag and deletes an orphan', async () => {
      const lost = await automationService.create(hourly('Lost schedule'), PERSON);
      const stale = await automationService.create(hourly('Stale flag'), PERSON);
      await sql(`DELETE FROM public.schedules WHERE id = $1`, [lost.scheduleId]);
      await sql(`UPDATE public.schedules SET enabled = false WHERE id = $1`, [stale.scheduleId]);
      await sql(
        `INSERT INTO public.schedules (id, name, schedule_kind, schedule_json, action_kind, action_json)
         VALUES ('schedule-1111111111111-orphanaaa', 'Orphan', 'once', '{"at":"2030-01-01T00:00:00Z"}',
                 'automation', '{"automationId":"automation-1111111111111-gone"}')`
      );

      expect(await automationService.reconcile()).toEqual({ repaired: 2, removed: 1 });
      expect(await ownedSchedules(lost.id)).toEqual([
        expect.objectContaining({ enabled: true, linked: true }),
      ]);
      expect((await ownedSchedules(stale.id))[0]).toMatchObject({ enabled: true });
      expect(
        await sql(`SELECT 1 FROM public.schedules WHERE id = 'schedule-1111111111111-orphanaaa'`)
      ).toHaveLength(0);
      // Idempotent.
      expect(await automationService.reconcile()).toEqual({ repaired: 0, removed: 0 });
    });

    it("boot reconcile keeps a deleted automation's schedule, disables it if enabled, and drops a live one's second schedule", async () => {
      const quiet = await automationService.create(hourly('Deleted, quiet'), PERSON);
      const loud = await automationService.create(hourly('Deleted, enabled'), PERSON);
      const live = await automationService.create(hourly('Live'), PERSON);
      await automationService.cancel(quiet.id, PERSON);
      await automationService.cancel(loud.id, PERSON);
      await sql(
        `UPDATE public.schedules SET enabled = true, next_run_at = now() + interval '1 hour' WHERE id = $1`,
        [loud.scheduleId]
      );
      await sql(
        `INSERT INTO public.schedules (id, name, schedule_kind, schedule_json, action_kind, action_json)
         VALUES ('schedule-1111111111111-straybbbb', 'Stray', 'once', '{"at":"2030-01-01T00:00:00Z"}',
                 'automation', $1)`,
        [JSON.stringify({ automationId: live.id })]
      );

      expect(await automationService.reconcile()).toEqual({ repaired: 1, removed: 1 });
      for (const a of [quiet, loud]) {
        expect(await ownedSchedules(a.id)).toEqual([
          expect.objectContaining({ id: a.scheduleId, enabled: false, next_run_at: null }),
        ]);
      }
      expect(await ownedSchedules(live.id)).toEqual([
        expect.objectContaining({ id: live.scheduleId, enabled: true, linked: true }),
      ]);
      expect(await automationService.reconcile()).toEqual({ repaired: 0, removed: 0 });
    });

    it('boot reconcile relinks a live automation to the schedule it kept, runs and all', async () => {
      const a = await automationService.create(hourly('Lost link'), PERSON);
      await automationService.runNow(a.id);
      await waitFor(async () => !automationService.isWakeLive(a.id));
      await sql(`UPDATE public.automations SET schedule_id = NULL WHERE id = $1`, [a.id]);

      expect(await automationService.reconcile()).toEqual({ repaired: 1, removed: 0 });
      expect(await ownedSchedules(a.id)).toEqual([
        expect.objectContaining({ id: a.scheduleId, enabled: true, linked: true }),
      ]);
      expect(await runsOfSchedule(a.scheduleId!)).toHaveLength(1);
    });
  });

  describe('an interval anchored with at', () => {
    const anchorOf = async (id: string) =>
      (
        await sql<{ anchor: string | null }>(
          `SELECT s.schedule_json->>'anchor' AS anchor FROM public.schedules s
           JOIN public.automations a ON a.schedule_id = s.id WHERE a.id = $1`,
          [id]
        )
      )[0]!.anchor;
    const wall = (ms: number) => new Date(ms).toISOString().slice(0, 16);

    it('a future anchor is the first run, stored as ISO UTC; pause and resume keep it', async () => {
      const future = Date.now() + 3 * 3_600_000;
      const a = await automationService.create(
        { ...hourly('Staggered'), when: { every: '15m', at: wall(future), tz: 'UTC' } },
        agentA()
      );
      expect(a.when).toMatchObject({ kind: 'interval', everyMs: 900_000 });
      const anchor = await anchorOf(a.id);
      expect(anchor).toBe(`${wall(future)}:00.000Z`);
      expect(a.nextRunAt).toBe(anchor);
      await automationService.pause(a.id, PERSON);
      const resumed = await automationService.resume(a.id, PERSON);
      expect(await anchorOf(a.id)).toBe(anchor);
      expect(resumed.nextRunAt).toBe(anchor);
    });

    it('a past anchor aligns to the next slot on its lattice; update re-anchors', async () => {
      const past = Date.now() - 100 * 60_000;
      const a = await automationService.create(
        { ...hourly('Staggered'), when: { every: '15m', at: wall(past), tz: 'UTC' } },
        PERSON
      );
      const anchorMs = Date.parse(`${wall(past)}:00.000Z`);
      const next = Date.parse(a.nextRunAt!);
      expect(next).toBeGreaterThan(Date.now());
      expect(next - Date.now()).toBeLessThanOrEqual(900_000);
      expect((next - anchorMs) % 900_000).toBe(0);

      const later = Date.now() + 2 * 3_600_000;
      const moved = await automationService.update(
        a.id,
        { when: { every: '15m', at: wall(later), tz: 'UTC' } },
        PERSON
      );
      expect(await anchorOf(a.id)).toBe(`${wall(later)}:00.000Z`);
      expect(moved.nextRunAt).toBe(`${wall(later)}:00.000Z`);

      const plain = await automationService.update(a.id, { when: { every: '30m' } }, PERSON);
      expect(Date.parse((await anchorOf(a.id))!)).toBeLessThanOrEqual(Date.now());
      expect(plain.when).toMatchObject({ everyMs: 1_800_000 });
    });

    it('exposes the anchor on the record and keeps it across name, prompt, calendar and same-length edits', async () => {
      const future = Date.now() + 3 * 3_600_000;
      const a = await automationService.create(
        { ...hourly('Staggered'), when: { every: '15m', at: wall(future), tz: 'UTC' } },
        PERSON
      );
      const anchor = `${wall(future)}:00.000Z`;
      expect(a.when).toMatchObject({ kind: 'interval', anchor });
      const renamed = await automationService.update(a.id, { name: 'Renamed' }, PERSON);
      expect(await anchorOf(a.id)).toBe(anchor);
      expect(renamed.when).toMatchObject({ anchor });
      await automationService.update(a.id, { prompt: 'New prompt.' }, PERSON);
      expect(await anchorOf(a.id)).toBe(anchor);
      await automationService.update(a.id, { calendarId: null }, PERSON);
      expect(await anchorOf(a.id)).toBe(anchor);
      // The same length sent again (the edit form) keeps it too.
      await automationService.update(a.id, { when: { every: '15m', tz: 'UTC' } }, PERSON);
      expect(await anchorOf(a.id)).toBe(anchor);
    });

    it('a changed length re-anchors to now unless at is given', async () => {
      const future = Date.now() + 3 * 3_600_000;
      const a = await automationService.create(
        { ...hourly('Staggered'), when: { every: '15m', at: wall(future), tz: 'UTC' } },
        PERSON
      );
      await automationService.update(a.id, { when: { every: '30m' } }, PERSON);
      expect(Date.parse((await anchorOf(a.id))!)).toBeLessThanOrEqual(Date.now());
      const again = await automationService.update(
        a.id,
        { when: { every: '45m', at: wall(future), tz: 'UTC' } },
        PERSON
      );
      expect(await anchorOf(a.id)).toBe(`${wall(future)}:00.000Z`);
      expect(again.when).toMatchObject({ everyMs: 2_700_000 });
    });

    it('update with a past anchor re-anchors onto that lattice', async () => {
      const a = await automationService.create(
        { ...hourly('Staggered'), when: { every: '15m' } },
        PERSON
      );
      const past = Date.now() - 5 * 3_600_000;
      const moved = await automationService.update(
        a.id,
        { when: { every: '15m', at: wall(past), tz: 'UTC' } },
        PERSON
      );
      const anchorMs = Date.parse(`${wall(past)}:00.000Z`);
      expect(await anchorOf(a.id)).toBe(new Date(anchorMs).toISOString());
      const next = Date.parse(moved.nextRunAt!);
      expect(next).toBeGreaterThan(Date.now());
      expect((next - anchorMs) % 900_000).toBe(0);
    });

    it('resume after a long pause keeps the lattice and replays nothing', async () => {
      const past = Date.now() - 40 * 86_400_000;
      const a = await automationService.create(
        { ...hourly('Staggered'), when: { every: '15m', at: wall(past), tz: 'UTC' } },
        PERSON
      );
      const anchorMs = Date.parse(`${wall(past)}:00.000Z`);
      await automationService.pause(a.id, PERSON);
      // The paused schedule's next run is long stale by the time it resumes.
      await sql(
        `UPDATE public.schedules SET next_run_at = now() - interval '30 days' WHERE id = $1`,
        [a.scheduleId]
      );
      const resumed = await automationService.resume(a.id, PERSON);
      const next = Date.parse(resumed.nextRunAt!);
      expect(next).toBeGreaterThan(Date.now());
      expect(next - Date.now()).toBeLessThanOrEqual(900_000);
      expect((next - anchorMs) % 900_000).toBe(0);
      expect(await anchorOf(a.id)).toBe(new Date(anchorMs).toISOString());
      expect(
        await sql(`SELECT 1 FROM public.schedule_runs WHERE schedule_id = $1`, [a.scheduleId])
      ).toHaveLength(0);
    });

    it('keeps the agent floor and the exactly-one rule', async () => {
      await expect(
        automationService.create(
          { ...hourly(), when: { every: '5m', at: '2030-01-01T00:07' } },
          agentA()
        )
      ).rejects.toThrow('every must be at least 15m for agents (1m for people).');
      await expect(
        automationService.create(
          { ...hourly(), when: { every: '15m', in: '1h', at: '2030-01-01T00:07' } },
          PERSON
        )
      ).rejects.toThrow('when must have exactly one of in, at, repeat, every, first_open.');
    });
  });

  describe('an interval with a daily window', () => {
    const stallWatch = {
      ...hourly('Stall watch'),
      when: { every: '5m', window_start: '05:05', window_end: '06:00', tz: 'UTC' },
    };
    const windowOf = async (id: string, scheduleId: string | null) => ({
      row: (
        await sql<{ window_start: string | null; window_end: string | null }>(
          `SELECT window_start, window_end FROM public.automations WHERE id = $1`,
          [id]
        )
      )[0],
      schedule: (
        await sql<{ schedule_json: Record<string, unknown> }>(
          `SELECT schedule_json FROM public.schedules WHERE id = $1`,
          [scheduleId]
        )
      )[0]?.schedule_json,
    });

    it('lets an agent wake every 5 minutes inside a short window, on the row and its schedule', async () => {
      const a = await automationService.create(stallWatch, agentA());
      expect(a.when).toMatchObject({
        kind: 'interval',
        everyMs: 300_000,
        tz: 'UTC',
        windowStart: '05:05',
        windowEnd: '06:00',
      });
      expect(a.whenText).toMatch(/^every 5 minutes from 5:05 AM to 6:00 AM/);
      const stored = await windowOf(a.id, a.scheduleId);
      expect(stored.row).toEqual({ window_start: '05:05', window_end: '06:00' });
      expect(stored.schedule).toMatchObject({
        every: 5,
        unit: 'minute',
        windowStart: '05:05',
        windowEnd: '06:00',
      });
      const next = new Date(a.nextRunAt!);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(next.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
      expect(isWithinIntervalWindow(next, { start: '05:05', end: '06:00' }, 'UTC')).toBe(true);
      expect(next.getUTCMinutes() % 5).toBe(0);
    });

    it('keeps the agents’ 15-minute floor without a window or with one over 2 hours', async () => {
      const floor = 'every must be at least 15m for agents (1m for people). Down to 5m works';
      await expect(
        automationService.create({ ...hourly(), when: { every: '5m' } }, agentA())
      ).rejects.toThrow(floor);
      await expect(
        automationService.create(
          { ...hourly(), when: { every: '5m', window_start: '05:00', window_end: '08:00' } },
          agentA()
        )
      ).rejects.toThrow(floor);
      await expect(
        automationService.create(
          { ...hourly(), when: { every: '4m', window_start: '05:05', window_end: '06:00' } },
          agentA()
        )
      ).rejects.toThrow(
        'every must be at least 5m for agents, even with a window (1m for people).'
      );
      expect(await Automations.list({ agentId: AGENT_A })).toEqual([]);
    });

    it('an agent or MCP client cannot enable a 5-minute interval left without its window', async () => {
      const a = await automationService.create(stallWatch, agentA());
      await automationService.pause(a.id, agentA());
      // A 5-minute interval with its window cleared (as a schema rollback could leave it).
      await sql(
        `UPDATE public.automations SET window_start = NULL, window_end = NULL WHERE id = $1`,
        [a.id]
      );
      const refusal =
        'every must be at least 15m for agents (1m for people). Down to 5m works with a window of at most 2h: add window_start and window_end, e.g. "05:05" and "06:00". Change its timing (update when) to enable it.';
      await expect(automationService.resume(a.id, agentA())).rejects.toThrow(refusal);
      await expect(
        automationService.resume(a.id, { kind: 'person', external: true })
      ).rejects.toThrow(refusal);
      expect((await automationService.get(a.id)).status).toBe('paused');
      // Deleted, it comes back paused (no wakes), and is still refused after.
      await automationService.cancel(a.id, agentA());
      expect((await automationService.resume(a.id, agentA())).status).toBe('paused');
      await expect(automationService.resume(a.id, agentA())).rejects.toThrow(refusal);
      // A person keeps their own floor.
      expect((await automationService.resume(a.id, PERSON)).status).toBe('active');
      await automationService.pause(a.id, agentA());
      // New timing lets the agent enable it again.
      await automationService.update(a.id, { when: { every: '15m', tz: 'UTC' } }, agentA());
      expect((await automationService.resume(a.id, agentA())).status).toBe('active');
    });

    it('a timing change without a window clears it from the row and the schedule', async () => {
      const a = await automationService.create(stallWatch, agentA());
      const changed = await automationService.update(
        a.id,
        { when: { every: '15m', tz: 'UTC' } },
        agentA()
      );
      expect(changed.when).not.toHaveProperty('windowStart');
      const stored = await windowOf(a.id, changed.scheduleId);
      expect(stored.row).toEqual({ window_start: null, window_end: null });
      expect(stored.schedule).not.toHaveProperty('windowStart');
      expect(stored.schedule).not.toHaveProperty('windowEnd');
    });

    it('leaves an interval without a window as it was: no window, runs all day', async () => {
      const a = await automationService.create(hourly(), PERSON);
      expect(a.when).not.toHaveProperty('windowStart');
      expect(a.whenText).toBe('every hour');
      const stored = await windowOf(a.id, a.scheduleId);
      expect(stored.row).toEqual({ window_start: null, window_end: null });
      expect(Object.keys(stored.schedule ?? {}).sort()).toEqual(['anchor', 'every', 'unit']);
      expect(Date.parse(a.nextRunAt!) - Date.now()).toBeLessThanOrEqual(3_600_000);
    });
  });

  describe('delete and restore', () => {
    it('delete keeps the one schedule, disabled, with its runs; restore carries on with them', async () => {
      const a = await automationService.create(hourly('Build check'), PERSON);
      await automationService.runNow(a.id);
      await waitFor(async () => !automationService.isWakeLive(a.id));

      const deleted = await automationService.cancel(a.id, PERSON);
      expect(deleted).toMatchObject({ status: 'cancelled', scheduleId: null, nextRunAt: null });
      expect(deleted.lastRun).toMatchObject({ status: 'succeeded' });
      expect(await ownedSchedules(a.id)).toEqual([
        expect.objectContaining({ id: a.scheduleId, enabled: false, next_run_at: null }),
      ]);
      expect(await runsOfSchedule(a.scheduleId!)).toEqual([{ status: 'succeeded' }]);
      const ctx = { scheduleRunId: 'schedule_run-test', scheduledFor: new Date(), manual: false };
      await expect(automationService.fire(a.id, ctx)).rejects.toThrow('Automation is canceled');

      const restored = await automationService.resume(a.id, PERSON);
      expect(restored).toMatchObject({ status: 'active', scheduleId: a.scheduleId });
      expect(new Date(restored.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
      expect(restored.lastRun).toMatchObject({ status: 'succeeded' });
      expect(await ownedSchedules(a.id)).toEqual([
        expect.objectContaining({ id: a.scheduleId, enabled: true, linked: true }),
      ]);
      expect(await runsOfSchedule(a.scheduleId!)).toHaveLength(1);
    });

    it('a paused one comes back paused, with its reason and failure streak', async () => {
      const a = await automationService.create(hourly('Paused by its agent'), agentA());
      await sql(`UPDATE public.automations SET consecutive_failures = 2 WHERE id = $1`, [a.id]);
      await automationService.pause(a.id, agentA());
      const deleted = await automationService.cancel(a.id, PERSON);
      expect(deleted.pausedReason).toBeNull();

      const restored = await automationService.resume(a.id, PERSON);
      expect(restored).toMatchObject({
        status: 'paused',
        pausedReason: 'agent',
        consecutiveFailures: 2,
        scheduleId: a.scheduleId,
        nextRunAt: null,
      });
      expect(await ownedSchedules(a.id)).toEqual([
        expect.objectContaining({ enabled: false, next_run_at: null, linked: true }),
      ]);
      // From paused, resume is the usual one: active, fresh streak.
      expect(await automationService.resume(a.id, PERSON)).toMatchObject({
        status: 'active',
        pausedReason: null,
        consecutiveFailures: 0,
      });
    });

    it('a deleted row with no kept schedule restores onto a new one', async () => {
      const hourlyOne = await automationService.create(hourly('Old hourly'), PERSON);
      const pastOnce = await automationService.create(
        { ...hourly('Old once'), when: { in: '2h' } },
        PERSON
      );
      await sql(`UPDATE public.automations SET at = now() - interval '1 day' WHERE id = $1`, [
        pastOnce.id,
      ]);
      for (const a of [hourlyOne, pastOnce]) {
        await sql(`DELETE FROM public.schedules WHERE id = $1`, [a.scheduleId]);
        await sql(`UPDATE public.automations SET status = 'cancelled' WHERE id = $1`, [a.id]);
      }

      const active = await automationService.resume(hourlyOne.id, PERSON);
      expect(active.status).toBe('active');
      expect(active.scheduleId).not.toBeNull();
      expect(active.scheduleId).not.toBe(hourlyOne.scheduleId);
      expect(await ownedSchedules(hourlyOne.id)).toEqual([
        expect.objectContaining({ id: active.scheduleId, enabled: true, linked: true }),
      ]);

      const finished = await automationService.resume(pastOnce.id, PERSON);
      expect(finished).toMatchObject({ status: 'finished', nextRunAt: null });
      expect(await ownedSchedules(pastOnce.id)).toEqual([
        expect.objectContaining({ enabled: false, next_run_at: null, linked: true }),
      ]);
    });
  });

  describe('archive (a deleted automation is an archived one)', () => {
    const updatedAt = async (id: string) =>
      (
        await sql<{ at: string }>(
          `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at
             FROM public.automations WHERE id = $1`,
          [id]
        )
      )[0]?.at;

    it('restoreArchived brings a deleted one back as it was, and leaves any other as it is', async () => {
      const a = await automationService.create(hourly('Paused by its agent'), agentA());
      await sql(`UPDATE public.automations SET consecutive_failures = 2 WHERE id = $1`, [a.id]);
      await automationService.pause(a.id, agentA());
      await automationService.cancel(a.id, PERSON);
      // Listed as archived (the Archive drawer's automations).
      expect((await Automations.listCanceled()).map((row) => row.id)).toEqual([a.id]);

      const restored = await automationService.restoreArchived(a.id, PERSON);
      expect(restored).toMatchObject({
        status: 'paused',
        pausedReason: 'agent',
        consecutiveFailures: 2,
        scheduleId: a.scheduleId,
        nextRunAt: null,
      });
      expect(await Automations.listCanceled()).toEqual([]);

      // Restored meanwhile (a stale drawer): no change, where resume would activate it.
      const before = await updatedAt(a.id);
      expect(await automationService.restoreArchived(a.id, PERSON)).toMatchObject({
        status: 'paused',
        pausedReason: 'agent',
      });
      expect(await updatedAt(a.id)).toBe(before);
      expect(await ownedSchedules(a.id)).toEqual([
        expect.objectContaining({ enabled: false, next_run_at: null, linked: true }),
      ]);

      // Agents restore only their own; an automated run nothing.
      const other = await automationService.create(hourly('By a person'), PERSON);
      await automationService.cancel(other.id, PERSON);
      await expect(automationService.restoreArchived(other.id, agentA())).rejects.toThrow(
        'You can only change automations you created.'
      );
      await expect(automationService.restoreArchived('automation-missing', PERSON)).rejects.toThrow(
        'not found'
      );
    });

    it("restoreArchived is refused at the agent's active limit, stays archived, and works once there is room", async () => {
      const archived = await automationService.create(hourly('Archived'), PERSON);
      await automationService.cancel(archived.id, PERSON);
      const others = [];
      for (let i = 0; i < 10; i += 1)
        others.push(await automationService.create(hourly(`Check ${i}`), PERSON));

      await expect(automationService.restoreArchived(archived.id, PERSON)).rejects.toMatchObject({
        statusCode: 409,
        message: 'Test Agent A already has 10 active automations. Pause or cancel one first.',
        details: { reason: 'active_limit', active: 10, max: 10 },
      });
      // Nothing moved: still archived, its kept schedule still parked.
      expect(await automationService.get(archived.id)).toMatchObject({
        status: 'cancelled',
        scheduleId: null,
      });
      expect((await Automations.listCanceled()).map((row) => row.id)).toEqual([archived.id]);
      expect(await ownedSchedules(archived.id)).toEqual([
        expect.objectContaining({ enabled: false, next_run_at: null, linked: false }),
      ]);

      await automationService.pause(others[0]!.id, PERSON);
      expect(await automationService.restoreArchived(archived.id, PERSON)).toMatchObject({
        status: 'active',
        scheduleId: archived.scheduleId,
      });
    });

    it('purge deletes a deleted one for good, with its kept schedule, runs and reminder settings', async () => {
      const a = await automationService.create(hourly('Build check'), PERSON);
      await automationService.runNow(a.id);
      await waitFor(async () => !automationService.isWakeLive(a.id));
      await sql(
        `INSERT INTO public.reminder_settings (kind, automation_id) VALUES ('automation', $1)`,
        [a.id]
      );

      // A live one is refused: archive it first.
      await expect(automationService.purge(a.id, PERSON)).rejects.toThrow("isn't archived");
      expect(await ownedSchedules(a.id)).toHaveLength(1);

      await automationService.cancel(a.id, PERSON);
      jest.mocked(wsService.broadcastToChannel).mockClear();
      const was = await automationService.purge(a.id, PERSON);
      expect(was).toMatchObject({ id: a.id, status: 'cancelled', name: 'Build check' });

      expect(await sql(`SELECT 1 FROM public.automations WHERE id = $1`, [a.id])).toEqual([]);
      expect(await ownedSchedules(a.id)).toEqual([]);
      expect(await runsOfSchedule(a.scheduleId!)).toEqual([]);
      expect(
        await sql(`SELECT 1 FROM public.reminder_settings WHERE automation_id = $1`, [a.id])
      ).toEqual([]);
      // The wake it posted stays in its thread.
      expect(
        await sql(`SELECT 1 FROM public.messages WHERE metadata->'automation'->>'id' = $1`, [a.id])
      ).toHaveLength(1);
      expect(wsService.broadcastToChannel).toHaveBeenCalledWith('workspace', {
        type: 'automations:changed',
        payload: { automationId: a.id },
      });
      await expect(automationService.get(a.id)).rejects.toThrow('not found');
      await expect(automationService.purge(a.id, PERSON)).rejects.toThrow('not found');
    });

    it('purgeArchived purges every deleted one and leaves the rest', async () => {
      const live = await automationService.create(hourly('Live'), PERSON);
      const paused = await automationService.create(hourly('Paused'), PERSON);
      await automationService.pause(paused.id, PERSON);
      const gone = [
        await automationService.create(hourly('Gone one'), PERSON),
        await automationService.create(hourly('Gone two'), PERSON),
      ];
      for (const a of gone) await automationService.cancel(a.id, PERSON);

      expect(await automationService.purgeArchived(PERSON)).toBe(2);
      expect((await automationService.list()).map((a) => [a.name, a.status]).sort()).toEqual([
        ['Live', 'active'],
        ['Paused', 'paused'],
      ]);
      expect(await ownedSchedules(live.id)).toHaveLength(1);
      expect(await automationService.purgeArchived(PERSON)).toBe(0);
    });

    it("a wake that succeeds after the delete leaves the deleted row's archive time and streak", async () => {
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => (finish = resolve));
      // The agent's run completes only once the automation is deleted.
      dispatchMock.mockImplementationOnce(async () => {
        await settled;
        await sql(
          `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
           VALUES (gen_random_uuid()::text, $1, $2, 'test-provider', 'test-model', 'completed', now() + interval '1 second')`,
          [THREAD_A, AGENT_A]
        );
        return COMPLETED;
      });
      const a = await automationService.create(hourly('Slow wake'), PERSON);
      await sql(`UPDATE public.automations SET consecutive_failures = 1 WHERE id = $1`, [a.id]);
      await automationService.runNow(a.id);
      await automationService.cancel(a.id, PERSON);
      const archivedAt = await updatedAt(a.id);

      finish();
      await waitFor(async () => !automationService.isWakeLive(a.id));
      expect(await updatedAt(a.id)).toBe(archivedAt);
      expect((await automationService.get(a.id)).consecutiveFailures).toBe(1);
    });

    it('a delete committing while a running scheduler claims the wake keeps its schedule parked', async () => {
      const a = await automationService.create(hourly('Deleted mid-tick'), PERSON);
      scheduleService.start();
      // The delete commits between the tick reading the due row and advancing
      // it (during the missed-run check, which runs in that gap).
      const grace = jest
        .spyOn(automationService, 'missedGraceMs')
        .mockImplementationOnce(async () => {
          await automationService.cancel(a.id, PERSON);
          return 3_600_000;
        });
      try {
        // Mid-session: boot reconcile is past; the schedule comes due now.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await sql(
          `UPDATE public.schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
          [a.scheduleId]
        );
        scheduleService.notifySchedulesChanged([a.scheduleId!]);
        await waitFor(async () => (await runsOfSchedule(a.scheduleId!)).length === 1);
        await waitFor(async () => !automationService.isWakeLive(a.id));
        // Later ticks find nothing due.
        await new Promise((resolve) => setTimeout(resolve, 600));
      } finally {
        scheduleService.stop();
      }
      // The delete did land inside the tick (mockRestore clears the calls).
      expect(grace).toHaveBeenCalled();
      grace.mockRestore();
      const runs = await sql<{ status: string; error: string | null }>(
        `SELECT status, error FROM public.schedule_runs WHERE schedule_id = $1`,
        [a.scheduleId]
      );
      expect(runs).toEqual([{ status: 'skipped', error: 'Automation is canceled' }]);
      expect(await ownedSchedules(a.id)).toEqual([
        expect.objectContaining({ enabled: false, next_run_at: null, linked: false }),
      ]);
      expect(dispatchMock).not.toHaveBeenCalled();
      expect((await automationService.get(a.id)).status).toBe('cancelled');
    });

    it("boot reconcile parks a deleted one's schedule left enabled and due, so it never fires", async () => {
      const a = await automationService.create(hourly('Archived hourly'), PERSON);
      await automationService.cancel(a.id, PERSON);
      // Drift: the kept schedule enabled and due (as if a crash left it so).
      await sql(
        `UPDATE public.schedules SET enabled = true, next_run_at = now() - interval '1 minute'
          WHERE id = $1`,
        [a.scheduleId]
      );

      scheduleService.start();
      try {
        // Boot reconcile parks it again before the first tick.
        await waitFor(async () => (await ownedSchedules(a.id))[0]?.enabled === false);
        await new Promise((resolve) => setTimeout(resolve, 600));
      } finally {
        scheduleService.stop();
      }
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(await runsOfSchedule(a.scheduleId!)).toEqual([]);
      expect(
        await sql(`SELECT 1 FROM public.messages WHERE thread_id = $1`, [THREAD_A])
      ).toHaveLength(0);
      expect((await automationService.get(a.id)).status).toBe('cancelled');
    });
  });

  describe('which calendar (null = none)', () => {
    const once = (name = 'Once') => ({ ...hourly(name), when: { in: '2h' } });
    const daily = (name = 'Daily') => ({
      ...hourly(name),
      when: { repeat: 'FREQ=DAILY', at: '09:00' },
    });

    it('maps a move racing calendar deletion to a friendly 400', async () => {
      const automation = await automationService.create(once('Moving'), PERSON);
      const calendar = await createCalendar({ title: 'Destination' });
      let release!: () => void;
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deletion = transaction(async (tx) => {
        await tx.query('SELECT id FROM public.calendars WHERE id=$1 FOR UPDATE', [calendar.id]);
        locked();
        await wait;
        await tx.query('DELETE FROM public.calendars WHERE id=$1', [calendar.id]);
      });
      await holding;
      const rejected = expect(
        automationService.update(automation.id, { calendarId: calendar.id }, PERSON)
      ).rejects.toMatchObject({ statusCode: 400, message: 'That calendar no longer exists' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      release();
      await deletion;
      await rejected;
    });

    it('create: null is no calendar for a once and a repeat; left out is the Default one', async () => {
      const onDefault = await automationService.create(once('On default'), PERSON);
      expect(onDefault.calendarId).not.toBeNull();
      const none = await automationService.create(
        { ...once('No calendar'), calendarId: null },
        PERSON
      );
      expect(none).toMatchObject({ calendarId: null, calendarTitle: null });
      const repeat = await automationService.create({ ...daily(), calendarId: null }, agentA());
      expect(repeat.calendarId).toBeNull();
      const every = await automationService.create({ ...hourly(), calendarId: null }, PERSON);
      expect(every.calendarId).toBeNull();
      const everyOnDefault = await automationService.create(hourly('Every on default'), PERSON);
      expect(everyOnDefault.calendarId).toBe(onDefault.calendarId);
      for (const blank of ['', '  ']) {
        await expect(
          automationService.create({ ...once('Blank'), calendarId: blank }, PERSON)
        ).rejects.toThrow('calendar_id must be a calendar id, or null for no calendar.');
      }
    });

    it('announces a Default calendar it makes only once the write commits', async () => {
      await sql(`DELETE FROM public.nodes WHERE type = 'calendar_event'`);
      await sql(`UPDATE public.table_fields SET calendar_id = NULL WHERE calendar_id IS NOT NULL`);
      await sql(`DELETE FROM public.calendars`);
      const broadcast = jest.mocked(wsService.broadcastToChannel);
      const calendarFrames = () =>
        broadcast.mock.calls
          .map(([, frame]) => frame as { type: string; payload: { kind: string } })
          .filter(
            (frame) => frame.type === 'calendar:changed' && frame.payload.kind === 'calendar'
          );

      // Rolled back after the Default calendar was made: no calendar, nothing announced.
      broadcast.mockClear();
      const insert = jest
        .spyOn(Automations, 'insert')
        .mockRejectedValueOnce(new Error('insert failed'));
      try {
        await expect(automationService.create(once('Rolled back'), PERSON)).rejects.toThrow(
          'insert failed'
        );
      } finally {
        insert.mockRestore();
      }
      expect(await sql(`SELECT id FROM public.calendars`)).toEqual([]);
      expect(calendarFrames()).toEqual([]);

      // Committed: announced once, when another connection can already read it.
      const visible: Array<Promise<unknown[]>> = [];
      broadcast.mockImplementation((_channel, frame) => {
        const { type, payload } = frame as {
          type: string;
          payload: { kind: string; calendarId?: string };
        };
        if (type === 'calendar:changed' && payload.kind === 'calendar')
          visible.push(sql(`SELECT id FROM public.calendars WHERE id = $1`, [payload.calendarId]));
      });
      try {
        const made = await automationService.create(once('Committed'), PERSON);
        expect(made.calendarId).not.toBeNull();
        expect(calendarFrames()).toEqual([
          { type: 'calendar:changed', payload: { kind: 'calendar', calendarId: made.calendarId } },
        ]);
        expect(await Promise.all(visible)).toEqual([[{ id: made.calendarId }]]);
      } finally {
        broadcast.mockReset();
      }
    });

    it('update: null takes it off, other changes keep none, an id puts it back', async () => {
      const a = await automationService.create(once(), PERSON);
      const defaultId = a.calendarId!;
      jest.mocked(wsService.broadcastToChannel).mockClear();
      expect((await automationService.update(a.id, { calendarId: null }, PERSON)).calendarId).toBe(
        null
      );
      // The calendar it left redraws.
      expect(wsService.broadcastToChannel).toHaveBeenCalledWith('workspace', {
        type: 'calendar:changed',
        payload: { kind: 'automation', automationId: a.id, calendarId: defaultId },
      });
      const retimed = await automationService.update(
        a.id,
        { name: 'Renamed', when: { repeat: 'FREQ=DAILY', at: '10:00' } },
        PERSON
      );
      expect(retimed).toMatchObject({ name: 'Renamed', calendarId: null });
      expect(
        (await automationService.update(a.id, { calendarId: defaultId }, PERSON)).calendarId
      ).toBe(defaultId);
      expect(
        (await automationService.update(a.id, { when: { in: '3h' } }, PERSON)).calendarId
      ).toBe(defaultId);
    });

    it('a timing change keeps the calendar, to and from Every, none included', async () => {
      const defaultId = (await automationService.create(once('Reference'), PERSON)).calendarId;
      const a = await automationService.create(once('Once to Every'), PERSON);
      const toEvery = await automationService.update(a.id, { when: { every: '1h' } }, PERSON);
      expect(toEvery).toMatchObject({ when: { kind: 'interval' }, calendarId: defaultId });
      const back = await automationService.update(
        a.id,
        { when: { repeat: 'FREQ=DAILY', at: '09:00' } },
        PERSON
      );
      expect(back).toMatchObject({ when: { kind: 'repeat' }, calendarId: defaultId });

      // An Every with no calendar stays none.
      const b = await automationService.create(
        { ...hourly('Every, none'), calendarId: null },
        PERSON
      );
      expect(
        (await automationService.update(b.id, { when: { in: '2h' } }, PERSON)).calendarId
      ).toBeNull();
      expect(
        (
          await automationService.update(
            b.id,
            { when: { every: '2h' }, calendarId: defaultId },
            PERSON
          )
        ).calendarId
      ).toBe(defaultId);
      expect(
        (await automationService.update(b.id, { calendarId: null }, PERSON)).calendarId
      ).toBeNull();
    });

    it('pause, resume and restore keep an Every on its calendar', async () => {
      const a = await automationService.create(hourly('Every on a calendar'), PERSON);
      const calendarId = a.calendarId;
      expect(calendarId).not.toBeNull();
      await automationService.pause(a.id, PERSON);
      expect(await automationService.resume(a.id, PERSON)).toMatchObject({
        status: 'active',
        calendarId,
      });
      await automationService.cancel(a.id, PERSON);
      expect(await automationService.resume(a.id, PERSON)).toMatchObject({
        status: 'active',
        calendarId,
      });
    });

    it('resume and restore keep no calendar as none', async () => {
      const a = await automationService.create({ ...daily(), calendarId: null }, PERSON);
      await automationService.pause(a.id, PERSON);
      expect(await automationService.resume(a.id, PERSON)).toMatchObject({
        status: 'active',
        calendarId: null,
      });
      await automationService.cancel(a.id, PERSON);
      expect(await automationService.resume(a.id, PERSON)).toMatchObject({
        status: 'active',
        calendarId: null,
      });
      await automationService.pause(a.id, PERSON);
      await automationService.cancel(a.id, PERSON);
      expect(await automationService.resume(a.id, PERSON)).toMatchObject({
        status: 'paused',
        calendarId: null,
      });
    });
  });

  describe('guardrails', () => {
    it('agents schedule only themselves, in their own thread, and change only their own', async () => {
      await expect(
        automationService.create(
          { ...hourly(), when: { every: '1h' }, threadId: THREAD_B },
          agentA()
        )
      ).rejects.toThrow('Agents can only schedule wakes in their own thread.');
      await expect(
        automationService.create({ ...hourly(), agentId: AGENT_B }, agentA())
      ).rejects.toThrow('Agents can only schedule wakes for themselves.');

      const byPerson = await automationService.create(hourly('Set by a person'), PERSON);
      const byB = await automationService.create(
        { ...hourly('B check'), threadId: THREAD_B, agentId: AGENT_B },
        { kind: 'agent', agentId: AGENT_B, threadId: THREAD_B, runId: null }
      );
      for (const target of [byPerson, byB]) {
        await expect(automationService.pause(target.id, agentA())).rejects.toThrow(
          'You can only change automations you created.'
        );
        await expect(automationService.cancel(target.id, agentA())).rejects.toThrow(
          'You can only change automations you created.'
        );
        await expect(
          automationService.update(target.id, { name: 'Mine now' }, agentA())
        ).rejects.toThrow('You can only change automations you created.');
      }
      // A person may change any.
      expect((await automationService.pause(byB.id, PERSON)).pausedReason).toBe('user');
    });

    it('only a person in the app sets what an unattended run does', async () => {
      const POLICY_REFUSAL = 'Only a person in Snaglet can change what an unattended run does.';
      const EXTERNAL: AutomationActor = { kind: 'person', external: true };

      // Default: skip, for a person's and an agent's automation alike.
      const mine = await automationService.create(hourly('Agent made'), agentA());
      expect(mine.unattendedPolicy).toBe('skip');
      const byPerson = await automationService.create(
        { ...hourly('Person made'), unattendedPolicy: 'auto-approve-allowed' },
        PERSON
      );
      expect(byPerson.unattendedPolicy).toBe('auto-approve-allowed');

      // The agent it wakes and an external client can't loosen (or set) it.
      await expect(
        automationService.update(mine.id, { unattendedPolicy: 'auto-approve-allowed' }, agentA())
      ).rejects.toThrow(POLICY_REFUSAL);
      await expect(
        automationService.create(
          { ...hourly('Agent tries'), unattendedPolicy: 'auto-approve-allowed' },
          agentA()
        )
      ).rejects.toThrow(POLICY_REFUSAL);
      await expect(
        automationService.update(mine.id, { unattendedPolicy: 'skip' }, EXTERNAL)
      ).rejects.toThrow(POLICY_REFUSAL);
      await expect(
        automationService.update(mine.id, { unattendedPolicy: 'approve-all' }, PERSON)
      ).rejects.toThrow('unattendedPolicy must be one of: skip, auto-approve-allowed.');
      expect((await automationService.get(mine.id)).unattendedPolicy).toBe('skip');

      // A person changes it, and a person's other edits keep it.
      const loosened = await automationService.update(
        mine.id,
        { unattendedPolicy: 'auto-approve-allowed' },
        PERSON
      );
      expect(loosened.unattendedPolicy).toBe('auto-approve-allowed');
      const renamedByPerson = await automationService.update(mine.id, { name: 'Renamed' }, PERSON);
      expect(renamedByPerson.unattendedPolicy).toBe('auto-approve-allowed');

      // Any edit by the agent (its prompt, timing, even its name) puts it back
      // to skip: a person approved what it was and must choose again.
      const reprompted = await automationService.update(
        mine.id,
        { prompt: 'Do something else.' },
        agentA()
      );
      expect(reprompted.unattendedPolicy).toBe('skip');
      await automationService.update(mine.id, { unattendedPolicy: 'auto-approve-allowed' }, PERSON);
      const renamedByAgent = await automationService.update(mine.id, { name: 'Mine' }, agentA());
      expect(renamedByAgent.unattendedPolicy).toBe('skip');
      // So does an external client's edit (held to the agent limits).
      const personMade = await automationService.create(
        { ...hourly('Person made 2'), unattendedPolicy: 'auto-approve-allowed' },
        PERSON
      );
      const byExternal = await automationService.update(
        personMade.id,
        { prompt: 'Changed from outside.' },
        EXTERNAL
      );
      expect(byExternal.unattendedPolicy).toBe('skip');
    });

    it('a run an automation started can create or change nothing', async () => {
      const mine = await automationService.create(hourly(), agentA());
      await expect(automationService.create(hourly(), AUTOMATED_A)).rejects.toThrow(
        AUTOMATED_RUN_REFUSAL
      );
      await expect(automationService.update(mine.id, { name: 'x' }, AUTOMATED_A)).rejects.toThrow(
        AUTOMATED_RUN_REFUSAL
      );
      await expect(automationService.pause(mine.id, AUTOMATED_A)).rejects.toThrow(
        AUTOMATED_RUN_REFUSAL
      );
      await expect(automationService.cancel(mine.id, AUTOMATED_A)).rejects.toThrow(
        AUTOMATED_RUN_REFUSAL
      );
      expect((await automationService.get(mine.id)).status).toBe('active');
    });

    it('agents keep to a 15-minute interval floor, people to 1 minute, both to 7 days', async () => {
      await expect(
        automationService.create({ ...hourly(), when: { every: '5m' } }, agentA())
      ).rejects.toThrow('every must be at least 15m for agents (1m for people).');
      const quick = await automationService.create({ ...hourly(), when: { every: '1m' } }, PERSON);
      expect(quick.when).toMatchObject({ kind: 'interval', everyMs: 60_000 });
      await expect(
        automationService.create({ ...hourly(), when: { every: '8d' } }, PERSON)
      ).rejects.toThrow('every must be at most 7d.');
      await expect(
        automationService.create(
          { ...hourly(), when: { every: '1h' }, calendarId: 'calendar-1111-missing' },
          PERSON
        )
      ).rejects.toThrow('Calendar calendar-1111-missing not found.');
      await expect(
        automationService.create(
          { ...hourly(), when: { in: '1h' }, calendarId: 'calendar-1111-missing' },
          PERSON
        )
      ).rejects.toThrow('Calendar calendar-1111-missing not found.');
    });

    it('holds 10 active per agent on create and resume, also under two concurrent creates', async () => {
      const made = [];
      for (let i = 0; i < 9; i += 1)
        made.push(await automationService.create(hourly(`Check ${i}`), PERSON));
      const racing = await Promise.allSettled([
        automationService.create(hourly('Race 1'), PERSON),
        automationService.create(hourly('Race 2'), PERSON),
      ]);
      expect(racing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = racing.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(refused.reason)).toMatch(
        'Test Agent A already has 10 active automations. Pause or cancel one first.'
      );
      const [active] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM public.automations WHERE agent_id = $1 AND status = 'active'`,
        [AGENT_A]
      );
      expect(active!.n).toBe(10);

      await automationService.pause(made[0]!.id, PERSON);
      await automationService.create(hourly('Takes the slot'), PERSON);
      await expect(automationService.resume(made[0]!.id, PERSON)).rejects.toThrow(
        /already has 10 active automations/
      );
      // Agents hear it in their own words.
      await expect(
        automationService.create(hourly('One more'), agentA('run-1111111111111-quota'))
      ).rejects.toThrow('You already have 10 active automations. Pause or cancel one first.');
    });

    it('allows at most 3 created per run', async () => {
      const run = 'run-1111111111111-percapaaa';
      for (let i = 0; i < 3; i += 1)
        await automationService.create(hourly(`Run ${i}`), agentA(run));
      await expect(automationService.create(hourly('Fourth'), agentA(run))).rejects.toThrow(
        'You can create at most 3 automations per run.'
      );
      await automationService.create(hourly('Next run'), agentA('run-1111111111111-percapbbb'));
    });

    it('agents Run now only their own, not from an automated run, 3 an hour; people have no limit', async () => {
      const mine = await automationService.create(hourly(), agentA());
      const byPerson = await automationService.create(hourly('Set by a person'), PERSON);
      await expect(automationService.runNow(byPerson.id, agentA())).rejects.toThrow(
        'You can only run automations you created.'
      );
      await expect(automationService.runNow(mine.id, AUTOMATED_A)).rejects.toThrow(
        AUTOMATED_RUN_NOW_REFUSAL
      );
      expect(dispatchMock).not.toHaveBeenCalled();
      for (let i = 0; i < 3; i += 1) {
        expect((await automationService.runNow(mine.id, agentA())).run.status).toBe('succeeded');
        await waitFor(async () => !automationService.isWakeLive(mine.id));
      }
      await expect(automationService.runNow(mine.id, agentA())).rejects.toThrow(
        /^You can run an automation at most 3 times an hour\. Try this one again after /
      );
      expect(dispatchMock).toHaveBeenCalledTimes(3);
      expect((await automationService.runNow(mine.id, PERSON)).run.status).toBe('succeeded');
      expect(dispatchMock).toHaveBeenCalledTimes(4);
    });
  });

  describe('firing', () => {
    it('posts the labeled prompt as the local user and wakes the agent with the marker', async () => {
      const a = await automationService.create(hourly('Build check'), PERSON);
      const result = await automationService.runNow(a.id);
      expect(result.run).toEqual({ status: 'succeeded', error: null });
      const [message] = await sql<{
        content: string;
        metadata: Record<string, unknown>;
        user_id: string | null;
      }>(`SELECT content, metadata, user_id FROM public.messages WHERE thread_id = $1`, [THREAD_A]);
      expect(message!.content).toBe('[automation Build check] @Test Agent A Look at the build.');
      expect(message!.user_id).not.toBeNull();
      expect(message!.metadata).toMatchObject({ automation: { id: a.id, name: 'Build check' } });
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: THREAD_A,
          targetAgentId: AGENT_A,
          source: 'tool',
          wakeOrigin: { kind: 'automation', automationId: a.id },
        })
      );
    });

    it('a paused or canceled automation posts nothing when its schedule fires', async () => {
      const a = await automationService.create(hourly(), PERSON);
      await automationService.pause(a.id, PERSON);
      const ctx = { scheduleRunId: 'schedule_run-test', scheduledFor: new Date(), manual: false };
      await expect(automationService.fire(a.id, ctx)).rejects.toThrow(
        new ScheduleRunSkipped('Automation is paused')
      );
      await automationService.cancel(a.id, PERSON);
      await expect(automationService.fire(a.id, ctx)).rejects.toThrow('Automation is canceled');
      expect(
        await sql(`SELECT 1 FROM public.messages WHERE thread_id = $1`, [THREAD_A])
      ).toHaveLength(0);
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('skips a wake while the previous one is still going', async () => {
      let finish!: (value: unknown) => void;
      dispatchMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const a = await automationService.create(hourly(), PERSON);
      expect((await automationService.runNow(a.id)).run.status).toBe('succeeded');
      expect(await automationService.runNow(a.id)).toMatchObject({
        run: { status: 'skipped', error: 'Previous run is still going' },
      });
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      finish(COMPLETED);
      await waitFor(async () => !automationService.isWakeLive(a.id));
    });

    it('reads as running while a wake is going, and announces its start and end', async () => {
      let finish!: (value: unknown) => void;
      dispatchMock.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const a = await automationService.create(hourly(), PERSON);
      expect(a).toMatchObject({ running: false, runningSince: null });
      type Frame = { type?: string; payload?: { automationId?: string } };
      const changedFor = () =>
        jest.mocked(wsService.broadcastToChannel).mock.calls.filter(([, frame]) => {
          const { type, payload } = frame as Frame;
          return type === 'automations:changed' && payload?.automationId === a.id;
        }).length;
      const before = changedFor();

      const { automation } = await automationService.runNow(a.id);
      expect(automation.running).toBe(true);
      expect(Date.parse(automation.runningSince ?? '')).not.toBeNaN();
      expect((await automationService.list()).find((x) => x.id === a.id)?.running).toBe(true);
      expect(changedFor()).toBeGreaterThan(before);

      const atStart = changedFor();
      finish(COMPLETED);
      await waitFor(async () => !automationService.isWakeLive(a.id));
      await waitFor(async () => changedFor() > atStart);
      expect(await automationService.get(a.id)).toMatchObject({
        running: false,
        runningSince: null,
      });
    });

    it('pauses after 3 failed wakes and notifies; a success resets the streak', async () => {
      const failRun = async () => {
        await sql(
          `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, error, started_at)
           VALUES (gen_random_uuid()::text, $1, $2, 'test-provider', 'test-model', 'failed', 'Provider exploded', now())`,
          [THREAD_A, AGENT_A]
        );
        return COMPLETED;
      };
      const failures = async (id: string) =>
        (
          await sql<{ n: number }>(
            `SELECT consecutive_failures AS n FROM public.automations WHERE id = $1`,
            [id]
          )
        )[0]!.n;
      dispatchMock.mockImplementation(failRun);
      const a = await automationService.create(hourly('Flaky'), PERSON);

      await automationService.runNow(a.id);
      await waitFor(async () => (await failures(a.id)) === 1);
      // A success resets.
      dispatchMock.mockImplementationOnce(async () => {
        await sql(
          `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
           VALUES (gen_random_uuid()::text, $1, $2, 'test-provider', 'test-model', 'completed', now() + interval '1 second')`,
          [THREAD_A, AGENT_A]
        );
        return COMPLETED;
      });
      await waitFor(async () => !automationService.isWakeLive(a.id));
      await automationService.runNow(a.id);
      await waitFor(async () => (await failures(a.id)) === 0);
      await waitFor(async () => !automationService.isWakeLive(a.id));

      for (let i = 1; i <= 3; i += 1) {
        await sql(`DELETE FROM public.runs WHERE thread_id = $1`, [THREAD_A]);
        await automationService.runNow(a.id);
        await waitFor(async () => (await failures(a.id)) === i);
        await waitFor(async () => !automationService.isWakeLive(a.id));
      }
      const paused = await automationService.get(a.id);
      expect(paused).toMatchObject({
        status: 'paused',
        pausedReason: 'failures',
        consecutiveFailures: 3,
      });
      expect(paused.lastRun).toMatchObject({ status: 'failed', error: 'Provider exploded' });
      expect((await ownedSchedules(a.id))[0]).toMatchObject({ enabled: false });
      expect(await notices()).toEqual([
        {
          title: '"Flaky" paused after 3 failed runs',
          body: 'Last error: Provider exploded.',
          thread_id: THREAD_A,
          agent_id: AGENT_A,
        },
      ]);
      // Resuming starts a fresh streak.
      expect((await automationService.resume(a.id, PERSON)).consecutiveFailures).toBe(0);
    });
  });

  describe('the missed-run rule (through the scheduler tick)', () => {
    async function tickUntil(check: () => Promise<boolean>): Promise<void> {
      scheduleService.start();
      try {
        await waitFor(check);
      } finally {
        scheduleService.stop();
      }
    }
    const runsOf = (scheduleId: string) =>
      sql<{ status: string; error: string | null }>(
        `SELECT status, error FROM public.schedule_runs WHERE schedule_id = $1 ORDER BY started_at`,
        [scheduleId]
      );
    const due = (scheduleId: string, ago: string) =>
      sql(`UPDATE public.schedules SET next_run_at = now() - $2::interval WHERE id = $1`, [
        scheduleId,
        ago,
      ]);

    it('runs a wake 30 minutes late once, and skips one 2 hours late past now', async () => {
      const late = await automationService.create(hourly('Late'), PERSON);
      const missed = await automationService.create(
        { ...hourly('Missed'), when: { repeat: 'FREQ=DAILY', at: '09:00' } },
        PERSON
      );
      await due(late.scheduleId!, '30 minutes');
      await due(missed.scheduleId!, '2 hours');
      await tickUntil(
        async () =>
          (await runsOf(late.scheduleId!)).length === 1 &&
          (await runsOf(missed.scheduleId!)).length === 1
      );
      expect(await runsOf(late.scheduleId!)).toEqual([{ status: 'succeeded', error: null }]);
      expect(await runsOf(missed.scheduleId!)).toEqual([
        { status: 'skipped', error: 'Missed while Snaglet was off' },
      ]);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      for (const a of [late, missed]) {
        const [s] = await ownedSchedules(a.id);
        expect(new Date(s!.next_run_at!).getTime()).toBeGreaterThan(Date.now());
      }
      expect((await automationService.get(missed.id)).status).toBe('active');
      expect(await notices()).toEqual([]);
    });

    it('fires a wake with no calendar on time: the schedule fires it, not the calendar', async () => {
      const a = await automationService.create(
        {
          ...hourly('Off calendar'),
          when: { repeat: 'FREQ=DAILY', at: '09:00' },
          calendarId: null,
        },
        PERSON
      );
      expect(a.calendarId).toBeNull();
      await due(a.scheduleId!, '1 minute');
      await tickUntil(async () => (await runsOf(a.scheduleId!)).length === 1);
      expect(await runsOf(a.scheduleId!)).toEqual([{ status: 'succeeded', error: null }]);
      expect(dispatchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: THREAD_A,
          targetAgentId: AGENT_A,
          wakeOrigin: { kind: 'automation', automationId: a.id },
        })
      );
    });

    it('collapses an interval backlog into one run', async () => {
      const a = await automationService.create(
        { ...hourly('Every 15'), when: { every: '15m' } },
        PERSON
      );
      await due(a.scheduleId!, '50 minutes');
      await tickUntil(async () => (await runsOf(a.scheduleId!)).length > 0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await runsOf(a.scheduleId!)).toHaveLength(1);
      expect(new Date((await ownedSchedules(a.id))[0]!.next_run_at!).getTime()).toBeGreaterThan(
        Date.now()
      );
    });

    it('skips a late windowed wake once its window has closed, and runs one still inside it', async () => {
      // HH:mm in UTC, `minutes` from now (a window may cross midnight).
      const hhmm = (minutes: number) =>
        new Date(Date.now() + minutes * 60_000).toISOString().slice(11, 16);
      const closedWindow = { start: hhmm(-40), end: hhmm(-5) };
      const closed = await automationService.create(
        {
          ...hourly('Closed window'),
          when: {
            every: '5m',
            window_start: closedWindow.start,
            window_end: closedWindow.end,
            tz: 'UTC',
          },
        },
        PERSON
      );
      const open = await automationService.create(
        {
          ...hourly('Open window'),
          when: { every: '5m', window_start: hhmm(-30), window_end: hhmm(30), tz: 'UTC' },
        },
        PERSON
      );
      // Both came due inside their window; only the open one may still run.
      await due(closed.scheduleId!, '10 minutes');
      await due(open.scheduleId!, '2 minutes');
      await tickUntil(
        async () =>
          (await runsOf(closed.scheduleId!)).length === 1 &&
          (await runsOf(open.scheduleId!)).length === 1
      );
      expect(await runsOf(closed.scheduleId!)).toEqual([
        { status: 'skipped', error: 'Missed: its window had closed' },
      ]);
      expect(await runsOf(open.scheduleId!)).toEqual([{ status: 'succeeded', error: null }]);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      const next = new Date((await ownedSchedules(closed.id))[0]!.next_run_at!);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(isWithinIntervalWindow(next, closedWindow, 'UTC')).toBe(true);
      expect((await automationService.get(closed.id)).status).toBe('active');
    });

    it('finishes a once missed by over an hour and notifies', async () => {
      const a = await automationService.create(
        { ...hourly('Standup note'), when: { in: '2h', tz: 'UTC' } },
        PERSON
      );
      await sql(`UPDATE public.automations SET at = now() - interval '3 hours' WHERE id = $1`, [
        a.id,
      ]);
      await due(a.scheduleId!, '3 hours');
      await tickUntil(async () => (await runsOf(a.scheduleId!)).length === 1);
      await waitFor(async () => (await automationService.get(a.id)).status === 'finished');
      expect(await runsOf(a.scheduleId!)).toEqual([
        { status: 'skipped', error: 'Missed while Snaglet was off' },
      ]);
      const [notice] = await notices();
      expect(notice).toMatchObject({ title: 'Missed: "Standup note"', thread_id: THREAD_A });
      expect(notice!.body).toMatch(/^Snaglet was off at .+\. It didn't run\.$/);
      await expect(automationService.resume(a.id, PERSON)).rejects.toThrow(
        'This automation has no more runs.'
      );
    });

    it('finishes a once after it runs, and a repeat whose COUNT is used up', async () => {
      const once = await automationService.create(
        { ...hourly('Once'), when: { in: '1h' } },
        PERSON
      );
      const count = await automationService.create(
        {
          ...hourly('Count'),
          when: {
            repeat: 'FREQ=DAILY;COUNT=1',
            at: '09:00',
            starts: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
            tz: 'UTC',
          },
        },
        PERSON
      );
      // The schedule's only occurrence was ten minutes ago (due, within the grace).
      const tenAgo = new Date(Date.now() - 10 * 60_000);
      await sql(`UPDATE public.schedules SET schedule_json = $2, next_run_at = $3 WHERE id = $1`, [
        count.scheduleId,
        JSON.stringify({
          rrule: 'FREQ=DAILY;COUNT=1',
          time: tenAgo.toISOString().slice(11, 16),
          startsOn: tenAgo.toISOString().slice(0, 10),
        }),
        new Date(Math.floor(tenAgo.getTime() / 60_000) * 60_000).toISOString(),
      ]);
      await due(once.scheduleId!, '1 minute');
      await tickUntil(
        async () =>
          (await automationService.get(once.id)).status === 'finished' &&
          (await automationService.get(count.id)).status === 'finished'
      );
      expect(dispatchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('when Snaglet first opens that day (through the scheduler tick)', () => {
    // A full wake unless a test says otherwise (the real check reads pmset).
    let fullWake: jest.SpiedFunction<typeof systemAwake.isFullWake>;
    beforeEach(() => {
      fullWake = jest.spyOn(systemAwake, 'isFullWake').mockResolvedValue(true);
    });
    afterEach(() => jest.restoreAllMocks());
    async function tickUntil(check: () => Promise<boolean>): Promise<void> {
      scheduleService.start();
      try {
        await waitFor(check);
      } finally {
        scheduleService.stop();
      }
    }
    const runsOf = (scheduleId: string) =>
      sql<{ status: string; error: string | null; scheduled_for: string }>(
        `SELECT status, error, scheduled_for FROM public.schedule_runs
          WHERE schedule_id = $1 ORDER BY started_at`,
        [scheduleId]
      );
    const setNextRun = (scheduleId: string, ago: string) =>
      sql(`UPDATE public.schedules SET next_run_at = now() - $2::interval WHERE id = $1`, [
        scheduleId,
        ago,
      ]);
    const nextRunAt = async (automationId: string) =>
      new Date((await ownedSchedules(automationId))[0]!.next_run_at!).getTime();
    /**
     * A fixed-offset zone where it is between 12:00 and 13:00 now, so 01:00
     * has passed today there and 23:00 has not.
     */
    function noonZone(): string {
      const offset = 12 - new Date().getUTCHours();
      if (offset === 0) return 'UTC';
      return `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
    }
    const firstOpen = (after: string, tz: string) => ({
      ...hourly('Morning show'),
      when: { first_open: true, after, tz },
    });

    it('stores it, runs it at the first tick after `after`, and then waits for tomorrow', async () => {
      const tz = noonZone();
      const a = await automationService.create(firstOpen('01:00', tz), PERSON);
      expect(a.when).toEqual({ kind: 'first_open', after: '01:00', tz });
      expect(a.whenText).toMatch(/^when Snaglet first opens, after 1:00 AM/);
      const [owned] = await ownedSchedules(a.id);
      expect(owned).toMatchObject({ schedule_kind: 'first_open', enabled: true, linked: true });
      // Made after today's 01:00: due from tomorrow's.
      expect(await nextRunAt(a.id)).toBeGreaterThan(Date.now() + 10 * 3_600_000);

      // Snaglet is open today after 01:00 and it has not run: the tick runs it,
      // claimed for today's 01:00 (one key a day).
      await setNextRun(a.scheduleId!, '1 minute');
      await tickUntil(async () => (await runsOf(a.scheduleId!)).length === 1);
      const [run] = await runsOf(a.scheduleId!);
      expect(run).toMatchObject({ status: 'succeeded', error: null });
      expect(new Date(run!.scheduled_for).getTime()).toBe(
        firstOpenSlot('01:00', tz, new Date()).getTime()
      );
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(await nextRunAt(a.id)).toBeGreaterThan(Date.now() + 10 * 3_600_000);

      // Due again the same day (a restart, a clock change): once a day only.
      await setNextRun(a.scheduleId!, '1 minute');
      await tickUntil(async () => (await nextRunAt(a.id)) > Date.now());
      expect(await runsOf(a.scheduleId!)).toHaveLength(1);
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });

    it('never catches up a day Snaglet was not open: a wake due days ago runs once, for today', async () => {
      const tz = noonZone();
      const a = await automationService.create(firstOpen('01:00', tz), PERSON);
      await setNextRun(a.scheduleId!, '3 days');
      await tickUntil(async () => (await runsOf(a.scheduleId!)).length === 1);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const runs = await runsOf(a.scheduleId!);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ status: 'succeeded', error: null });
      expect(new Date(runs[0]!.scheduled_for).getTime()).toBe(
        firstOpenSlot('01:00', tz, new Date()).getTime()
      );
    });

    it('does not run in a dark wake (lid closed, Power Nap): it looks again a minute later', async () => {
      fullWake.mockResolvedValue(false);
      const a = await automationService.create(firstOpen('01:00', noonZone()), PERSON);
      await setNextRun(a.scheduleId!, '1 minute');
      await tickUntil(async () => (await nextRunAt(a.id)) > Date.now());
      expect(await runsOf(a.scheduleId!)).toEqual([]);
      expect(dispatchMock).not.toHaveBeenCalled();
      const next = await nextRunAt(a.id);
      expect(next).toBeGreaterThan(Date.now() + 30_000);
      expect(next).toBeLessThan(Date.now() + 90_000);
      expect(fullWake).toHaveBeenCalled();

      // The lid opens: the next look runs it.
      fullWake.mockResolvedValue(true);
      await setNextRun(a.scheduleId!, '1 second');
      await tickUntil(
        async () =>
          (await runsOf(a.scheduleId!)).length === 1 && dispatchMock.mock.calls.length === 1
      );
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });

    it('waits for the network before its claim: while it is down nothing is written and the day is kept', async () => {
      const check = jest.spyOn(networkGuard, 'check').mockResolvedValue('down');
      const a = await automationService.create(firstOpen('01:00', noonZone()), PERSON);
      await setNextRun(a.scheduleId!, '1 minute');
      await tickUntil(async () => (await nextRunAt(a.id)) > Date.now());
      expect(await runsOf(a.scheduleId!)).toEqual([]);
      const down = await nextRunAt(a.id);
      expect(down).toBeGreaterThan(Date.now() + 90_000);
      expect(down).toBeLessThan(Date.now() + 150_000);

      // Still probing after a start or wake: a shorter look again.
      check.mockResolvedValue('waiting');
      await setNextRun(a.scheduleId!, '1 second');
      await tickUntil(async () => (await nextRunAt(a.id)) > Date.now());
      expect(await runsOf(a.scheduleId!)).toEqual([]);
      expect(await nextRunAt(a.id)).toBeLessThan(Date.now() + 20_000);

      // It answers: the same day's run goes ahead.
      check.mockResolvedValue('ready');
      await setNextRun(a.scheduleId!, '1 second');
      await tickUntil(
        async () =>
          (await runsOf(a.scheduleId!)).length === 1 && dispatchMock.mock.calls.length === 1
      );
      expect((await runsOf(a.scheduleId!))[0]).toMatchObject({ status: 'succeeded' });
      expect(dispatchMock).toHaveBeenCalledTimes(1);
    });

    it('waits for today’s `after` when Snaglet opens before it, running nothing for the missed days', async () => {
      const a = await automationService.create(firstOpen('23:00', noonZone()), PERSON);
      const today = await nextRunAt(a.id);
      await setNextRun(a.scheduleId!, '2 days');
      await tickUntil(async () => (await nextRunAt(a.id)) > Date.now());
      expect(await runsOf(a.scheduleId!)).toEqual([]);
      expect(await nextRunAt(a.id)).toBe(today);
      expect(dispatchMock).not.toHaveBeenCalled();
    });

    it('puts the day off a minute while a Run now is still going, writing nothing, then runs', async () => {
      const a = await automationService.create(firstOpen('01:00', noonZone()), PERSON);
      const busyRun = (id: string) =>
        sql(
          `INSERT INTO public.schedule_runs (id, schedule_id, scheduled_for, status, manual)
           VALUES ($1, $2, now() - interval '5 seconds', 'running', true)`,
          [id, a.scheduleId]
        );
      // The boot cleanup fails runs a restart cut off; this one shows it is done.
      await busyRun('schedule_run-1111111111111-busyaaaaa');
      scheduleService.start();
      try {
        await waitFor(async () => (await runsOf(a.scheduleId!))[0]?.status === 'failed');
        // A Run now's schedule run is still going: no claim, look again in a minute.
        await busyRun('schedule_run-1111111111111-busybbbbb');
        await setNextRun(a.scheduleId!, '1 minute');
        scheduleService.notifySchedulesChanged([a.scheduleId!]);
        await waitFor(async () => (await nextRunAt(a.id)) > Date.now());
      } finally {
        scheduleService.stop();
      }
      expect((await runsOf(a.scheduleId!)).map((r) => r.status)).toEqual(['failed', 'running']);
      expect(await nextRunAt(a.id)).toBeLessThan(Date.now() + 90_000);
      await sql(`UPDATE public.schedule_runs SET status = 'succeeded' WHERE id = $1`, [
        'schedule_run-1111111111111-busybbbbb',
      ]);

      // A Run now whose wake is still going: the day's claim is given back.
      let release: (value: unknown) => void = () => undefined;
      dispatchMock.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      expect((await automationService.runNow(a.id, PERSON)).run.status).toBe('succeeded');
      expect(automationService.isWakeLive(a.id)).toBe(true);
      await setNextRun(a.scheduleId!, '1 minute');
      await tickUntil(async () => (await nextRunAt(a.id)) > Date.now());
      expect((await runsOf(a.scheduleId!)).map((r) => r.status)).toEqual([
        'failed',
        'succeeded',
        'succeeded',
      ]);
      expect(await nextRunAt(a.id)).toBeLessThan(Date.now() + 90_000);

      // It settles: the day's run goes ahead.
      release(COMPLETED);
      await waitFor(async () => !automationService.isWakeLive(a.id));
      await setNextRun(a.scheduleId!, '1 second');
      await tickUntil(async () => (await runsOf(a.scheduleId!)).length === 4);
      expect(dispatchMock).toHaveBeenCalledTimes(2);
    });

    it('takes no reminders: a switch to first open clears them, and setting them is refused', async () => {
      const a = await automationService.create(
        { ...hourly('Morning show'), when: { repeat: 'FREQ=DAILY', at: '09:00' } },
        PERSON
      );
      const item = { kind: 'automation' as const, automationId: a.id };
      await Reminders.save(item, { enabled: true, atStart: true, offsets: [], sound: 'chime' });
      await automationService.update(a.id, { when: { first_open: true } }, PERSON);
      expect(await Reminders.get(item)).toBeNull();
      await expect(assertReminderItemExists(item)).rejects.toThrow(
        '"Morning show" runs when Snaglet first opens, so it has no start time to remind before.'
      );
    });

    it('does not count a person’s Run now as the day’s run', async () => {
      const a = await automationService.create(firstOpen('01:00', noonZone()), PERSON);
      const now = await automationService.runNow(a.id, PERSON);
      expect(now.run.status).toBe('succeeded');
      await setNextRun(a.scheduleId!, '1 minute');
      await tickUntil(async () => (await runsOf(a.scheduleId!)).length === 2);
      expect((await runsOf(a.scheduleId!)).map((r) => r.status)).toEqual([
        'succeeded',
        'succeeded',
      ]);
      expect(dispatchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('the network guard after a start or wake (through the scheduler tick)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('waits on the agent’s provider host first; a network that never comes skips the run and posts nothing', async () => {
      const NOT_READY =
        'Network not ready: api.anthropic.com did not answer within 2 minutes after Snaglet started.';
      const ready = jest
        .spyOn(networkGuard, 'ready')
        .mockRejectedValue(new NetworkNotReadyError(NOT_READY));
      await sql(`UPDATE public.agents SET provider_id = 'anthropic' WHERE id = $1`, [AGENT_A]);
      try {
        const a = await automationService.create(hourly('Network check'), PERSON);
        await sql(
          `UPDATE public.schedules SET next_run_at = now() - interval '1 minute' WHERE id = $1`,
          [a.scheduleId]
        );
        scheduleService.start();
        try {
          await waitFor(async () => (await runsOfSchedule(a.scheduleId!)).length === 1);
          await waitFor(async () => (await runsOfSchedule(a.scheduleId!))[0]?.status !== 'running');
        } finally {
          scheduleService.stop();
        }
        const runs = await sql<{ status: string; error: string | null }>(
          `SELECT status, error FROM public.schedule_runs WHERE schedule_id = $1`,
          [a.scheduleId]
        );
        expect(runs).toEqual([{ status: 'skipped', error: NOT_READY }]);
        expect((await automationService.get(a.id)).consecutiveFailures).toBe(0);
        expect(ready).toHaveBeenCalledWith(
          'api.anthropic.com',
          expect.objectContaining({ reason: 'start' })
        );
        expect(dispatchMock).not.toHaveBeenCalled();
        expect(
          await sql(`SELECT id FROM public.messages WHERE thread_id = $1`, [THREAD_A])
        ).toEqual([]);

        // A person's Run now does not wait for the network.
        ready.mockClear();
        const manual = await automationService.runNow(a.id, PERSON);
        expect(manual.run.status).toBe('succeeded');
        expect(ready).not.toHaveBeenCalled();
      } finally {
        await sql(`UPDATE public.agents SET provider_id = NULL WHERE id = $1`, [AGENT_A]);
      }
    });
  });

  describe('restoring a finished automation (through the scheduler tick)', () => {
    it('a once that ran and a repeat whose COUNT is used up come back finished and do not fire', async () => {
      const once = await automationService.create(
        { ...hourly('Reply ping'), when: { in: '1h' } },
        PERSON
      );
      const count = await automationService.create(
        {
          ...hourly('Count'),
          when: {
            repeat: 'FREQ=DAILY;COUNT=1',
            at: '09:00',
            starts: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
            tz: 'UTC',
          },
        },
        PERSON
      );
      // Both due ten minutes ago (within the grace): the once's time and the
      // repeat's only occurrence, on the row and on its schedule.
      const due = new Date(Math.floor((Date.now() - 10 * 60_000) / 60_000) * 60_000);
      const day = due.toISOString().slice(0, 10);
      const time = due.toISOString().slice(11, 16);
      await sql(`UPDATE public.automations SET at = $2 WHERE id = $1`, [once.id, due]);
      await sql(`UPDATE public.automations SET starts_on = $2, time_of_day = $3 WHERE id = $1`, [
        count.id,
        day,
        time,
      ]);
      await sql(`UPDATE public.schedules SET schedule_json = $2, next_run_at = $3 WHERE id = $1`, [
        once.scheduleId,
        JSON.stringify({ at: due.toISOString() }),
        due,
      ]);
      await sql(`UPDATE public.schedules SET schedule_json = $2, next_run_at = $3 WHERE id = $1`, [
        count.scheduleId,
        JSON.stringify({ rrule: 'FREQ=DAILY;COUNT=1', time, startsOn: day }),
        due,
      ]);
      scheduleService.start();
      try {
        await waitFor(
          async () =>
            (await automationService.get(once.id)).status === 'finished' &&
            (await automationService.get(count.id)).status === 'finished'
        );
      } finally {
        scheduleService.stop();
      }
      expect(dispatchMock).toHaveBeenCalledTimes(2);
      for (const a of [once, count]) await waitFor(async () => !automationService.isWakeLive(a.id));

      for (const a of [once, count]) {
        await automationService.cancel(a.id, PERSON);
        const restored = await automationService.resume(a.id, PERSON);
        expect(restored).toMatchObject({
          status: 'finished',
          nextRunAt: null,
          scheduleId: a.scheduleId,
          lastRun: { status: 'succeeded' },
        });
        expect(await ownedSchedules(a.id)).toEqual([
          expect.objectContaining({ enabled: false, next_run_at: null, linked: true }),
        ]);
        // Finished, not deleted: Resume still has nothing to run.
        await expect(automationService.resume(a.id, PERSON)).rejects.toThrow(
          'This automation has no more runs.'
        );
      }

      // Nothing fires afterward.
      scheduleService.start();
      await new Promise((resolve) => setTimeout(resolve, 600));
      scheduleService.stop();
      expect(dispatchMock).toHaveBeenCalledTimes(2);
      for (const a of [once, count]) expect(await runsOfSchedule(a.scheduleId!)).toHaveLength(1);
    });
  });

  describe('notifications', () => {
    it('only for agent-made recurring automations: create and change', async () => {
      await automationService.create({ ...hourly('One-off'), when: { in: '2h' } }, agentA());
      await automationService.create({ ...hourly('By a person'), when: { every: '2h' } }, PERSON);
      expect(await notices()).toEqual([]);

      const daily = await automationService.create(
        { ...hourly('Morning check'), when: { repeat: 'FREQ=DAILY', at: '08:30', tz: 'UTC' } },
        agentA()
      );
      await automationService.update(daily.id, { when: { every: '4h' } }, agentA());
      await automationService.update(daily.id, { name: 'Renamed only' }, agentA());
      expect(await notices()).toEqual([
        {
          title: 'Test Agent A scheduled "Morning check"',
          body: expect.stringMatching(
            /^every day at 8:30 AM \(UTC\)|^every day at 8:30 AM in /
          ) as unknown as string,
          thread_id: THREAD_A,
          agent_id: AGENT_A,
        },
        {
          title: 'Test Agent A changed "Morning check"',
          body: 'Now every 4 hours.',
          thread_id: THREAD_A,
          agent_id: AGENT_A,
        },
      ]);
      expect((await notices())[0]!.body).toMatch(
        /in “Test thread”\. Pause it from the calendar or the Automations view\.$/
      );
    });
  });

  describe('undo of a resume', () => {
    const EXPIRED = "Can't undo the resume: the undo expired.";
    const CHANGED = "Can't undo the resume: the automation changed since it was resumed.";
    const NOT_YOURS = 'Only the person who resumed it can undo the resume.';

    /** Resume and undo as a signed-in person with a member (USER_A). */
    const resumeAsA = (id: string, actor: AutomationActor = PERSON) =>
      asUser(USER_A)(() => automationService.resumeWithUndo(id, actor));
    const undoAsA = (id: string, token: unknown, actor: AutomationActor = PERSON) =>
      asUser(USER_A)(() => automationService.undoResume(id, token, actor));

    /** Paused after three failed wakes, as the failure streak leaves it. */
    async function pausedAfterFailures(name = 'Flaky') {
      const a = await automationService.create(hourly(name), PERSON);
      await automationService.pause(a.id, PERSON);
      await sql(
        `UPDATE public.automations SET paused_reason = 'failures', consecutive_failures = 3 WHERE id = $1`,
        [a.id]
      );
      return a;
    }

    async function resumeWithToken(id: string): Promise<string> {
      const { automation, undoToken } = await resumeAsA(id);
      expect(automation).toMatchObject({ status: 'active', consecutiveFailures: 0 });
      expect(undoToken).toEqual(expect.any(String));
      return undoToken!;
    }

    beforeAll(seedUsers);
    afterAll(dropUsers);

    it('puts back "paused after failures" with its streak, disabled, once', async () => {
      const a = await pausedAfterFailures();
      const token = await resumeWithToken(a.id);
      expect((await ownedSchedules(a.id))[0]).toMatchObject({ enabled: true });

      jest.mocked(wsService.broadcastToChannel).mockClear();
      const undone = await undoAsA(a.id, token);
      expect(undone).toMatchObject({
        status: 'paused',
        pausedReason: 'failures',
        consecutiveFailures: 3,
        nextRunAt: null,
        scheduleId: a.scheduleId,
      });
      expect(await ownedSchedules(a.id)).toEqual([
        expect.objectContaining({ enabled: false, next_run_at: null, linked: true }),
      ]);
      expect(wsService.broadcastToChannel).toHaveBeenCalledWith('workspace', {
        type: 'automations:changed',
        payload: { automationId: a.id },
      });

      // Single use.
      await expect(undoAsA(a.id, token)).rejects.toMatchObject({
        statusCode: 409,
        message: EXPIRED,
      });
      // A later resume is undoable again.
      const again = await resumeWithToken(a.id);
      expect(await undoAsA(a.id, again)).toMatchObject({
        pausedReason: 'failures',
        consecutiveFailures: 3,
      });
    });

    it("puts back an agent's pause with its reason", async () => {
      const a = await automationService.create(hourly('Paused by its agent'), agentA());
      await automationService.pause(a.id, agentA());
      const token = await resumeWithToken(a.id);
      expect(await undoAsA(a.id, token)).toMatchObject({
        status: 'paused',
        pausedReason: 'agent',
        consecutiveFailures: 0,
      });
    });

    it('gives no token when no pause was cleared, nor to agents and external clients', async () => {
      const active = await automationService.create(hourly('Already active'), PERSON);
      expect(await resumeAsA(active.id)).toMatchObject({
        automation: { status: 'active' },
        undoToken: null,
      });

      const deleted = await automationService.create(hourly('Deleted'), PERSON);
      await automationService.cancel(deleted.id, PERSON);
      expect(await resumeAsA(deleted.id)).toMatchObject({
        automation: { status: 'active' },
        undoToken: null,
      });

      const finished = await automationService.create(hourly('Finished'), PERSON);
      await sql(`UPDATE public.automations SET status = 'finished' WHERE id = $1`, [finished.id]);
      expect(await resumeAsA(finished.id)).toMatchObject({
        automation: { status: 'active' },
        undoToken: null,
      });

      const mine = await automationService.create(hourly('Mine'), agentA());
      await automationService.pause(mine.id, agentA());
      expect((await resumeAsA(mine.id, agentA())).undoToken).toBeNull();
      await automationService.pause(mine.id, agentA());
      expect((await resumeAsA(mine.id, { kind: 'person', external: true })).undoToken).toBeNull();
    });

    it('is refused once it was edited, ran or failed since the resume', async () => {
      const edited = await pausedAfterFailures('Edited');
      const editedToken = await resumeWithToken(edited.id);
      await automationService.update(edited.id, { name: 'Renamed' }, PERSON);
      await expect(undoAsA(edited.id, editedToken)).rejects.toMatchObject({
        statusCode: 409,
        message: CHANGED,
      });
      expect(await automationService.get(edited.id)).toMatchObject({ status: 'active' });

      // A run that succeeds with no streak to reset leaves the row as it was:
      // the run itself is what refuses.
      const ran = await pausedAfterFailures('Ran');
      const ranToken = await resumeWithToken(ran.id);
      const before = (await automationService.get(ran.id)).updatedAt;
      await automationService.runNow(ran.id, PERSON);
      await waitFor(async () => !automationService.isWakeLive(ran.id));
      expect((await automationService.get(ran.id)).updatedAt).toBe(before);
      await expect(undoAsA(ran.id, ranToken)).rejects.toMatchObject({
        statusCode: 409,
        message: CHANGED,
      });

      // A new failure (written without touching updated_at here).
      const failed = await pausedAfterFailures('Failed');
      const failedToken = await resumeWithToken(failed.id);
      await sql(`UPDATE public.automations SET consecutive_failures = 1 WHERE id = $1`, [
        failed.id,
      ]);
      await expect(undoAsA(failed.id, failedToken)).rejects.toMatchObject({
        statusCode: 409,
        message: CHANGED,
      });
      expect(await automationService.get(failed.id)).toMatchObject({
        status: 'active',
        consecutiveFailures: 1,
      });
    });

    it('expires after 30 minutes', async () => {
      const a = await pausedAfterFailures();
      const token = await resumeWithToken(a.id);
      const later = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000 + 1);
      try {
        await expect(undoAsA(a.id, token)).rejects.toMatchObject({
          statusCode: 409,
          message: EXPIRED,
        });
      } finally {
        later.mockRestore();
      }
      // Gone, not just late.
      await expect(undoAsA(a.id, token)).rejects.toMatchObject({
        statusCode: 409,
        message: EXPIRED,
      });
      expect(await automationService.get(a.id)).toMatchObject({ status: 'active' });
    });

    it("refuses one automation's token on another, without using it up", async () => {
      const a = await pausedAfterFailures('A');
      const b = await pausedAfterFailures('B');
      const tokenA = await resumeWithToken(a.id);
      await resumeWithToken(b.id);
      await expect(undoAsA(b.id, tokenA)).rejects.toMatchObject({
        statusCode: 409,
        message: EXPIRED,
      });
      expect(await automationService.get(b.id)).toMatchObject({ status: 'active' });
      expect(await undoAsA(a.id, tokenA)).toMatchObject({
        status: 'paused',
      });
      await expect(undoAsA(a.id, '')).rejects.toMatchObject({
        statusCode: 400,
        message: 'token is required.',
      });
    });

    it('is for the person who resumed: not agents, external clients or another member', async () => {
      const a = await pausedAfterFailures();
      const token = await resumeWithToken(a.id);
      for (const actor of [agentA(), { kind: 'person', external: true } as const]) {
        await expect(undoAsA(a.id, token, actor)).rejects.toMatchObject({
          statusCode: 403,
          message: 'Only a person in the app can undo a resume.',
        });
      }
      await expect(
        asUser(USER_B)(() => automationService.undoResume(a.id, token, PERSON))
      ).rejects.toMatchObject({ statusCode: 403, message: NOT_YOURS });
      expect(await automationService.get(a.id)).toMatchObject({ status: 'active' });

      expect(await undoAsA(a.id, token)).toMatchObject({
        status: 'paused',
        pausedReason: 'failures',
        consecutiveFailures: 3,
      });
    });

    it('gives no token to a resume with no member behind it', async () => {
      const a = await pausedAfterFailures();
      expect(await automationService.resumeWithUndo(a.id, PERSON)).toMatchObject({
        automation: { status: 'active', pausedReason: null, consecutiveFailures: 0 },
        undoToken: null,
      });
    });

    it('refuses an undo with no member behind it, even with a good token', async () => {
      const a = await pausedAfterFailures();
      const token = await resumeWithToken(a.id);
      await expect(automationService.undoResume(a.id, token, PERSON)).rejects.toMatchObject({
        statusCode: 403,
        message: NOT_YOURS,
      });
      expect(await automationService.get(a.id)).toMatchObject({ status: 'active' });
      // Not used up: the member who resumed still can.
      expect(await undoAsA(a.id, token)).toMatchObject({ status: 'paused' });
    });
  });

  describe('undo of a pause', () => {
    const EXPIRED = "Can't undo the pause: the undo expired.";
    const CHANGED = "Can't undo the pause: the automation changed since it was paused.";
    const NOT_YOURS = 'Only the person who paused it can undo the pause.';

    /** Pause and undo as a signed-in person with a member (USER_A). */
    const pauseAsA = (id: string, actor: AutomationActor = PERSON) =>
      asUser(USER_A)(() => automationService.pauseWithUndo(id, actor));
    const undoAsA = (id: string, token: unknown, actor: AutomationActor = PERSON) =>
      asUser(USER_A)(() => automationService.undoPause(id, token, actor));

    /** Active with two failed wakes behind it (one short of the auto-pause). */
    async function activeWithStreak(name = 'Flaky', streak = 2) {
      const a = await automationService.create(hourly(name), PERSON);
      await sql(`UPDATE public.automations SET consecutive_failures = $2 WHERE id = $1`, [
        a.id,
        streak,
      ]);
      return a;
    }

    async function pauseWithToken(id: string): Promise<string> {
      const { automation, undoToken } = await pauseAsA(id);
      expect(automation).toMatchObject({ status: 'paused', pausedReason: 'user' });
      expect(undoToken).toEqual(expect.any(String));
      return undoToken!;
    }

    beforeAll(seedUsers);
    afterAll(dropUsers);

    it('resumes with its failure streak of 2, the schedule enabled, once', async () => {
      const a = await activeWithStreak();
      const token = await pauseWithToken(a.id);
      expect(await automationService.get(a.id)).toMatchObject({ consecutiveFailures: 2 });
      expect((await ownedSchedules(a.id))[0]).toMatchObject({ enabled: false });

      jest.mocked(wsService.broadcastToChannel).mockClear();
      const undone = await undoAsA(a.id, token);
      expect(undone).toMatchObject({
        status: 'active',
        pausedReason: null,
        consecutiveFailures: 2,
        scheduleId: a.scheduleId,
      });
      expect(undone.nextRunAt).not.toBeNull();
      expect(await ownedSchedules(a.id)).toEqual([
        expect.objectContaining({ enabled: true, linked: true }),
      ]);
      expect(wsService.broadcastToChannel).toHaveBeenCalledWith('workspace', {
        type: 'automations:changed',
        payload: { automationId: a.id },
      });

      // Single use.
      await expect(undoAsA(a.id, token)).rejects.toMatchObject({
        statusCode: 409,
        message: EXPIRED,
      });
      // A later pause is undoable again; a plain resume would start afresh.
      const again = await pauseWithToken(a.id);
      expect(await undoAsA(a.id, again)).toMatchObject({
        status: 'active',
        consecutiveFailures: 2,
      });
      await automationService.pause(a.id, PERSON);
      expect((await automationService.resume(a.id, PERSON)).consecutiveFailures).toBe(0);
    });

    it('gives no token when it paused nothing, nor to agents, external clients or no member', async () => {
      const paused = await activeWithStreak('Already paused');
      await automationService.pause(paused.id, PERSON);
      expect(await pauseAsA(paused.id)).toMatchObject({
        automation: { status: 'paused' },
        undoToken: null,
      });

      const finished = await automationService.create(hourly('Finished'), PERSON);
      await sql(`UPDATE public.automations SET status = 'finished' WHERE id = $1`, [finished.id]);
      expect(await pauseAsA(finished.id)).toMatchObject({
        automation: { status: 'finished' },
        undoToken: null,
      });

      const mine = await automationService.create(hourly('Mine'), agentA());
      expect(await pauseAsA(mine.id, agentA())).toMatchObject({
        automation: { status: 'paused', pausedReason: 'agent' },
        undoToken: null,
      });
      await automationService.resume(mine.id, agentA());
      expect(await pauseAsA(mine.id, { kind: 'person', external: true })).toMatchObject({
        automation: { status: 'paused', pausedReason: 'user' },
        undoToken: null,
      });

      // No member behind the call: paused, but no token.
      const anonymous = await activeWithStreak('Anonymous');
      expect(await automationService.pauseWithUndo(anonymous.id, PERSON)).toMatchObject({
        automation: { status: 'paused', pausedReason: 'user', consecutiveFailures: 2 },
        undoToken: null,
      });
    });

    it('is refused once it was edited, ran, failed or changed reason since the pause', async () => {
      const edited = await activeWithStreak('Edited');
      const editedToken = await pauseWithToken(edited.id);
      await automationService.update(edited.id, { name: 'Renamed' }, PERSON);
      await expect(undoAsA(edited.id, editedToken)).rejects.toMatchObject({
        statusCode: 409,
        message: CHANGED,
      });
      expect(await automationService.get(edited.id)).toMatchObject({ status: 'paused' });

      // A Run now that succeeds with no streak to reset leaves the row as it
      // was: the run itself is what refuses.
      const ran = await activeWithStreak('Ran', 0);
      const ranToken = await pauseWithToken(ran.id);
      const before = (await automationService.get(ran.id)).updatedAt;
      await automationService.runNow(ran.id, PERSON);
      await waitFor(async () => !automationService.isWakeLive(ran.id));
      expect((await automationService.get(ran.id)).updatedAt).toBe(before);
      await expect(undoAsA(ran.id, ranToken)).rejects.toMatchObject({
        statusCode: 409,
        message: CHANGED,
      });

      // A new failure, and a new reason (written without touching updated_at here).
      for (const [name, change] of [
        ['Failed', 'consecutive_failures = 3'],
        ['Auto-paused', "paused_reason = 'failures'"],
      ] as const) {
        const a = await activeWithStreak(name);
        const token = await pauseWithToken(a.id);
        await sql(`UPDATE public.automations SET ${change} WHERE id = $1`, [a.id]);
        await expect(undoAsA(a.id, token)).rejects.toMatchObject({
          statusCode: 409,
          message: CHANGED,
        });
        expect(await automationService.get(a.id)).toMatchObject({ status: 'paused' });
      }
    });

    it('expires after 30 minutes', async () => {
      const a = await activeWithStreak();
      const token = await pauseWithToken(a.id);
      const later = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 60_000 + 1);
      try {
        await expect(undoAsA(a.id, token)).rejects.toMatchObject({
          statusCode: 409,
          message: EXPIRED,
        });
      } finally {
        later.mockRestore();
      }
      // Gone, not just late.
      await expect(undoAsA(a.id, token)).rejects.toMatchObject({
        statusCode: 409,
        message: EXPIRED,
      });
      expect(await automationService.get(a.id)).toMatchObject({ status: 'paused' });
    });

    it("refuses one automation's token on another, without using it up", async () => {
      const a = await activeWithStreak('A');
      const b = await activeWithStreak('B');
      const tokenA = await pauseWithToken(a.id);
      await pauseWithToken(b.id);
      await expect(undoAsA(b.id, tokenA)).rejects.toMatchObject({
        statusCode: 409,
        message: EXPIRED,
      });
      expect(await automationService.get(b.id)).toMatchObject({ status: 'paused' });
      expect(await undoAsA(a.id, tokenA)).toMatchObject({
        status: 'active',
        consecutiveFailures: 2,
      });
      await expect(undoAsA(a.id, '')).rejects.toMatchObject({
        statusCode: 400,
        message: 'token is required.',
      });
    });

    it("takes no resume's token for a pause's undo nor the other way round, using neither up", async () => {
      const a = await activeWithStreak();
      const pauseToken = await pauseWithToken(a.id);
      await expect(
        asUser(USER_A)(() => automationService.undoResume(a.id, pauseToken, PERSON))
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "Can't undo the resume: the undo expired.",
      });
      expect(await automationService.get(a.id)).toMatchObject({ status: 'paused' });
      expect(await undoAsA(a.id, pauseToken)).toMatchObject({
        status: 'active',
        consecutiveFailures: 2,
      });

      await automationService.pause(a.id, PERSON);
      const { undoToken: resumeToken } = await asUser(USER_A)(() =>
        automationService.resumeWithUndo(a.id, PERSON)
      );
      expect(resumeToken).toEqual(expect.any(String));
      await expect(undoAsA(a.id, resumeToken)).rejects.toMatchObject({
        statusCode: 409,
        message: EXPIRED,
      });
      expect(await automationService.get(a.id)).toMatchObject({ status: 'active' });
      expect(
        await asUser(USER_A)(() => automationService.undoResume(a.id, resumeToken, PERSON))
      ).toMatchObject({ status: 'paused', pausedReason: 'user', consecutiveFailures: 2 });
    });

    it('is for the person who paused: not agents, external clients, another member or none', async () => {
      const a = await activeWithStreak();
      const token = await pauseWithToken(a.id);
      for (const actor of [agentA(), { kind: 'person', external: true } as const]) {
        await expect(undoAsA(a.id, token, actor)).rejects.toMatchObject({
          statusCode: 403,
          message: 'Only a person in the app can undo a pause.',
        });
      }
      await expect(
        asUser(USER_B)(() => automationService.undoPause(a.id, token, PERSON))
      ).rejects.toMatchObject({ statusCode: 403, message: NOT_YOURS });
      await expect(automationService.undoPause(a.id, token, PERSON)).rejects.toMatchObject({
        statusCode: 403,
        message: NOT_YOURS,
      });
      expect(await automationService.get(a.id)).toMatchObject({ status: 'paused' });

      // Not used up: the member who paused still can.
      expect(await undoAsA(a.id, token)).toMatchObject({
        status: 'active',
        consecutiveFailures: 2,
      });
    });

    it('is refused while the agent is at its active limit, and works once there is room', async () => {
      const a = await activeWithStreak();
      const others = [];
      for (let i = 0; i < 8; i += 1)
        others.push(await automationService.create(hourly(`Check ${i}`), PERSON));
      const token = await pauseWithToken(a.id);
      await automationService.create(hourly('Takes the slot'), PERSON);
      await automationService.create(hourly('And one more'), PERSON);
      await expect(undoAsA(a.id, token)).rejects.toMatchObject({
        statusCode: 409,
        message: 'Test Agent A already has 10 active automations. Pause or cancel one first.',
        details: { reason: 'active_limit', active: 10, max: 10 },
      });
      expect(await automationService.get(a.id)).toMatchObject({
        status: 'paused',
        consecutiveFailures: 2,
      });

      await automationService.pause(others[0]!.id, PERSON);
      expect(await undoAsA(a.id, token)).toMatchObject({
        status: 'active',
        consecutiveFailures: 2,
      });
    });
  });
});
