/**
 * The shared catalog reconciler repairs a drifted `tools` table, and the repair
 * is visible on both discovery surfaces (search_tools and get_tool_schema).
 * Against a real throwaway database it drifts the catalog two ways:
 *   - an enabled builtin row with no folder behind it (`get_updates`: offered
 *     to agents with no handler, so calls hard-fail), and
 *   - a missing row for a tool whose folder exists (`orient`).
 * One sync soft-retires the ghost (row kept, disabled, invisible to keyword
 * search and schema lookup), re-inserts the missing tool, and reports
 * accounting that matches what it wrote.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { closeDatabase, getDb, Tools, toolView } from '@snaglet/db';
import {
  syncToolCatalog,
  toolDefinitionToCreateInput,
} from '@server/services/ToolService/lib/syncToolCatalog';
import { loadAllToolDefinitions } from '@server/services/ToolService/scripts/lib/tool-metadata';
import getToolSchema from '@server/services/ToolService/handlers/tools/tool-schema';

const GHOST_ID = 'ghost_sync_repair_test_tool';
const MISSING_ID = 'orient';

describe('tool catalog sync repair', () => {
  let report: Awaited<ReturnType<typeof syncToolCatalog>>;

  beforeAll(async () => {
    const defs = (await loadAllToolDefinitions()).map((t) =>
      toolDefinitionToCreateInput(t.definition, t.toolId)
    );
    expect(defs.map((d) => d.id)).toContain(MISSING_ID);

    // Baseline the catalog from the real tree, then drift it.
    const baseline = await syncToolCatalog(defs);
    expect(baseline.ok).toBe(true);

    // Drift 1: stale enabled builtin row with no folder behind it.
    await Tools.upsertTool({
      id: GHOST_ID,
      name: 'Ghost Sync Repair Test Tool',
      description: 'Stale row for a tool whose folder was removed.',
      type: 'builtin',
      keywords: ['ghostsyncrepair'],
      enabled: true,
    });

    // Drift 2: a real tool's row hard-deleted. Tools.delete also removes the
    // node-spine row.
    await Tools.delete(MISSING_ID);
    expect(await Tools.findById(MISSING_ID)).toBeNull();

    // The sync under test.
    report = await syncToolCatalog(defs);
  }, 240_000);

  afterAll(async () => {
    await Tools.delete(GHOST_ID);
    await getDb().query(`DELETE FROM public.nodes WHERE id = $1`, [GHOST_ID]);
    await closeDatabase();
  });

  it('verifies its own writes and reports real accounting', () => {
    expect(report.ok).toBe(true);
    expect(report.divergence).toEqual([]);
    expect(report.added).toEqual([MISSING_ID]);
    expect(report.retired).toEqual([GHOST_ID]);
    expect(report.retireSkipped).toBe(false);
  });

  it('soft-retires the ghost: row kept, disabled', async () => {
    const row = await Tools.findById(GHOST_ID);
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(false);
  });

  it('re-inserts the missing tool enabled', async () => {
    const row = await Tools.findById(MISSING_ID);
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(true);
  });

  it('ghost is invisible to the search_tools keyword channel', async () => {
    const { tools } = await toolView.searchByKeyword('ghostsyncrepair', 10);
    expect(tools.map((t) => t.id)).not.toContain(GHOST_ID);
  });

  it('ghost gets no schema from get_tool_schema', async () => {
    const raw = (await getToolSchema({ tool: GHOST_ID }, {})) as string;
    const parsed = JSON.parse(raw) as { error?: string; parameters_schema?: unknown };
    expect(parsed.error).toMatch(/disabled or retired/);
    expect(parsed.parameters_schema).toBeUndefined();
  });

  it('restored tool is discoverable via the search_tools keyword channel', async () => {
    const { tools } = await toolView.searchByKeyword('orient workspace location', 10);
    expect(tools.map((t) => t.id)).toContain(MISSING_ID);
  });

  it('restored tool serves its schema via get_tool_schema', async () => {
    const raw = (await getToolSchema({ tool: MISSING_ID }, {})) as string;
    const parsed = JSON.parse(raw) as {
      error?: string;
      id?: string;
      parameters_schema?: Record<string, unknown>;
    };
    expect(parsed.error).toBeUndefined();
    expect(parsed.id).toBe(MISSING_ID);
    expect(parsed.parameters_schema).toMatchObject({ type: 'object' });
  });
});
