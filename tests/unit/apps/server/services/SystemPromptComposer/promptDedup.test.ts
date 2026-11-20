/**
 * One home per rule. What the agent sees and when to look something up live
 * in goldenRulesBlock's "Check, don't assume"; when to load snaglet-search in that
 * skill's catalog line; the save-to-memory rule and how to read a recalled
 * memory in perceptionBlock's Memory section; chat vs doc vs memory in
 * goldenRulesBlock's "Write down what lasts". The other blocks and the tool
 * descriptions may point at them but must not restate them, so the copies
 * cannot drift apart.
 */
jest.mock('@snaglet/db/tables/users', () => ({
  Users: { getActiveUser: jest.fn().mockResolvedValue({ name: 'Test User' }) },
}));
jest.mock('@server/services/SystemPromptComposer/hostMachine', () => ({
  describeHostMachine: () => 'a test computer running TestOS',
}));

import { goldenRulesBlock } from '@server/services/SystemPromptComposer/blocks/goldenRulesBlock';
import { howToActBlock } from '@server/services/SystemPromptComposer/blocks/howToActBlock';
import { operatingContextBlock } from '@server/services/SystemPromptComposer/blocks/operatingContextBlock';
import { perceptionBlock } from '@server/services/SystemPromptComposer/blocks/perceptionBlock';
import { runModeBlock } from '@server/services/SystemPromptComposer/blocks/runModeBlock';
import { subagentBlock } from '@server/services/SystemPromptComposer/blocks/subagentBlock';
import searchDefinition from '@server/services/ToolService/tools/workspace/search/definition';
import { MEMORY_RECALL_HEADER } from '@server/services/summary/memoryRecallSegment';
import { makeCtx, makeTool, MINIMAL_TOOLS } from './composeFixtures';

async function coreText(): Promise<string> {
  const ctx = makeCtx({
    embeddingsEnabled: true,
    agentTools: [
      ...MINIMAL_TOOLS,
      makeTool({ id: 'subagent' }),
      makeTool({ id: 'thread' }),
      makeTool({ id: 'doc' }),
      makeTool({ id: 'table' }),
    ],
  });
  const blocks = await Promise.all(
    [
      goldenRulesBlock,
      operatingContextBlock,
      howToActBlock,
      perceptionBlock,
      runModeBlock,
      subagentBlock,
    ].map((b) => b(ctx))
  );
  return blocks.map((b) => (b as { text?: string } | null)?.text ?? '').join('\n\n');
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('prompt rules are stated once', () => {
  it('search: where search reaches is said once, and snaglet-search is left to its catalog line', async () => {
    const text = await coreText();
    expect(count(text, '`search` reaches everything the team knows')).toBe(1);
    expect(count(text, 'see only this one')).toBe(1);
    // The skill catalog says when to load snaglet-search (and that it covers
    // anchors and embeds), so no core block points at it again.
    expect(count(text, 'snaglet-search')).toBe(0);
  });

  it('evidence: when to look something up is stated once', async () => {
    const text = await coreText();
    expect(count(text, 'never answer from recall')).toBe(1);
    expect(count(text, 'Search results are leads')).toBe(1);
    expect(text).not.toContain('Look things up before you claim them');
    expect(text).not.toContain("**Use what's already in context.**");
  });

  it('durable knowledge: chat vs doc vs memory is one policy', async () => {
    const text = await coreText();
    expect(count(text, 'Short answers stay in chat')).toBe(1);
    expect(count(text, 'edit instead of duplicating')).toBe(1);
    expect(text).not.toContain('rather than start');
    // Tasks as table rows are described once, in perceptionBlock's Docs and tables.
    expect(count(text, 'Tasks can be tracked as table rows')).toBe(1);
    expect(text).not.toContain('Put plans, decisions and findings in a doc or in memory');
    // A "memories are not shown" line would contradict automatic recall.
    expect(text).not.toContain('memories are not shown');
  });

  it('time: one line, no restatement of the get_current_datetime description', async () => {
    const text = await coreText();
    expect(count(text, '`get_current_datetime`')).toBe(1);
  });

  it('recalled memories: how to read one lives in the cached Memory section, not the tail header', async () => {
    const text = await coreText();
    expect(count(text, 'Recalled memories may be stale')).toBe(1);
    expect(MEMORY_RECALL_HEADER).not.toMatch(/stale|verify/i);
  });

  it('coordination one-liners appear once each', async () => {
    const text = await coreText();
    expect(count(text, 'never a "still waiting" post')).toBe(1);
    expect(count(text, '(one helper per piece, a few at a time)')).toBe(1);
  });

  it('computer and browser: one short ungated line of safety rules, detail only when advertised', async () => {
    const text = await coreText();
    expect(text).not.toContain("**The user's computer and browser.**");
    expect(count(text, '**Browser and desktop.**')).toBe(1);
    expect(count(text, 'sends, deletes or buys')).toBe(1);
    expect(text).not.toContain('## Computer');
    expect(text).not.toContain('## Browser');
    // With both tools advertised the gated sections add detail, not the same rules again.
    const both = makeCtx({
      agentTools: [...MINIMAL_TOOLS, makeTool({ id: 'browser' }), makeTool({ id: 'computer' })],
    });
    const all = [await howToActBlock(both), await perceptionBlock(both)]
      .map((b) => b?.text ?? '')
      .join('\n\n');
    expect(all).toContain('## Browser');
    expect(all).toContain('## Computer');
    expect(count(all, 'sends, deletes or buys')).toBe(1);
    expect(count(all, 'say what you are about to do')).toBe(1);
  });

  it('search: the steward bullet does not repeat "search before creating"', async () => {
    const text = await coreText();
    expect(text).not.toContain('search before creating');
    expect(text).toContain('Check for an existing node before creating');
  });

  it('search: the tool description says what the tool does, not when to call it', () => {
    expect(searchDefinition.description).not.toContain('Call it first whenever');
    expect(searchDefinition.description).toContain('Discover:');
  });

  it('memory: the what-to-save instruction appears once', async () => {
    const text = await coreText();
    expect(count(text, 'save what a later conversation will need')).toBe(1);
    expect(text).not.toContain('save it with `memory`');
    expect(text).not.toContain('with `memory`. Tell them');
    expect(text).toContain('or secrets');
    // The lesson-saving guidance moved to its home instead of being dropped.
    expect(text).toContain('about your own work (lessons on how to do it better)');
  });
});
