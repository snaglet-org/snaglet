/**
 * Per-tool token ceilings — the tools-array twin of blockTokenCeilings. The
 * tools array is most of the fixed per-turn payload, so each commonly
 * advertised tool is measured as it goes on the wire (toAnthropicTools →
 * compact JSON) and asserted under a ceiling ≈ measured + 10%. The trailing
 * comment records the measured baseline, so a retune is a one-line edit.
 * Definitions are read from disk, so no database is needed; tokens use the
 * Anthropic char-ratio estimator the runtime budgets with.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { toAnthropicTools } from '@server/services/ToolService/ToolFormatService';
import type { BuiltinToolDefinition } from '@server/services/ToolService/types';
import { estimateTokens } from '@server/services/TokenEstimator';

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const TOOLS_DIR = path.join(REPO_ROOT, 'apps/server/src/services/ToolService/tools');

/** Ceilings ≈ measured (chars/3.5, ceil) + 10%. */
const CEILINGS: Record<string, number> = {
  thread: 1061, // measured 964 — includes the DM ops, add_agents/remove_agents and leave; to/all are unlisted_params and the DM text lives in TOOL.md and the snaglet-agent-collab skill
  doc: 1157, // measured 1052 — transclusion read and edit mechanics, op outline, the read size limit; raw and the rarer ops' fields are unlisted_params
  search: 1382, // measured 1256 — scoping and file/code fields are unlisted_params
  table: 793, // measured 720 — includes structured reads and compact schema-op shapes; the full fields/ops are unlisted_params
  subagent: 904, // measured 821 — pause's for/until are unlisted_params
  node: 789, // measured 717 — kind and the safety switches are unlisted_params
  file: 763, // measured 693
  container: 624, // measured 567
  shell: 489, // measured 444
  pane: 475, // measured 431
  memory: 445, // measured 404
  ask: 438, // measured 398
  tool: 442, // measured 402 — opens with when to use it (whenever a tool is not in your list) and the never-say-missing rule
  web_search: 269, // measured 244
  get_current_datetime: 219, // measured 199
  resolve_path: 213, // measured 193
  update_plan: 210, // measured 190
  action: 202, // measured 183
  orient: 188, // measured 170
  web_fetch: 142, // measured 129
  calendar: 1249, // measured 1135 — query's rarer filters and the reminder fields are unlisted_params
  hook: 812, // measured 738 — run's mock-event fields and force are unlisted_params
  automation: 775, // measured 704 — calendar_id and the list/runs filters are unlisted_params
  agent: 720, // measured 654 — admin fields and activity filters are unlisted_params
  mcp: 634, // measured 576 — the advanced create/update switches are unlisted_params
  custom_tool: 460, // measured 418
  skill: 334, // measured 303
};

function loadDefinitions(): Map<string, BuiltinToolDefinition> {
  const defs = new Map<string, BuiltinToolDefinition>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'definition.ts') {
        const def = require(full).default as BuiltinToolDefinition | undefined;
        if (def?.id && def.id in CEILINGS) defs.set(def.id, def);
      }
    }
  };
  walk(TOOLS_DIR);
  return defs;
}

const DEFS = loadDefinitions();

describe('tool schema token ceilings', () => {
  test('every ceilinged tool still has a definition on disk', () => {
    expect([...DEFS.keys()].sort()).toEqual(Object.keys(CEILINGS).sort());
  });

  test.each(Object.entries(CEILINGS))('%s stays under %i tokens on the wire', (id, ceiling) => {
    const def = DEFS.get(id)!;
    const [wire] = toAnthropicTools([def as never]);
    expect(estimateTokens(JSON.stringify(wire!), 'anthropic')).toBeLessThanOrEqual(ceiling);
  });
});
