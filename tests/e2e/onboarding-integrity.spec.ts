import { test, expect } from '@playwright/test';
import { ScratchServer } from './helpers/scratchServer';

/**
 * Fresh bootstrap + reset integrity — asserts the fresh-workspace invariants.
 * These cannot run against the shared live DB: they need a
 * guaranteed-fresh bootstrap and (for reset) they mutate global catalog state.
 * So we boot a real server against a throwaway managed-PostgreSQL database on a
 * free port (isolated SNAGLET_HOME + PostgreSQL data dir), assert over HTTP, then
 * tear it all down. Migrations auto-run on the fresh DB at boot.
 *
 * Serial: every test shares the one booted server, and the reset/restart tests
 * depend on ordering.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Fresh bootstrap + reset integrity (fresh managed DB)', () => {
  let server: ScratchServer;

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    server = await ScratchServer.boot({
      captureLog: true,
      env: { LOG_LEVEL: 'info' },
    });
    // Readiness precedes asynchronous registry sync. Sample the reset baseline
    // only after sync completes, not after an arbitrary nonzero partial count.
    await server.waitForLog(/Tool registry synced to DB: \d+ tools/);
  });

  test.afterAll(async () => {
    await server?.dispose();
  });

  // Spec 7: fresh bootstrap integrity

  test('boot sync populates the tools table', async () => {
    expect((await server.getData<unknown[]>('/tools')).length).toBeGreaterThan(0);
  });

  test('builtin providers, models, and mcp_servers are seeded', async () => {
    const providers = await server.getData<unknown[]>('/providers');
    const models = await server.getData<unknown[]>('/models');
    const mcp = await server.getData<unknown[]>('/mcp/servers');
    expect(providers.length).toBeGreaterThan(0);
    expect(models.length).toBeGreaterThan(0);
    expect(mcp.length).toBeGreaterThan(0);
  });

  test('the local user has a corresponding members row (user→member bridge)', async () => {
    // The local user is minted at boot via getOrCreateLocalUser → ensureForUser,
    // which creates the members row. So a fresh workspace already has ≥1 member.
    const members = await server.getData<Array<{ id: string; displayName?: string }>>('/members');
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((m) => typeof m.id === 'string' && m.id.length > 0)).toBe(true);
  });

  test('a new install gets Patty, Clio and its starter content once', async () => {
    // The onboarding seed runs once after boot from the fresh-bootstrap marker
    // and creates the starter agents (AgentService.ensureDefaults) first.
    await expect
      .poll(
        async () =>
          (await server.getData<{ value: { status?: string } | null }>('/settings/onboarding/seed'))
            .value?.status,
        { timeout: 60_000, intervals: [500] }
      )
      .toBe('done');

    const agents = await server.getData<Array<{ id: string }>>('/agents');
    expect(agents.map((agent) => agent.id).sort()).toEqual(['clio', 'patty']);

    const tree = JSON.stringify(await server.getData<unknown[]>('/containers/tree'));
    for (const name of ['Onboarding', 'My First Project (Sample)', 'Agents']) {
      expect(tree).toContain(name);
    }
  });

  // Spec 8: reset integrity (seed-replay + tool re-sync)

  test('reset scope=all replays the catalog seeds; tools re-sync inline', async () => {
    test.setTimeout(120_000);

    // Baseline: the builtin tool registry is fully synced before the reset.
    const toolCountBeforeReset = (await server.getData<unknown[]>('/tools')).length;
    expect(toolCountBeforeReset).toBeGreaterThan(0);

    // Kick off a full reset (no backup needed for a throwaway DB).
    const start = await fetch(`${server.api}/admin/db/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'all', createBackup: false }),
    });
    expect(start.ok).toBe(true);

    // Poll the job to completion.
    await expect
      .poll(
        async () => {
          const s = await fetch(`${server.api}/admin/db/status`);
          return (await s.json()).data?.running;
        },
        { timeout: 60_000, intervals: [500] }
      )
      .toBe(false);

    const status = (await (await fetch(`${server.api}/admin/db/status`)).json()).data;
    expect(status.error, 'reset must not error').toBeNull();

    // Seed-replay: even though scope=all wiped everything (except the migration
    // ledger), the catalog seeds were replayed inline, so these are non-empty.
    expect((await server.getData<unknown[]>('/providers')).length).toBeGreaterThan(0);
    expect((await server.getData<unknown[]>('/models')).length).toBeGreaterThan(0);
    expect((await server.getData<unknown[]>('/mcp/servers')).length).toBeGreaterThan(0);

    // Tools are workspace-backed rows, so the wipe deletes them — but
    // doReset re-syncs the builtin tool registry inline, so the clean
    // database is usable immediately and does not depend on a restart to
    // recover its builtin tools. requiresRestart still signals stale
    // in-memory server caches.
    expect(status.requiresRestart).toBe(true);
    expect((await server.getData<unknown[]>('/tools')).length).toBe(toolCountBeforeReset);

    // Restart on the same scratch DB → the boot-time sync converges on the
    // same builtin registry.
    await server.restart();
    expect((await server.getData<unknown[]>('/tools')).length).toBe(toolCountBeforeReset);
  });
});
