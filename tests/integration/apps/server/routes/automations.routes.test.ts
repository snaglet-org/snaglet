/**
 * /api/automations over HTTP: the envelope, panel auth on writes, the
 * people's rules (any thread and agent, 1-minute floor), the undo path
 * (DELETE then resume), undo of a resume (its token puts the pause back with
 * its reason and failure streak), undo of a pause (its token resumes with the
 * failure streak kept; the active limit's 409 carries its numbers), Run now,
 * the run log (pages, newest first, kept
 * after a delete), and the neighbors that refuse automation rows:
 * /api/schedules writes (409) and the table entry writer (403).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb } from '@snaglet/db';

const broadcast = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    broadcastToChannel: (...args: unknown[]) => broadcast(...args),
    sendToClient: jest.fn(),
  },
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: async () => ({ ok: true, reason: 'completed', wakeCount: 1, capHit: false }),
}));

import { AUTOMATIONS_TABLE_ID } from '@snaglet/shared/types';
import { errorHandler } from '@server/middleware';
import { actorContextMiddleware } from '@server/middleware/actorContext';
import { getPanelToken } from '@server/middleware/panelAuth';
import automationsRoutes from '@server/routes/automations';
import schedulesRoutes from '@server/routes/schedules';
import tablesRoutes from '@server/routes/tables';

const AGENT = 'test-agent-a';
const THREAD = 'thread-1111111111111-routeaaaa';
const USER = 'test-user-a';

/** `signedIn`: the app's identity middleware, so `x-snaglet-actor-id` names the person asking. */
function app(options: { signedIn?: boolean } = {}) {
  const server = express();
  server.use(express.json());
  if (options.signedIn) server.use(actorContextMiddleware);
  server.use('/api/automations', automationsRoutes);
  server.use('/api/schedules', schedulesRoutes);
  server.use('/api/tables', tablesRoutes);
  server.use(errorHandler);
  return server;
}

const panel = () => ({ 'X-Snaglet-Panel-Token': getPanelToken() });
/** The panel token, as the person USER (who has a member). */
const asUser = () => ({ ...panel(), 'x-snaglet-actor-id': USER });

async function sql(text: string, params: unknown[] = []) {
  return (await getDb().query(text, params)).rows;
}

