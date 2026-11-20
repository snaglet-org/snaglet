/**
 * Tool-reference assertions.
 *
 *   - Every tool id named in a block's prose exists in the generated tool
 *     registry; a prose reference to a renamed or removed tool is an orphaned
 *     instruction.
 *   - Every tool the prose tells agents to "call directly" is `core` tier, so
 *     it is natively advertised to the provider (contextAssembly.ts only puts
 *     core-tier tools in the `tools` field) rather than routed through the
 *     action gateway.
 *
 * Both read from disk (generated registry + tool definitions) and render the
 * prose blocks directly. The prose blocks are pure functions of context — no
 * services — so no mocks are needed here.
 */

import { readFileSync, readdirSync } from 'fs';
import path from 'path';

import { goldenRulesBlock } from '@server/services/SystemPromptComposer/blocks/goldenRulesBlock';
import { howToActBlock } from '@server/services/SystemPromptComposer/blocks/howToActBlock';
import { perceptionBlock } from '@server/services/SystemPromptComposer/blocks/perceptionBlock';
import { operatingContextBlock } from '@server/services/SystemPromptComposer/blocks/operatingContextBlock';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';
import {
  makeCtx,
  FULL_TOOLS,
  MINIMAL_TOOLS,
  PROJECT_RUN_PARAMS,
  TABLE_TOOLS,
} from './composeFixtures';

// locate source on disk (repo root is 6 dirs above this test file)
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const TOOLS_DIR = path.join(REPO_ROOT, 'apps/server/src/services/ToolService/tools');
const GENERATED_REGISTRY = path.join(
  REPO_ROOT,
  'apps/server/src/services/ToolService/generated/registry-source.static.ts'
);

/** Snake_case identifiers that appear in prose but are not tool ids. */
const NON_TOOL_ALLOWLIST = new Set<string>([
  // workspace_search / perception parameter names surfaced in guidance prose
  'include_archived',
  'time_range',
  'container_id',
  // agent (update) parameter named in the creating-skills guidance
  'agent_id',
  // pane (navigate) parameter surfaced in the UI guidance
  'pane_key',
  // Triage (get_clarification) form field types named in the howToAct emphasis
  'single_select',
  'multi_select',
  'allow_other',
]);

/** Read every tool id the generated registry knows about. */
function loadRegistryToolIds(): Set<string> {
  const src = readFileSync(GENERATED_REGISTRY, 'utf8');
  const ids = new Set<string>();
  for (const m of src.matchAll(/toolId:\s*"([a-z0-9_]+)"/g)) ids.add(m[1]);
  return ids;
}

/** Read (id -> tier) for every builtin tool definition on disk. */
function loadTierById(): Map<string, 'core' | 'standard'> {
  const tiers = new Map<string, 'core' | 'standard'>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.name === 'definition.ts') {
        const src = readFileSync(path.join(dir, entry.name), 'utf8');
        const id = src.match(/\bid:\s*['"]([a-z0-9_]+)['"]/)?.[1];
        if (!id) continue;
        const tier = src.match(/\btier:\s*['"](core|standard)['"]/)?.[1] as
          | 'core'
          | 'standard'
          | undefined;
        tiers.set(id, tier ?? 'standard');
      }
    }
  };
  walk(TOOLS_DIR);
  return tiers;
}

/**
 * Extract candidate tool-id tokens from prose. Two shapes count as a tool
 * reference; single backticked words without an underscore (e.g. `task`,
 * `hybrid`, `open` — enum values, not tools) are ignored:
 *   - a call form  `foo(`  (catches the underscore-less `action`)
 *   - a standalone backticked snake_case id  `\`foo_bar\``
 */
function extractToolTokens(prose: string): Set<string> {
  const tokens = new Set<string>();
  // call form: identifier immediately followed by `(` (no space). The lookbehind keeps the
  // tail of a capitalized word out, such as `ntel(` from a CPU named "Intel(R)".
  for (const m of prose.matchAll(/(?<![A-Za-z0-9_])([a-z][a-z0-9_]+)\(/g)) tokens.add(m[1]);
  // standalone backticked identifier, only if it contains an underscore
  for (const m of prose.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) tokens.add(m[1]);
  return tokens;
}

async function text(
  block: (ctx: SystemPromptContext) => Promise<{ text: string } | null>,
  ctx: SystemPromptContext
): Promise<string> {
  return (await block(ctx))?.text ?? '';
}

/** Concatenate the prose of every branch of every tool-referencing block. */
async function collectAllProse(): Promise<string> {
  const groupProject = makeCtx({
    isGroup: true,
    agentTools: FULL_TOOLS,
    runParams: PROJECT_RUN_PARAMS,
    embeddingsEnabled: true,
  });
  const soloKeyword = makeCtx({ agentTools: FULL_TOOLS, embeddingsEnabled: false });
  const soloNoProject = makeCtx({ agentTools: MINIMAL_TOOLS, embeddingsEnabled: false });

  const parts = await Promise.all([
    text(goldenRulesBlock, groupProject),
    text(goldenRulesBlock, soloNoProject),
    text(howToActBlock, groupProject),
    text(howToActBlock, soloKeyword),
    text(perceptionBlock, groupProject),
    text(perceptionBlock, soloKeyword),
    text(perceptionBlock, makeCtx({ agentTools: [...FULL_TOOLS, ...TABLE_TOOLS] })),
    text(operatingContextBlock, groupProject),
    text(operatingContextBlock, soloNoProject),
  ]);
  return parts.join('\n\n');
}

describe('system prompt prose — tool references', () => {
  test('every tool id named in block prose exists in the generated registry', async () => {
    const registry = loadRegistryToolIds();
    expect(registry.size).toBeGreaterThanOrEqual(60); // sanity: the registry loaded

    const prose = await collectAllProse();
    const unknown: string[] = [];
    for (const token of extractToolTokens(prose)) {
      if (NON_TOOL_ALLOWLIST.has(token)) continue;
      if (token.startsWith('mcp__')) continue; // live MCP tools, not builtin registry entries
      if (!registry.has(token)) unknown.push(token);
    }

    expect(unknown.sort()).toEqual([]);
  });
});

describe('system prompt prose — tier promotion', () => {
  const CALL_DIRECTLY_CORE = ['search', 'node', 'tool', 'action'];

  test.each(CALL_DIRECTLY_CORE)('%s is core tier (natively advertised)', (id) => {
    const tiers = loadTierById();
    expect(tiers.get(id)).toBe('core');
  });
});
