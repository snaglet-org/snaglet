/**
 * Integration test: ToolModel.upsertTool conflict semantics.
 *
 * The load-bearing rule: on conflict, upsertTool must not touch
 * `enabled`. McpService.registerToolsInDb calls this on every connect;
 * if it stamped enabled=true on conflict, every reconnect would
 * clobber an admin's per-tool disable.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, closeDatabase } from '@snaglet/db';
import { Tools } from '@snaglet/db/tables/tools';

const TEST_ID = 'integration_test_upsert_tool_conflict';

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.tools WHERE id = $1`, [TEST_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1`, [TEST_ID]);
}

describe('Tools.upsertTool conflict semantics', () => {
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(async () => {
    await closeDatabase();
  });

  it('on insert: enabled defaults to true', async () => {
    const row = await Tools.upsertTool({
      id: TEST_ID,
      name: 'test',
      type: 'builtin',
    });
    expect(row.enabled).toBe(true);
  });

  it('on conflict: enabled is preserved, not overwritten by incoming', async () => {
    // Insert as admin-disabled
    await Tools.upsertTool({
      id: TEST_ID,
      name: 'test',
      type: 'builtin',
      enabled: false,
    });

    // Simulate McpService reconnect: upsert with default enabled=true
    const after = await Tools.upsertTool({
      id: TEST_ID,
      name: 'test',
      type: 'builtin',
      // enabled omitted — defaults to true, but conflict path must skip it.
    });

    expect(after.enabled).toBe(false); // admin choice survived
  });
});
