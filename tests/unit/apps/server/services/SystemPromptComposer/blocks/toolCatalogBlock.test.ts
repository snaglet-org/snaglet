/**
 * toolCatalogBlock lists MCP servers' tools and nothing else. The core tools
 * already travel in each provider's native tool definitions with their full
 * descriptions and parameters, and `tool`'s own description teaches discovery,
 * so repeating the core ids here only duplicated the payload. The MCP tools it
 * lists are pinned, so they travel natively too; the block orients by server
 * within a rendered-text budget (summaries, then names, then a count with a
 * search pointer), sorted by id.
 */
import { CORE_TOOL_ORDER } from '@snaglet/shared/constants';
import { toolCatalogBlock } from '@server/services/SystemPromptComposer/blocks/toolCatalogBlock';
import { makeCtx, makeTool } from '../composeFixtures';

const coreTools = CORE_TOOL_ORDER.map((id) =>
  makeTool({ id, tier: 'core', description: `core ${id}`, categoryPath: 'workspace' })
);

const mcpTool = (server: string, name: string, description = `${name} on ${server}.`) =>
  makeTool({
    id: `mcp__${server}__${name}`,
    type: 'mcp',
    providerId: server,
    categoryPath: `integrations/${server}`,
    description,
  });

/** The block's rendered-text budget, in characters. */
const BUDGET = 1600;
const TOOL = makeTool({ id: 'tool', tier: 'core' });

const render = async (tools: ReturnType<typeof makeTool>[]) =>
  (await toolCatalogBlock(makeCtx({ agentTools: tools }))) as { text: string } | null;

describe('toolCatalogBlock — MCP servers only', () => {
  it('renders nothing when the agent has only core tools', async () => {
    expect(await render(coreTools)).toBeNull();
    expect(await render([])).toBeNull();
  });

  it('never lists a core tool, its description, or a discovery pointer', async () => {
    const block = await render([...coreTools, mcpTool('linear', 'create_issue')]);
    const text = block!.text;
    // Exact ids only: `mcp` is itself a core tool id and prefixes every MCP tool id.
    for (const id of CORE_TOOL_ORDER) expect(text).not.toMatch(new RegExp(`^- ${id}( —|$)`, 'm'));
    expect(text).not.toContain('core search');
    expect(text).not.toContain('Core Tools');
    expect(text).not.toContain('Tool Discovery');
  });

  it('lists each MCP tool as `id — description`, grouped by server', async () => {
    const block = await render([
      ...coreTools,
      mcpTool('linear', 'create_issue', 'Create a Linear issue.'),
      mcpTool('linear', 'list_issues'),
      mcpTool('slack', 'post_message'),
    ]);
    const text = block!.text;
    expect(text.startsWith('## MCP servers\n**linear**')).toBe(true);
    expect(text).toContain('**linear** (2 tools):');
    expect(text).toContain('- mcp__linear__create_issue — Create a Linear issue.');
    expect(text).toContain('**slack** (1 tools):');
    expect(text.indexOf('**linear**')).toBeLessThan(text.indexOf('**slack**'));
  });

  it('cuts each description to its first sentence, so long descriptions stay bounded', async () => {
    // A count cap did not bound a small server: three 5,000-character descriptions.
    const long = `Creates a page in the workspace. ${'It accepts many options. '.repeat(200)}`;
    const text = (await render([TOOL, ...['a', 'b', 'c'].map((n) => mcpTool('notes', n, long))]))!
      .text;
    expect(text).toContain('- mcp__notes__a — Creates a page in the workspace.');
    expect(text).not.toContain('It accepts many options.');
    expect(text.length).toBeLessThanOrEqual(BUDGET);
  });

  it('degrades the largest server first: names, then a count with search, then schema', async () => {
    const many = (server: string, n: number) =>
      Array.from({ length: n }, (_, i) =>
        mcpTool(server, `tool_${String(i).padStart(2, '0')}`, `Does thing ${i} in ${server}.`)
      );
    const text = (await render([TOOL, ...many('big', 90), ...many('small', 3)]))!.text;
    // The small server keeps its summaries; the big one shrinks to fit.
    expect(text).toContain('- mcp__small__tool_00 — Does thing 0 in small.');
    expect(text).not.toContain('- mcp__big__tool_00 —');
    expect(text).toMatch(
      /\*\*big\*\* \(90 tools\)(, ids `mcp__big__<name>`: tool_00, tool_01|: find one with `tool\(\{op: 'search', query\}\)`, then `tool\(\{op: 'schema', name\}\)`\.)/
    );
    expect(text.length).toBeLessThanOrEqual(BUDGET);

    const huge = (await render([TOOL, ...many('a', 99), ...many('b', 99), ...many('c', 99)]))!.text;
    expect(huge).toContain(
      "**a** (99 tools): find one with `tool({op: 'search', query})`, then `tool({op: 'schema', name})`."
    );
    expect(huge.length).toBeLessThanOrEqual(BUDGET);
  });

  it('never points at tool search for an agent without it', async () => {
    const many = Array.from({ length: 400 }, (_, i) => mcpTool('big', `t${i}`, `Thing ${i}.`));
    const text = (await render(many))!.text;
    expect(text).toContain('**big** (400 tools), each in your tool list.');
    expect(text).not.toContain('tool({op');
  });

  it('sorts servers and tools by id, so the bytes do not depend on catalog order', async () => {
    const tools = [
      mcpTool('slack', 'post_message'),
      mcpTool('linear', 'list_issues'),
      mcpTool('linear', 'create_issue'),
    ];
    const a = (await render([TOOL, ...tools]))!.text;
    const b = (await render([TOOL, ...[...tools].reverse()]))!.text;
    expect(a).toBe(b);
    expect(a.indexOf('create_issue')).toBeLessThan(a.indexOf('list_issues'));
  });

  it('is identical for every context (cache-stable)', async () => {
    const tools = [...coreTools, mcpTool('linear', 'create_issue')];
    const a = await toolCatalogBlock(makeCtx({ agentTools: tools, embeddingsEnabled: true }));
    const b = await toolCatalogBlock(makeCtx({ agentTools: tools, embeddingsEnabled: false }));
    expect(a).toEqual(b);
  });
});