describe('/api/automations routes', () => {
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
      `INSERT INTO public.threads (id, title) VALUES ($1, 'Route thread') ON CONFLICT DO NOTHING`,
      [THREAD]
    );
    const [member] = (await sql(`SELECT id FROM public.members WHERE agent_id = $1`, [
      AGENT,
    ])) as Array<{
      id: string;
    }>;
    await sql(`INSERT INTO public.thread_participants (thread_id, member_id) VALUES ($1, $2)`, [
      THREAD,
      member!.id,
    ]);
    await sql(
      `INSERT INTO public.users (id, email, name, auth_provider_id)
       VALUES ($1, 'user@example.com', 'Test User', $1) ON CONFLICT DO NOTHING`,
      [USER]
    );
    await sql(
      `INSERT INTO public.members (id, kind, user_id) VALUES ($1, 'user', $2) ON CONFLICT DO NOTHING`,
      [`${USER}-member`, USER]
    );
  });
  beforeEach(async () => {
    await sql(`DELETE FROM public.automations`);
    await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
    broadcast.mockClear();
  });
  afterAll(async () => {
    await sql(`DELETE FROM public.automations`);
    await sql(`DELETE FROM public.schedules WHERE action_kind = 'automation'`);
    await sql(`DELETE FROM public.members WHERE user_id = $1`, [USER]);
    await sql(`DELETE FROM public.users WHERE id = $1`, [USER]);
  });

  it('creates, lists, edits, pauses, deletes and restores through the service', async () => {
    const unauthenticated = await request(app())
      .post('/api/automations')
      .send({ name: 'x', prompt: 'y', when: { every: '1m' }, threadId: THREAD, agentId: AGENT });
    expect(unauthenticated.status).toBeGreaterThanOrEqual(401);
    expect(unauthenticated.status).toBeLessThan(404);

    const created = await request(app())
      .post('/api/automations')
      .set(panel())
      .send({
        name: 'Every minute',
        prompt: 'Ping.',
        when: { every: '1m' },
        threadId: THREAD,
        agentId: AGENT,
      });
    expect(created.status).toBe(201);
    const a = created.body.data.automation;
    expect(a).toMatchObject({
      status: 'active',
      whenText: 'every minute',
      agentName: 'Test Agent A',
      threadTitle: 'Route thread',
      createdByAgentId: null,
    });
    expect(broadcast).toHaveBeenCalledWith('workspace', {
      type: 'automations:changed',
      payload: { automationId: a.id },
    });

    const listed = await request(app()).get('/api/automations?status=active');
    expect(listed.body.data.automations.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect((await request(app()).get('/api/automations?status=bogus')).status).toBe(400);

    const edited = await request(app())
      .patch(`/api/automations/${a.id}`)
      .set(panel())
      .send({
        name: 'Weekday mornings',
        when: { repeat: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', at: '09:00' },
      });
    expect(edited.status).toBe(200);
    expect(edited.body.data.automation).toMatchObject({
      name: 'Weekday mornings',
      when: { kind: 'repeat' },
    });
    expect(edited.body.data.automation.calendarId).not.toBeNull();
    expect(broadcast).toHaveBeenCalledWith(
      'workspace',
      expect.objectContaining({
        type: 'calendar:changed',
        payload: expect.objectContaining({ kind: 'automation', automationId: a.id }),
      })
    );

    const badWhen = await request(app())
      .patch(`/api/automations/${a.id}`)
      .set(panel())
      .send({ when: { at: '2001-01-01T09:00' } });
    expect(badWhen.status).toBe(400);
    expect(badWhen.body.error.message).toBe('That time is in the past.');

    const paused = await request(app()).post(`/api/automations/${a.id}/pause`).set(panel());
    expect(paused.body.data.automation).toMatchObject({ status: 'paused', pausedReason: 'user' });

    const deleted = await request(app()).delete(`/api/automations/${a.id}`).set(panel());
    expect(deleted.body.data.automation).toMatchObject({ status: 'cancelled', scheduleId: null });
    const again = await request(app()).delete(`/api/automations/${a.id}`).set(panel());
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(`Automation ${a.id} is canceled.`);

    // Undo of Delete: back as it was (paused, by a person).
    const restored = await request(app()).post(`/api/automations/${a.id}/resume`).set(panel());
    expect(restored.body.data.automation).toMatchObject({
      status: 'paused',
      pausedReason: 'user',
      scheduleId: a.scheduleId,
    });
    expect((await request(app()).get(`/api/automations/nope`)).status).toBe(404);
  });

  it('an {every, at} automation reads back with its anchor', async () => {
    const created = await request(app())
      .post('/api/automations')
      .set(panel())
      .send({
        name: 'Staggered',
        prompt: 'Ping.',
        when: { every: '15m', at: '2031-01-01T00:07', tz: 'UTC' },
        threadId: THREAD,
        agentId: AGENT,
      });
    expect(created.status).toBe(201);
    const id = created.body.data.automation.id;
    const read = await request(app()).get(`/api/automations/${id}`).set(panel());
    expect(read.body.data.automation.when).toMatchObject({
      kind: 'interval',
      everyMs: 900_000,
      anchor: '2031-01-01T00:07:00.000Z',
    });
  });

  it('a length change with no at re-anchors to now over REST', async () => {
    const created = await request(app())
      .post('/api/automations')
      .set(panel())
      .send({
        name: 'Staggered',
        prompt: 'Ping.',
        when: { every: '15m', at: '2031-01-01T00:07', tz: 'UTC' },
        threadId: THREAD,
        agentId: AGENT,
      });
    const id = created.body.data.automation.id;
    const patched = await request(app())
      .patch(`/api/automations/${id}`)
      .set(panel())
      .send({ when: { every: '30m' } });
    expect(patched.status).toBe(200);
    const anchor = Date.parse(patched.body.data.automation.when.anchor);
    expect(Math.abs(anchor - Date.now())).toBeLessThan(60_000);
  });

  it('resume returns an undo token that puts a "paused after failures" back as it was', async () => {
    const created = await request(app({ signedIn: true }))
      .post('/api/automations')
      .set(asUser())
      .send({
        name: 'Flaky',
        prompt: 'Ping.',
        when: { every: '1h' },
        threadId: THREAD,
        agentId: AGENT,
      });
    const a = created.body.data.automation as { id: string };
    await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause`)
      .set(asUser());
    await sql(
      `UPDATE public.automations SET paused_reason = 'failures', consecutive_failures = 3 WHERE id = $1`,
      [a.id]
    );

    // The panel token gates both (missing → 403, as on every panel route).
    const PANEL_REFUSAL = 'Unauthorized: missing or invalid panel execution token';
    const bare = await request(app({ signedIn: true })).post(`/api/automations/${a.id}/resume`);
    expect(bare.status).toBe(403);
    expect(bare.body.error.message).toBe(PANEL_REFUSAL);
    const resumed = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/resume`)
      .set(asUser());
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toEqual({
      automation: expect.objectContaining({ status: 'active', consecutiveFailures: 0 }),
      undoToken: expect.any(String),
    });
    const token = resumed.body.data.undoToken as string;

    const unauthenticated = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/resume/undo`)
      .set('x-snaglet-actor-id', USER)
      .send({ token });
    expect(unauthenticated.status).toBe(403);
    expect(unauthenticated.body.error.message).toBe(PANEL_REFUSAL);
    const noToken = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/resume/undo`)
      .set(asUser())
      .send({});
    expect(noToken.status).toBe(400);
    expect(noToken.body.error.message).toBe('token is required.');

    const undone = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/resume/undo`)
      .set(asUser())
      .send({ token });
    expect(undone.status).toBe(200);
    expect(undone.body.data.automation).toMatchObject({
      status: 'paused',
      pausedReason: 'failures',
      consecutiveFailures: 3,
      nextRunAt: null,
    });
    expect(broadcast).toHaveBeenCalledWith('workspace', {
      type: 'automations:changed',
      payload: { automationId: a.id },
    });

    const reused = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/resume/undo`)
      .set(asUser())
      .send({ token });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toMatchObject({
      code: 'CONFLICT',
      message: "Can't undo the resume: the undo expired.",
    });

    // No member behind the request (no identity middleware): resumed, but no token.
    await request(app()).post(`/api/automations/${a.id}/pause`).set(panel());
    const anonymous = await request(app()).post(`/api/automations/${a.id}/resume`).set(panel());
    expect(anonymous.body.data).toMatchObject({
      automation: { status: 'active' },
      undoToken: null,
    });

    // Nothing paused to clear: no token.
    await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/resume`)
      .set(asUser());
    const again = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/resume`)
      .set(asUser());
    expect(again.body.data).toMatchObject({ automation: { status: 'active' }, undoToken: null });
  });

  it('pause returns an undo token that resumes with the failure streak it kept', async () => {
    const create = (name: string) =>
      request(app({ signedIn: true }))
        .post('/api/automations')
        .set(asUser())
        .send({ name, prompt: 'Ping.', when: { every: '1h' }, threadId: THREAD, agentId: AGENT });
    const a = (await create('Flaky')).body.data.automation as { id: string };
    await sql(`UPDATE public.automations SET consecutive_failures = 2 WHERE id = $1`, [a.id]);

    // The panel token gates both (missing → 403, as on every panel route).
    const PANEL_REFUSAL = 'Unauthorized: missing or invalid panel execution token';
    const bare = await request(app({ signedIn: true })).post(`/api/automations/${a.id}/pause`);
    expect(bare.status).toBe(403);
    expect(bare.body.error.message).toBe(PANEL_REFUSAL);
    const paused = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause`)
      .set(asUser());
    expect(paused.status).toBe(200);
    expect(paused.body.data).toEqual({
      automation: expect.objectContaining({
        status: 'paused',
        pausedReason: 'user',
        consecutiveFailures: 2,
      }),
      undoToken: expect.any(String),
    });
    const token = paused.body.data.undoToken as string;

    const unauthenticated = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause/undo`)
      .set('x-snaglet-actor-id', USER)
      .send({ token });
    expect(unauthenticated.status).toBe(403);
    expect(unauthenticated.body.error.message).toBe(PANEL_REFUSAL);
    const noToken = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause/undo`)
      .set(asUser())
      .send({});
    expect(noToken.status).toBe(400);
    expect(noToken.body.error.message).toBe('token is required.');
    // Not a resume's token.
    const swapped = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/resume/undo`)
      .set(asUser())
      .send({ token });
    expect(swapped.status).toBe(409);
    expect(swapped.body.error.message).toBe("Can't undo the resume: the undo expired.");

    const undone = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause/undo`)
      .set(asUser())
      .send({ token });
    expect(undone.status).toBe(200);
    expect(undone.body.data.automation).toMatchObject({
      status: 'active',
      pausedReason: null,
      consecutiveFailures: 2,
    });
    expect(undone.body.data.automation.nextRunAt).not.toBeNull();
    expect(broadcast).toHaveBeenCalledWith('workspace', {
      type: 'automations:changed',
      payload: { automationId: a.id },
    });

    const reused = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause/undo`)
      .set(asUser())
      .send({ token });
    expect(reused.status).toBe(409);
    expect(reused.body.error).toMatchObject({
      code: 'CONFLICT',
      message: "Can't undo the pause: the undo expired.",
    });

    // No member behind the request (no identity middleware): paused, but no token.
    const anonymous = await request(app()).post(`/api/automations/${a.id}/pause`).set(panel());
    expect(anonymous.body.data).toMatchObject({
      automation: { status: 'paused' },
      undoToken: null,
    });
    // Nothing active to pause: no token.
    const again = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause`)
      .set(asUser());
    expect(again.body.data).toMatchObject({ automation: { status: 'paused' }, undoToken: null });

    // At the agent's active limit the undo is refused with the numbers.
    await request(app()).post(`/api/automations/${a.id}/resume`).set(panel());
    const limited = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause`)
      .set(asUser());
    for (let i = 0; i < 10; i += 1) expect((await create(`Check ${i}`)).status).toBe(201);
    const full = await request(app({ signedIn: true }))
      .post(`/api/automations/${a.id}/pause/undo`)
      .set(asUser())
      .send({ token: limited.body.data.undoToken });
    expect(full.status).toBe(409);
    expect(full.body.error).toEqual({
      code: 'CONFLICT',
      message: 'Test Agent A already has 10 active automations. Pause or cancel one first.',
      details: { reason: 'active_limit', active: 10, max: 10 },
    });
  });

  it('runs now and reports the logged wake', async () => {
    const created = await request(app())
      .post('/api/automations')
      .set(panel())
      .send({
        name: 'Soon',
        prompt: 'Ping.',
        when: { in: '1h' },
        threadId: THREAD,
        agentId: AGENT,
      });
    const ran = await request(app())
      .post(`/api/automations/${created.body.data.automation.id}/run`)
      .set(panel());
    expect(ran.status).toBe(200);
    expect(ran.body.data.run).toEqual({ status: 'succeeded', error: null });
    expect(ran.body.data.automation.lastRun).toMatchObject({ status: 'succeeded' });
  });

  it('pages the run log newest first, keeps it after a delete, and agrees with the last result', async () => {
    const created = await request(app())
      .post('/api/automations')
      .set(panel())
      .send({
        name: 'Logged',
        prompt: 'Ping.',
        when: { every: '1h' },
        threadId: THREAD,
        agentId: AGENT,
      });
    const a = created.body.data.automation as { id: string; scheduleId: string };
    // Five runs a minute apart, two of them started at the same instant (the
    // id breaks the tie), newest last here. Microseconds: a page cursor must
    // keep them.
    const BASE = '2026-10-13T12:00:00.123456Z';
    const runs = [
      ['schedule_run-1111111111111-aaaaaaaa1', 5, 'succeeded', null, null],
      ['schedule_run-1111111111111-aaaaaaaa2', 4, 'failed', 'Provider exploded\nat line 2', null],
      ['schedule_run-1111111111111-aaaaaaaa3', 3, 'skipped', 'Previous run is still going', null],
      [
        'schedule_run-1111111111111-aaaaaaaa4',
        2,
        'succeeded',
        null,
        '{"messageId":"m","manual":true}',
      ],
      ['schedule_run-1111111111111-aaaaaaaa5', 2, 'running', null, null],
    ] as const;
    // A Run now is recorded on the run when it is claimed (`manual`).
    for (const [id, minutesAgo, status, error, output] of runs) {
      await sql(
        `INSERT INTO public.schedule_runs
           (id, schedule_id, scheduled_for, status, error, output, started_at, finished_at, manual)
         VALUES ($1, $2, $3::timestamptz - make_interval(mins => $4, secs => $8), $5, $6, $7,
                 $3::timestamptz - make_interval(mins => $4),
                 CASE WHEN $5 = 'running' THEN NULL
                      ELSE $3::timestamptz - make_interval(mins => $4) + interval '5 seconds' END,
                 $9)`,
        [
          id,
          a.scheduleId,
          BASE,
          minutesAgo,
          status,
          error,
          output,
          id.endsWith('5') ? 1 : 0,
          output !== null,
        ]
      );
    }
    const newestFirst = [
      'schedule_run-1111111111111-aaaaaaaa5',
      'schedule_run-1111111111111-aaaaaaaa4',
      'schedule_run-1111111111111-aaaaaaaa3',
      'schedule_run-1111111111111-aaaaaaaa2',
      'schedule_run-1111111111111-aaaaaaaa1',
    ];

    const readAll = async (limit: number) => {
      const ids: string[] = [];
      let before: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const res = await request(app())
          .get(`/api/automations/${a.id}/runs`)
          .query({ limit, ...(before ? { before } : {}) });
        expect(res.status).toBe(200);
        expect(res.body.data.runs.length).toBeLessThanOrEqual(limit);
        ids.push(...res.body.data.runs.map((r: { id: string }) => r.id));
        before = res.body.data.nextCursor;
        if (!before) break;
      }
      return ids;
    };
    expect(await readAll(2)).toEqual(newestFirst);
    expect(await readAll(1)).toEqual(newestFirst);

    const first = await request(app()).get(`/api/automations/${a.id}/runs`);
    expect(first.body.data.nextCursor).toBeNull();
    const byId = new Map(
      (first.body.data.runs as Array<Record<string, unknown>>).map((r) => [r.id, r])
    );
    expect(byId.get('schedule_run-1111111111111-aaaaaaaa5')).toMatchObject({
      status: 'running',
      finishedAt: null,
      manual: false,
    });
    expect(byId.get('schedule_run-1111111111111-aaaaaaaa4')).toMatchObject({
      status: 'succeeded',
      manual: true,
    });
    expect(byId.get('schedule_run-1111111111111-aaaaaaaa2')).toMatchObject({
      status: 'failed',
      error: 'Provider exploded\nat line 2',
    });
    const last = await request(app()).get(`/api/automations/${a.id}`);
    expect(last.body.data.automation.lastRun).toMatchObject({
      status: 'running',
      scheduledFor: first.body.data.runs[0].scheduledFor,
    });

    // A deleted automation keeps its log.
    await request(app()).delete(`/api/automations/${a.id}`).set(panel());
    expect(await readAll(2)).toEqual(newestFirst);

    expect((await request(app()).get('/api/automations/nope/runs')).status).toBe(404);
    expect((await request(app()).get(`/api/automations/${a.id}/runs?limit=0`)).status).toBe(400);
    const badCursor = await request(app()).get(`/api/automations/${a.id}/runs?before=nope`);
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.message).toBe('before must be the nextCursor of a previous page.');
  });

  it('lists the newest runs across automations in one read, newest first, without deleted ones', async () => {
    const make = async (name: string) =>
      (
        await request(app())
          .post('/api/automations')
          .set(panel())
          .send({ name, prompt: 'Ping.', when: { every: '1h' }, threadId: THREAD, agentId: AGENT })
      ).body.data.automation as { id: string; scheduleId: string };
    const often = await make('Often');
    const daily = await make('Daily');
    const gone = await make('Gone');
    const insert = (id: string, scheduleId: string, minutesAgo: number) =>
      sql(
        `INSERT INTO public.schedule_runs (id, schedule_id, scheduled_for, status, started_at, finished_at)
         VALUES ($1, $2, now() - make_interval(mins => $3), 'succeeded',
                 now() - make_interval(mins => $3),
                 now() - make_interval(mins => $3) + interval '5 seconds')`,
        [id, scheduleId, minutesAgo]
      );
    // Twelve runs five minutes apart, then a nine-day-old one of another
    // automation: the first page is the twelve, not ten and the old one.
    const oftenIds = Array.from(
      { length: 12 },
      (_, i) => `schedule_run-1111111111111-often${String(i + 1).padStart(4, '0')}`
    );
    for (const [i, id] of oftenIds.entries()) await insert(id, often.scheduleId, (i + 1) * 5);
    await insert('schedule_run-1111111111111-dailyaaaa', daily.scheduleId, 9 * 24 * 60);
    await insert('schedule_run-1111111111111-goneaaaaa', gone.scheduleId, 1);
    await request(app()).delete(`/api/automations/${gone.id}`).set(panel());

    const page = await request(app()).get('/api/automations/runs/recent?limit=12');
    expect(page.status).toBe(200);
    expect(page.body.data.runs.map((r: { id: string }) => r.id)).toEqual(oftenIds);
    expect(page.body.data.runs[0]).toEqual({
      id: oftenIds[0],
      automationId: often.id,
      automationName: 'Often',
      scheduledFor: expect.stringMatching(/Z$/),
      startedAt: expect.stringMatching(/Z$/),
      finishedAt: expect.stringMatching(/Z$/),
      status: 'succeeded',
      error: null,
      manual: false,
    });

    const all = await request(app()).get('/api/automations/runs/recent');
    expect(all.body.data.runs.map((r: { id: string }) => r.id)).toEqual([
      ...oftenIds,
      'schedule_run-1111111111111-dailyaaaa',
    ]);
    expect((await request(app()).get('/api/automations/runs/recent?limit=0')).status).toBe(400);
  });

  it('logs a Run now as manual, and lists posted wakes when no schedule run is left', async () => {
    const created = await request(app())
      .post('/api/automations')
      .set(panel())
      .send({
        name: 'Woken',
        prompt: 'Ping.',
        when: { every: '1h' },
        threadId: THREAD,
        agentId: AGENT,
      });
    const a = created.body.data.automation as { id: string; scheduleId: string };
    await request(app()).post(`/api/automations/${a.id}/run`).set(panel());
    const logged = await request(app()).get(`/api/automations/${a.id}/runs`);
    expect(logged.body.data.runs).toEqual([
      expect.objectContaining({ status: 'succeeded', manual: true, error: null }),
    ]);

    // Its schedule's runs gone: the wake it posted in the thread stands in.
    await sql(`DELETE FROM public.schedule_runs WHERE schedule_id = $1`, [a.scheduleId]);
    const [wake] = (await sql(
      `SELECT id FROM public.messages WHERE metadata->'automation'->>'id' = $1`,
      [a.id]
    )) as Array<{ id: string }>;
    const fallback = await request(app()).get(`/api/automations/${a.id}/runs`);
    expect(fallback.body.data).toEqual({
      runs: [expect.objectContaining({ id: wake!.id, status: 'succeeded', error: null })],
      nextCursor: null,
    });
    const record = await request(app()).get(`/api/automations/${a.id}`);
    expect(record.body.data.automation.lastRun.scheduledFor).toBe(
      fallback.body.data.runs[0].scheduledFor
    );
  });

  it('the schedules routes and the table entry writer refuse automation rows', async () => {
    const created = await request(app())
      .post('/api/automations')
      .set(panel())
      .send({
        name: 'Hourly',
        prompt: 'Ping.',
        when: { every: '1h' },
        threadId: THREAD,
        agentId: AGENT,
      });
    const scheduleId = created.body.data.automation.scheduleId as string;
    const toggled = await request(app())
      .patch(`/api/schedules/${scheduleId}/enabled`)
      .set(panel())
      .send({ enabled: false });
    expect(toggled.status).toBe(409);
    expect(toggled.body.error.message).toBe(
      'This schedule belongs to an automation; edit the automation.'
    );
    const run = await request(app()).post(`/api/schedules/${scheduleId}/run`).set(panel());
    expect(run.status).toBe(409);

    const cell = await request(app())
      .patch(`/api/tables/${AUTOMATIONS_TABLE_ID}/entries/${created.body.data.automation.id}`)
      .send({ values: { name: 'x' }, schemaVersion: '1', expectedRevision: '1' });
    expect(cell.status).toBe(403);
    expect(cell.body.error.message).toBe('Use the automation tool.');
    const insert = await request(app())
      .post(`/api/tables/${AUTOMATIONS_TABLE_ID}/entries`)
      .send({ id: '11111111-1111-4111-8111-111111111111', values: {} });
    expect(insert.status).toBe(403);
  });
});
