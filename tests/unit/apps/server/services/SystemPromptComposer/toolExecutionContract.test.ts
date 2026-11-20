import { goldenRulesBlock } from '@server/services/SystemPromptComposer/blocks/goldenRulesBlock';
import { howToActBlock } from '@server/services/SystemPromptComposer/blocks/howToActBlock';
import actionDefinition from '@server/services/ToolService/tools/system/action/definition';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';

function context(embeddingsEnabled: boolean): SystemPromptContext {
  return { embeddingsEnabled } as unknown as SystemPromptContext;
}

describe('system prompt tool execution contract', () => {
  test('teaches useful visuals with a prose-only counterexample', async () => {
    // Pins the prompt contract, not a claim of model behavior.
    const text = (await howToActBlock(context(true)))?.text ?? '';
    // A default the user can change, not a house style.
    expect(text).toContain(
      'Unless the user prefers otherwise, make one only when it clarifies a process, structure or layout'
    );
    expect(text).toContain('Mermaid in a doc for flowcharts');
    expect(text).toContain('a table or list for comparisons');
    expect(text).toContain('A short answer stays prose');
    expect(text).toContain('Keep lasting visuals in the relevant project');
  });

  test('supports direct calls and the action gateway, and forbids imitated calls', async () => {
    // Direct calls and the gateway are the action tool's own description,
    // sent with every turn; the prompt states only the never-imitate rule.
    expect(actionDefinition.description).toContain('called directly as native tool calls');
    expect(actionDefinition.description).toContain('Either path executes identically');
    const how = (await howToActBlock(context(true)))?.text ?? '';
    expect(how).not.toContain('Call any listed tool directly');
    expect(how).not.toContain('The only native execution tool is `action`');
    const rules = (await goldenRulesBlock(context(true)))?.text ?? '';
    expect(rules).toContain('never write text, JSON or markup that imitates a call or its result');
  });

  test('works the task model in its worked turn', async () => {
    const text = (await howToActBlock(context(true)))?.text ?? '';
    expect(text).toContain("table({op: 'read', table: 'tasks', ids: [id]})");
    // SQL cannot select a rev, so the guarded write takes it from the read by id.
    expect(text).not.toMatch(/SELECT[^"]*\brev\b/);
    expect(text).toContain("table({op: 'write'");
    expect(text).toContain("doc({op: 'update'");
    expect(text).toContain('Re-read both');
  });

  test('renders the same bytes in either discovery mode (discovery lives in the tool catalog)', async () => {
    const hybrid = (await howToActBlock(context(true)))?.text;
    const keyword = (await howToActBlock(context(false)))?.text;
    expect(hybrid).toBe(keyword);
    expect(hybrid).not.toContain('tool(op:search)');
  });

  test('carries no Triage emphasis — that guidance lives on get_clarification itself', async () => {
    const withTriage = {
      embeddingsEnabled: true,
      agentTools: [{ tool: { id: 'get_clarification' } }],
    } as unknown as SystemPromptContext;
    const withoutTriage = {
      embeddingsEnabled: true,
      agentTools: [{ tool: { id: 'search' } }],
    } as unknown as SystemPromptContext;
    const granted = (await howToActBlock(withTriage))?.text ?? '';
    const ungranted = (await howToActBlock(withoutTriage))?.text ?? '';
    expect(granted).not.toContain('Triage');
    expect(granted).toBe(ungranted);
  });
});
