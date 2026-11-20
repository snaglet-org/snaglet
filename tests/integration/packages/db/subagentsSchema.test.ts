/**
 * The subagents floor on a fresh database:
 *
 * - real agents keep unique names while helpers may share a name with anyone;
 *   a helper's name is unique among the live helpers of its parent thread;
 *   status and finished_at agree; a helper is never its own orchestrator, and
 *   one agent row backs one helper;
 * - a timer (resume_at) sits only on a paused ('stopped') helper, so a helper
 *   cannot go back to running with its timer still set;
 * - deleting a parent thread removes its subagents rows AND their helper
 *   thread nodes (with messages); deleting a helper thread only clears the
 *   row's thread_id; deleting an orchestrator removes its helper agents.
 */
import { describe, expect, it } from '@jest/globals';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { createFreshDatabase } from '../../../support/freshDatabase';

const ORCHESTRATOR = 'test-agent-a';
const OTHER_AGENT = 'test-agent-b';
const HELPER = 'subagent-11111111-1111-4111-8111-111111111111';
const HELPER_2 = 'subagent-22222222-2222-4222-8222-222222222222';
const PARENT = 'thread-1111111111111-parentaaa';
const OTHER_PARENT = 'thread-1111111111111-parentbbb';
const HELPER_THREAD = 'thread-1111111111111-helperaaa';
const HELPER_THREAD_2 = 'thread-1111111111111-helperbbb';
const HELPER_MESSAGE = 'message-1111111111111-helperaaa';

async function expectViolation(db: PostgresAdapter, text: string, params: unknown[] = []) {
  // Only an integrity-constraint error (SQLSTATE class 23: check, unique, FK,
  // not-null) counts, so a typo in the statement cannot pass.
  await expect(db.query(text, params)).rejects.toMatchObject({
    code: expect.stringMatching(/^23/),
  });
}

async function seedThread(db: PostgresAdapter, id: string): Promise<void> {
  await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread')`, [id]);
  await db.query(`INSERT INTO public.threads (id, title) VALUES ($1, $1)`, [id]);
}

/** Two real agents and two parent threads. */
async function seedWorkspace(db: PostgresAdapter): Promise<void> {
  await db.query(
    `INSERT INTO public.agents (id, name) VALUES ($1, 'Test Agent A'), ($2, 'Scout')`,
    [ORCHESTRATOR, OTHER_AGENT]
  );
  await seedThread(db, PARENT);
  await seedThread(db, OTHER_PARENT);
}

/** One helper agent + hidden thread + subagents row under `parent`. */
async function seedHelper(
  db: PostgresAdapter,
  opts: {
    agentId: string;
    threadId: string;
    parent: string;
    name: string;
    status?: 'running' | 'stopped';
  }
): Promise<void> {
  await db.query(`INSERT INTO public.agents (id, name, parent_agent_id) VALUES ($1, $2, $3)`, [
    opts.agentId,
    opts.name,
    ORCHESTRATOR,
  ]);
  await seedThread(db, opts.threadId);
  await db.query(`UPDATE public.threads SET parent_thread_id = $2 WHERE id = $1`, [
    opts.threadId,
    opts.parent,
  ]);
  await db.query(
    `INSERT INTO public.subagents
       (parent_thread_id, orchestrator_agent_id, agent_id, thread_id, name, provider_id,
        model_id, status, finished_at)
     VALUES ($1, $2, $3, $4, $5, 'test-provider', 'test-model', $6::text,
             CASE WHEN $6::text = 'running' THEN NULL ELSE now() END)`,
    [opts.parent, ORCHESTRATOR, opts.agentId, opts.threadId, opts.name, opts.status ?? 'running']
  );
}

