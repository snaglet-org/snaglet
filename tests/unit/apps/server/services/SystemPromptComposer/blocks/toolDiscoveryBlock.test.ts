/**
 * toolDiscoveryBlock — the "search before you say no" rule. An agent that did
 * not see a tool in its loaded list told the user it couldn't change the color
 * theme, then that it had "lost access", when `change_color_theme` was one
 * search away. The block is a hard rule placed high in the prompt; these tests
 * pin its wording (golden), its branches, and that every tool, op and
 * parameter it names exists under that name, so a rename fails here first.
 */
import { readFileSync } from 'fs';
import path from 'path';
import {
  toolDiscoveryBlock,
  toolDiscoveryReminder,
} from '@server/services/SystemPromptComposer/blocks/toolDiscoveryBlock';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';
import toolDefinition from '@server/services/ToolService/tools/system/tool/definition';
import actionDefinition from '@server/services/ToolService/tools/system/action/definition';
import customToolDefinition from '@server/services/ToolService/tools/system/custom-tool/definition';
import themeDefinition from '@server/services/ToolService/tools/system/change-color-theme/definition';
import { makeCtx, makeTool, MINIMAL_TOOLS } from '../composeFixtures';

const REPO_ROOT = path.resolve(__dirname, '../../../../../../..');
const GENERATED_REGISTRY = path.join(
  REPO_ROOT,
  'apps/server/src/services/ToolService/generated/registry-source.static.ts'
);

const CUSTOM_TOOL = makeTool({ id: 'custom_tool', tier: 'core', categoryPath: 'system' });
const WITH_CUSTOM_TOOL = [...MINIMAL_TOOLS, CUSTOM_TOOL];

async function render(ctx: SystemPromptContext): Promise<string> {
  return (await toolDiscoveryBlock(ctx))?.text ?? '';
}

function named(agentTools = WITH_CUSTOM_TOOL, extra: Record<string, unknown> = {}) {
  const ctx = makeCtx({ agentTools });
  return {
    ...ctx,
    agent: { ...ctx.agent, name: 'Clio', ...extra },
  } as unknown as SystemPromptContext;
}

const GOLDEN = `## Tools: search before you say no
Your tool list is NOT everything you can do: many more tools exist, and you reach them by search.
1. **Search first.** Need something not in your list? \`tool({op: 'search', query: 'color theme'})\`: name the thing or the verb ("calendar event", "send email").
2. **Found it? Use it.** \`tool({op: 'schema', name: '<id>'})\` for its parameters (never guess them), then \`action({tool: '<id>', params: {...}})\`. Reuse a known tool while its schema remains available; handle access or availability errors explicitly.
3. **Blocked?** If a result or error says your tool access blocks it, tell the user exactly that; they can allow it in Agents → Clio → Capabilities.
4. **Nothing fits?** Try other words. If a new tool is the right fix, you can create one with \`custom_tool\` (op \`create\`) and call the \`tool_id\` it returns with \`action\`; the user may need to approve its code.

**NEVER declare a capability unavailable before searching the catalog. If a call fails, report the actual error rather than assuming access was lost.**

Example: the user asks for a new color theme; no theme tool is in your list.
\`tool({op: 'search', query: 'theme'})\` → \`change_color_theme\`; \`tool({op: 'schema', name: 'change_color_theme'})\` → its params; \`action({tool: 'change_color_theme', params: {op: 'set', colors: {detail: '#2f6fed'}}})\`.`;

const RULE =
  '**NEVER declare a capability unavailable before searching the catalog. If a call fails, report the actual error rather than assuming access was lost.**';
const FAILURE_RULE =
  '**If a call fails, report the actual error rather than assuming access was lost.**';

