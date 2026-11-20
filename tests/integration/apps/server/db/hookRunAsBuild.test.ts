/**
 * Run as covers one build. HookRegistrations.setRunAs records the
 * build it was set for and only takes a hook with a ready build;
 * setBuildState clears it when the source or the build changes (a file edit,
 * `hook` op `update`, the builder, an imported file or the bundled SDK), in
 * the same write that records the new hash. Deleting the agent clears it.
 */
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, HookRegistrations } from '@snaglet/db';

const HOOK = 'test-run-as-build';
const AGENT = 'test-agent-run-as-build';

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.hook_registrations WHERE name = $1`, [HOOK]);
  await getDb().query(`DELETE FROM public.agents WHERE id = $1`, [AGENT]);
}

async function seed(buildStatus: 'ready' | 'building' = 'ready'): Promise<void> {
  await getDb().query(`INSERT INTO public.agents (id, name) VALUES ($1, 'Test Agent A')`, [AGENT]);
  await getDb().query(
    `INSERT INTO public.hook_registrations
       (id, name, source_path, enabled, build_status, source_hash, build_hash)
     VALUES ('hook_test_run_as_build', $1, '/nonexistent/hook.ts', true, $2, 'source-a', $3)`,
    [HOOK, buildStatus, buildStatus === 'ready' ? 'build-a' : null]
  );
}

describe('run as covers one build', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('records the build it was set for and keeps it while the code is the same', async () => {
    await seed();
    const set = await HookRegistrations.setRunAs(HOOK, AGENT);
    expect(set).toMatchObject({ runAsAgentId: AGENT, runAsBuildHash: 'build-a' });

    const rebuilt = await HookRegistrations.setBuildState(HOOK, {
      buildStatus: 'ready',
      sourceHash: 'source-a',
      buildHash: 'build-a',
    });
    expect(rebuilt).toMatchObject({ runAsAgentId: AGENT, runAsBuildHash: 'build-a' });
  });

  it('clears it when the build changes, even with the same hook.ts', async () => {
    await seed();
    await HookRegistrations.setRunAs(HOOK, AGENT);

    const rebuilt = await HookRegistrations.setBuildState(HOOK, {
      buildStatus: 'ready',
      sourceHash: 'source-a',
      buildHash: 'build-b',
    });

    expect(rebuilt).toMatchObject({
      runAsAgentId: null,
      runAsBuildHash: null,
      buildHash: 'build-b',
    });
  });

  it('clears it when hook.ts changes', async () => {
    await seed();
    await HookRegistrations.setRunAs(HOOK, AGENT);

    const rebuilt = await HookRegistrations.setBuildState(HOOK, {
      buildStatus: 'ready',
      sourceHash: 'source-b',
      buildHash: 'build-a',
    });

    expect(rebuilt?.runAsAgentId).toBeNull();
  });

  it('does not take a hook without a ready build', async () => {
    await seed('building');

    expect(await HookRegistrations.setRunAs(HOOK, AGENT)).toBeNull();
    expect((await HookRegistrations.findByName(HOOK))?.runAsAgentId).toBeNull();
    // Clearing always works.
    expect(await HookRegistrations.setRunAs(HOOK, null)).toMatchObject({ runAsAgentId: null });
  });

  it('falls back to the default when the agent is deleted', async () => {
    await seed();
    await HookRegistrations.setRunAs(HOOK, AGENT);

    await getDb().query(`DELETE FROM public.agents WHERE id = $1`, [AGENT]);

    expect((await HookRegistrations.findByName(HOOK))?.runAsAgentId).toBeNull();
  });
});