const count = async (db: PostgresAdapter, text: string, params: unknown[] = []) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${text}) x`, params)).rows[0]?.n;

describe('subagents schema', () => {
  it('enforces names, status and ownership at the database floor', async () => {
    const { db, close } = await createFreshDatabase('subagents_floor');
    try {
      await seedWorkspace(db);

      // Real agents keep globally unique names (case-insensitive) ...
      await expectViolation(
        db,
        `INSERT INTO public.agents (id, name) VALUES ('test-agent-c', 'scout')`
      );
      // ... while a helper may share a name with a real agent and with another helper.
      await seedHelper(db, {
        agentId: HELPER,
        threadId: HELPER_THREAD,
        parent: PARENT,
        name: 'Scout',
      });
      await seedHelper(db, {
        agentId: HELPER_2,
        threadId: HELPER_THREAD_2,
        parent: OTHER_PARENT,
        name: 'Scout',
      });
      // An agent is never its own parent; a thread is never its own parent.
      await expectViolation(db, `UPDATE public.agents SET parent_agent_id = id WHERE id = $1`, [
        OTHER_AGENT,
      ]);
      await expectViolation(db, `UPDATE public.threads SET parent_thread_id = id WHERE id = $1`, [
        PARENT,
      ]);

      const insert = `INSERT INTO public.subagents
                        (parent_thread_id, orchestrator_agent_id, agent_id, name, provider_id, model_id, status, finished_at)
                      VALUES ($1, $2, $3, $4, 'test-provider', 'test-model', $5, $6)`;
      await db.query(
        `INSERT INTO public.agents (id, name, parent_agent_id) VALUES ('subagent-x', 'Scout', $1)`,
        [ORCHESTRATOR]
      );
      // One live "Scout" per parent thread, case-insensitive.
      await expectViolation(db, insert, [
        PARENT,
        ORCHESTRATOR,
        'subagent-x',
        'SCOUT',
        'running',
        null,
      ]);
      // Blank and over-long names, unknown statuses, status/finished_at disagreement.
      await expectViolation(db, insert, [
        PARENT,
        ORCHESTRATOR,
        'subagent-x',
        '  ',
        'running',
        null,
      ]);
      await expectViolation(db, insert, [
        PARENT,
        ORCHESTRATOR,
        'subagent-x',
        'x'.repeat(61),
        'running',
        null,
      ]);
      await expectViolation(db, insert, [
        PARENT,
        ORCHESTRATOR,
        'subagent-x',
        'Reader',
        'done',
        new Date(),
      ]);
      await expectViolation(db, insert, [
        PARENT,
        ORCHESTRATOR,
        'subagent-x',
        'Reader',
        'running',
        new Date(),
      ]);
      await expectViolation(db, insert, [
        PARENT,
        ORCHESTRATOR,
        'subagent-x',
        'Reader',
        'finished',
        null,
      ]);
      // A helper is never its own orchestrator, and one agent row backs one helper.
      await expectViolation(db, insert, [
        PARENT,
        'subagent-x',
        'subagent-x',
        'Reader',
        'running',
        null,
      ]);
      await expectViolation(db, insert, [PARENT, ORCHESTRATOR, HELPER, 'Reader', 'running', null]);
      // Once the first Scout is cleaned up (deleted_at), the name is free again.
      await db.query(
        `UPDATE public.subagents SET status = 'finished', finished_at = now(), deleted_at = now()
          WHERE agent_id = $1`,
        [HELPER]
      );
      await db.query(insert, [PARENT, ORCHESTRATOR, 'subagent-x', 'scout', 'running', null]);
      expect(
        (await db.query(`SELECT id FROM public.subagents WHERE agent_id = 'subagent-x'`)).rows[0]
          ?.id
      ).toMatch(/^subagent-/);
    } finally {
      await close();
    }
  }, 120_000);

  it('keeps a timer only on a paused helper', async () => {
    const { db, close } = await createFreshDatabase('subagents_timer');
    try {
      await seedWorkspace(db);
      await seedHelper(db, {
        agentId: HELPER,
        threadId: HELPER_THREAD,
        parent: PARENT,
        name: 'Scout',
      });
      await seedHelper(db, {
        agentId: HELPER_2,
        threadId: HELPER_THREAD_2,
        parent: PARENT,
        name: 'Reader',
        status: 'stopped',
      });

      // A helper starts with no timer.
      expect(
        (
          await db.query<{ name: string; status: string; resume_at: string | null }>(
            `SELECT name, status, resume_at FROM public.subagents ORDER BY name`
          )
        ).rows
      ).toEqual([
        { name: 'Reader', status: 'stopped', resume_at: null },
        { name: 'Scout', status: 'running', resume_at: null },
      ]);
      // A paused helper takes a timer and can drop it again.
      await db.query(
        `UPDATE public.subagents SET resume_at = now() + interval '1 hour' WHERE agent_id = $1`,
        [HELPER_2]
      );
      // A running one cannot have one.
      await expectViolation(
        db,
        `UPDATE public.subagents SET resume_at = now() + interval '1 hour' WHERE agent_id = $1`,
        [HELPER]
      );
      // Nor can a paused helper go back to work with its timer still set.
      await expectViolation(
        db,
        `UPDATE public.subagents SET status = 'running', finished_at = NULL WHERE agent_id = $1`,
        [HELPER_2]
      );
      await db.query(
        `UPDATE public.subagents SET status = 'running', finished_at = NULL, resume_at = NULL
          WHERE agent_id = $1`,
        [HELPER_2]
      );
      // Finished and failed helpers are not paused either.
      await expectViolation(
        db,
        `UPDATE public.subagents
            SET status = 'finished', finished_at = now(), resume_at = now() WHERE agent_id = $1`,
        [HELPER]
      );
      await expectViolation(
        db,
        `UPDATE public.subagents
            SET status = 'failed', finished_at = now(), resume_at = now() WHERE agent_id = $1`,
        [HELPER]
      );
    } finally {
      await close();
    }
  }, 120_000);

  it('cascades: a parent thread takes its helper threads along; an orchestrator takes its helpers', async () => {
    const { db, close } = await createFreshDatabase('subagents_cascade');
    try {
      await seedWorkspace(db);
      await seedHelper(db, {
        agentId: HELPER,
        threadId: HELPER_THREAD,
        parent: PARENT,
        name: 'Scout',
      });
      await seedHelper(db, {
        agentId: HELPER_2,
        threadId: HELPER_THREAD_2,
        parent: OTHER_PARENT,
        name: 'Reader',
      });
      // An author-less thread_event row inside the helper thread (messages are nodes too).
      await db.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'message')`, [
        HELPER_MESSAGE,
      ]);
      await db.query(
        `INSERT INTO public.messages (id, thread_id, role, content, message_type)
         VALUES ($1, $2, 'user', '[thread started]', 'thread_event')`,
        [HELPER_MESSAGE, HELPER_THREAD]
      );
      // One helper run with one tool-call activity row.
      await db.query(
        `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
         VALUES ('run-helper-aaa', $1, $2, 'test-provider', 'test-model', 'completed', now())`,
        [HELPER_THREAD, HELPER]
      );
      await db.query(
        `INSERT INTO public.agent_activity_log (agent_id, run_id, action_type, trigger_type)
         VALUES ($1, 'run-helper-aaa', 'tool_call', 'message_received')`,
        [HELPER]
      );

      // Deleting a helper thread directly only clears the row's thread_id.
      await db.query(`DELETE FROM public.nodes WHERE id = $1`, [HELPER_THREAD_2]);
      expect(
        (await db.query(`SELECT thread_id FROM public.subagents WHERE agent_id = $1`, [HELPER_2]))
          .rows
      ).toEqual([{ thread_id: null }]);

      // Deleting the parent thread removes its rows, the helper thread node and its messages.
      await db.query(`DELETE FROM public.nodes WHERE id = $1`, [PARENT]);
      expect(
        await count(db, `SELECT 1 FROM public.subagents WHERE parent_thread_id = $1`, [PARENT])
      ).toBe(0);
      expect(await count(db, `SELECT 1 FROM public.nodes WHERE id = $1`, [HELPER_THREAD])).toBe(0);
      expect(await count(db, `SELECT 1 FROM public.threads WHERE id = $1`, [HELPER_THREAD])).toBe(
        0
      );
      expect(
        await count(db, `SELECT 1 FROM public.messages WHERE thread_id = $1`, [HELPER_THREAD])
      ).toBe(0);
      // The message's own nodes row goes too (a plain thread delete would leave it).
      expect(await count(db, `SELECT 1 FROM public.nodes WHERE id = $1`, [HELPER_MESSAGE])).toBe(0);
      // Its tool activity is gone; the run (usage) stays, detached from the thread.
      expect(
        await count(db, `SELECT 1 FROM public.agent_activity_log WHERE run_id = 'run-helper-aaa'`)
      ).toBe(0);
      expect(
        (await db.query(`SELECT thread_id FROM public.runs WHERE id = 'run-helper-aaa'`)).rows
      ).toEqual([{ thread_id: null }]);
      // The helper agent row stays (the server soft-deletes it); the other parent is untouched.
      expect(await count(db, `SELECT 1 FROM public.agents WHERE id = $1`, [HELPER])).toBe(1);
      expect(
        await count(db, `SELECT 1 FROM public.subagents WHERE parent_thread_id = $1`, [
          OTHER_PARENT,
        ])
      ).toBe(1);

      // Deleting the orchestrator removes its helper agents and their rows.
      await db.query(`DELETE FROM public.agents WHERE id = $1`, [ORCHESTRATOR]);
      expect(await count(db, `SELECT 1 FROM public.agents WHERE parent_agent_id IS NOT NULL`)).toBe(
        0
      );
      expect(await count(db, `SELECT 1 FROM public.subagents`)).toBe(0);
      expect(await count(db, `SELECT 1 FROM public.agents WHERE id = $1`, [OTHER_AGENT])).toBe(1);
    } finally {
      await close();
    }
  }, 120_000);
});
