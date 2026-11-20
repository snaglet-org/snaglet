/**
 * The database floor of hook runs and of a registered hook's run-as agent:
 *
 * - hook_runs: known sources and statuses, and chain depth 0 by default;
 * - hook_registrations.run_as_agent_id: NULL by default, names a real agent
 *   (never ghost) together with the build it was set for, and falls back to
 *   NULL when that agent is purged.
 */
import { describe, expect, it } from '@jest/globals';
import type { PostgresAdapter } from '@snaglet/db/adapters/postgres';
import { createFreshDatabase } from '../../../support/freshDatabase';

const AGENT = 'test-agent-a';
const PROJECT = 'container-1111111111111-hookproj1';

async function expectViolation(db: PostgresAdapter, text: string, params: unknown[] = []) {
  // Each statement runs on its own; a failure leaves nothing behind. Only an
  // integrity-constraint error (SQLSTATE class 23: check, unique, FK, not-null,
  // and the guard triggers' check_violation) counts, so a typo cannot pass.
  await expect(db.query(text, params)).rejects.toMatchObject({
    code: expect.stringMatching(/^23/),
  });
}

async function seedRegistration(db: PostgresAdapter): Promise<void> {
  await db.query(
    `INSERT INTO public.hook_registrations (id, name, source_path, enabled)
     VALUES ('hook_test', 'test-hook', '/nonexistent/test-hook/hook.ts', true)`
  );
}

async function runAs(db: PostgresAdapter): Promise<string | null> {
  const { rows } = await db.query<{ run_as_agent_id: string | null }>(
    `SELECT run_as_agent_id FROM public.hook_registrations WHERE name = 'test-hook'`
  );
  return rows[0].run_as_agent_id;
}

describe('hooks schema', () => {
  it('takes the known hook run sources and statuses, starting at chain depth 0', async () => {
    const { db, close } = await createFreshDatabase('hook_runs');
    try {
      await db.query(
        `INSERT INTO public.hook_runs (id, hook_name, source, event_name, status) VALUES
           ('hrun-1', 'h', 'event', 'message:created', 'succeeded'),
           ('hrun-2', 'h', 'manual', 'manual', 'failed'),
           ('hrun-3', 'h', 'schedule', 'schedule', 'timed_out')`
      );
      await db.query(
        `INSERT INTO public.hook_runs (id, hook_name, source, event_name)
         VALUES ('hrun-4', 'h', 'hook', 'hook:finished'),
                ('hrun-5', 'h', 'signal', 'signal'),
                ('hrun-6', 'h', 'test', 'test')`
      );
      // A run starts at chain depth 0.
      expect(
        (
          await db.query(
            `SELECT count(*)::int AS n FROM public.hook_runs
              WHERE chain_depth <> 0`
          )
        ).rows
      ).toEqual([{ n: 0 }]);

      await expectViolation(
        db,
        `INSERT INTO public.hook_runs (id, hook_name, source, event_name) VALUES ('hrun-x', 'h', 'bogus', 'e')`
      );
      await expectViolation(
        db,
        `INSERT INTO public.hook_runs (id, hook_name, source, event_name, status)
         VALUES ('hrun-y', 'h', 'event', 'e', 'bogus')`
      );
      await expectViolation(
        db,
        `INSERT INTO public.hook_runs (id, hook_name, source, event_name, chain_depth)
         VALUES ('hrun-z', 'h', 'event', 'e', -1)`
      );
    } finally {
      await close();
    }
  });

  it('runs a registered hook as a real agent, never ghost, and falls back when the agent is purged', async () => {
    const { db, close } = await createFreshDatabase('hook_run_as');
    try {
      await seedRegistration(db);
      // No run-as agent by default: the event's agent, else the ghost system actor.
      expect(await runAs(db)).toBeNull();

      await db.query(`INSERT INTO public.agents (id, name) VALUES ($1, 'Test Agent A')`, [AGENT]);
      await db.query(
        `INSERT INTO public.agents (id, name) VALUES ('ghost', 'ghost') ON CONFLICT (id) DO NOTHING`
      );

      // Run as always names the build it was set for.
      await expectViolation(
        db,
        `UPDATE public.hook_registrations SET run_as_agent_id = $1 WHERE name = 'test-hook'`,
        [AGENT]
      );
      await db.query(
        `UPDATE public.hook_registrations SET run_as_agent_id = $1, run_as_build_hash = 'build-a'
          WHERE name = 'test-hook'`,
        [AGENT]
      );
      expect(await runAs(db)).toBe(AGENT);

      for (const bad of ['test-agent-gone', 'ghost']) {
        await expectViolation(
          db,
          `UPDATE public.hook_registrations SET run_as_agent_id = $1 WHERE name = 'test-hook'`,
          [bad]
        );
      }

      await db.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT]);
      expect(await runAs(db)).toBeNull();
    } finally {
      await close();
    }
  });
});