describe('toolDiscoveryBlock', () => {
  it('renders the golden rule for a normal agent', async () => {
    expect(await render(named())).toBe(GOLDEN);
  });

  it('is a hard rule: a checklist, one emphatic rule in its own paragraph, and a worked example', async () => {
    const text = await render(named());
    expect(text).toContain('Your tool list is NOT everything you can do');
    expect(text).toMatch(/^1\. \*\*Search first\.\*\*/m);
    expect(text).toMatch(/^4\. /m);
    expect(text).toContain(`\n\n${RULE}\n\n`);
    expect(text).toContain("tool({op: 'search', query: 'theme'})");
    // The loaded list's incompleteness is said once in the block.
    expect(text.match(/NOT everything|holds only the tools loaded/g)).toHaveLength(1);
  });

  it('offers creating a tool as an option, leaving its fields to the custom_tool schema', async () => {
    const text = await render(named());
    expect(text).toContain('If a new tool is the right fix, you can create one with `custom_tool`');
    expect(text).toContain('the user may need to approve its code');
    for (const param of ['parameters_schema', 'handler_source']) expect(text).not.toContain(param);
    expect(text).not.toContain('Create it:');
  });

  it('reuses a known tool only while its schema is available, never promising it is still there', async () => {
    const text = await render(named());
    expect(text).toContain(
      'Reuse a known tool while its schema remains available; handle access or availability errors explicitly.'
    );
    expect(text).not.toContain('is still there');
  });

  it('names the access setting by the agent’s own name', async () => {
    expect(await render(named())).toContain('Agents → Clio → Capabilities');
    const unnamed = await render(named(WITH_CUSTOM_TOOL, { name: '' }));
    expect(unnamed).toContain('Agents → your agent → Capabilities');
  });

  it('without custom_tool, points the user to New tool instead of telling the agent to create one', async () => {
    const text = await render(named(MINIMAL_TOOLS));
    expect(text).not.toContain('custom_tool({op:');
    expect(text).toContain(
      '4. **Nothing fits?** Say what tool you would need. The user can add one (Tools view → New tool) or allow `custom_tool` in Agents → Clio → Capabilities.'
    );
  });

  it('a subagent helper reports a blocked or missing tool instead of asking the user', async () => {
    const helper = await render(named(MINIMAL_TOOLS, { parentAgentId: 'agent-orchestrator' }));
    expect(helper).toContain(
      '3. **Blocked?** If a result or error says your tool access blocks it, say so in your report: it is blocked, not missing.'
    );
    expect(helper).toContain(
      '4. **Nothing fits?** Say in your report what tool you would need; do not claim the task is impossible.'
    );
    expect(helper).not.toContain('Agents →');
    expect(helper).toContain(RULE);
  });

  it('a tool-less run (model without native tool calling) gets no block', async () => {
    expect(await toolDiscoveryBlock(named([]))).toBeNull();
  });

  it('adapts when tool search is not in the agent’s list: ask the user to allow it', async () => {
    // `tool` is always available today (ALWAYS_AVAILABLE_TOOL_IDS), so this is
    // defensive: if it ever is missing, the prompt must not tell the agent to
    // call a tool it does not have.
    const withoutSearch = WITH_CUSTOM_TOOL.filter((at) => at.tool.id !== 'tool');
    const text = await render(named(withoutSearch));
    expect(text).not.toContain("tool({op: 'search'");
    expect(text).not.toMatch(/reach them by search|search the catalog/);
    expect(text).toContain(
      "You cannot search the tool catalog: tool search (`tool`) is off for you. Before you say you can't do something, ask the user to allow `tool` in Agents → Clio → Capabilities."
    );
    expect(text).toContain(FAILURE_RULE);
    // A helper without search reports instead of asking the user.
    const helper = await render(named(withoutSearch, { parentAgentId: 'agent-orchestrator' }));
    expect(helper).toContain("Before you say you can't do something, say so in your report.");
    expect(helper).not.toContain('Agents →');
    expect(helper).toContain(FAILURE_RULE);
  });

  it('calls found tools directly by id when the action gateway is not in the list', async () => {
    const withoutAction = WITH_CUSTOM_TOOL.filter((at) => at.tool.id !== 'action');
    const text = await render(named(withoutAction));
    expect(text).not.toContain('action({');
    expect(text).toContain('then call it by its id as a tool call.');
  });

  it('renders the same bytes whatever the thread (agent-fixed facts only)', async () => {
    const a = named();
    const b = { ...named(), threadId: 'another-thread', isGroup: true } as SystemPromptContext;
    expect(await render(a)).toBe(await render(b));
  });
});

describe('toolDiscoveryBlock names real tools, ops and params', () => {
  const registry = readFileSync(GENERATED_REGISTRY, 'utf8');
  const inRegistry = (id: string) => registry.includes(`toolId: "${id}"`);
  const ops = (def: { parameters_schema: unknown }) =>
    ((def.parameters_schema as { properties: { op: { enum: string[] } } }).properties.op.enum ??
      []) as string[];
  const props = (def: { parameters_schema: unknown }) =>
    Object.keys((def.parameters_schema as { properties: Record<string, unknown> }).properties);

  it('the search tool is `tool` with ops search and schema, taking query and name', async () => {
    const text = await render(named());
    expect(inRegistry(toolDefinition.id)).toBe(true);
    expect(text).toContain(`${toolDefinition.id}({op: 'search', query:`);
    expect(text).toContain(`${toolDefinition.id}({op: 'schema', name:`);
    expect(ops(toolDefinition)).toEqual(expect.arrayContaining(['search', 'schema']));
    expect(props(toolDefinition)).toEqual(expect.arrayContaining(['query', 'name']));
  });

  it('found tools are called through `action` with tool and params', async () => {
    const text = await render(named());
    expect(inRegistry(actionDefinition.id)).toBe(true);
    expect(text).toContain(`${actionDefinition.id}({tool: '<id>', params:`);
    expect(props(actionDefinition)).toEqual(expect.arrayContaining(['tool', 'params']));
  });

  it('tools are created with custom_tool op create, which asks the user first', async () => {
    const text = await render(named());
    expect(inRegistry(customToolDefinition.id)).toBe(true);
    expect(text).toContain(`\`${customToolDefinition.id}\` (op \`create\``);
    expect(ops(customToolDefinition)).toContain('create');
    // The approval the prompt mentions is real: create is confirm-gated.
    expect(customToolDefinition.destructiveOps).toContain('create');
    expect(customToolDefinition.description).toContain('ask the user first');
  });

  it('the worked example calls change_color_theme the way its schema says', async () => {
    const text = await render(named());
    expect(inRegistry(themeDefinition.id)).toBe(true);
    expect(text).toContain(`\`${themeDefinition.id}\``);
    expect(ops(themeDefinition)).toContain('set');
    const colors = (
      themeDefinition.parameters_schema as {
        properties: { colors: { properties: Record<string, unknown> } };
      }
    ).properties.colors.properties;
    expect(Object.keys(colors)).toContain('detail');
  });
});

describe('toolDiscoveryReminder (per-turn context tail)', () => {
  it('is one line that repeats the rule mid-conversation', () => {
    const line = toolDiscoveryReminder(WITH_CUSTOM_TOOL);
    expect(line).toBe(
      `Tools: your list is not everything you can do. Before you say you can't do something or that a tool is missing, search: \`tool({op: 'search', query})\`. Never say you "lost access" to a tool.`
    );
    expect(line?.includes('\n')).toBe(false);
  });

  it('is absent for a tool-less run and when tool search is not in the list', () => {
    expect(toolDiscoveryReminder([])).toBeNull();
    expect(
      toolDiscoveryReminder(WITH_CUSTOM_TOOL.filter((at) => at.tool.id !== 'tool'))
    ).toBeNull();
  });
});
