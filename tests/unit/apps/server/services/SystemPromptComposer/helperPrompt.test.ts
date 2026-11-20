/**
 * The lean prompt a subagent helper gets (agent.parentAgentId set): wording
 * that is only true of a top-level agent is swapped or dropped, and nothing
 * varies turn to turn for the same helper row.
 */
import { goldenRulesBlock } from '@server/services/SystemPromptComposer/blocks/goldenRulesBlock';
import { perceptionBlock } from '@server/services/SystemPromptComposer/blocks/perceptionBlock';
import { skillCatalogBlock } from '@server/services/SystemPromptComposer/blocks/skillCatalogBlock';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';

const SKILLS = [
  'snaglet-agent-collab',
  'snaglet-dms',
  'snaglet-group-threads',
  'snaglet-other-threads',
  'snaglet-projects',
  'snaglet-search',
].map((slug) => ({
  slug,
  description: `When ${slug} applies.`,
}));

function ctx(parentAgentId: string | null): SystemPromptContext {
  return {
    agent: { id: parentAgentId ? 'subagent-1' : 'agent-a', parentAgentId },
    agentTools: [{ tool: { id: 'search' } }],
    embeddingsEnabled: true,
    skillCatalog: SKILLS,
  } as unknown as SystemPromptContext;
}

describe('helper prompt variant', () => {
  it('does not list the collaboration hub or its leaves', async () => {
    const helper = (await skillCatalogBlock(ctx('agent-orchestrator')))?.text ?? '';
    const agent = (await skillCatalogBlock(ctx(null)))?.text ?? '';
    for (const slug of [
      'snaglet-agent-collab',
      'snaglet-dms',
      'snaglet-group-threads',
      'snaglet-other-threads',
    ]) {
      expect(agent).toContain(`\`${slug}\``);
      expect(helper).not.toContain(`\`${slug}\``);
    }
    expect(helper).toContain('`snaglet-search`');
    expect(helper).toContain('`snaglet-projects`');
  });

  it('says a helper sees only its thread, not that it runs in many', async () => {
    const helper = (await goldenRulesBlock(ctx('agent-orchestrator')))?.text ?? '';
    const agent = (await goldenRulesBlock(ctx(null)))?.text ?? '';
    expect(agent).toContain('You run in many threads');
    expect(helper).not.toContain('You run in many threads');
    expect(helper).toContain('You see only this thread.');
    expect(helper).toContain('`search` reaches everything the team knows');
  });

  it('is byte-identical turn to turn for the same helper row (cache-stable)', async () => {
    for (const block of [skillCatalogBlock, goldenRulesBlock, perceptionBlock]) {
      const a = (await block(ctx('agent-orchestrator')))?.text;
      const b = (await block(ctx('agent-orchestrator')))?.text;
      expect(a).toBe(b);
    }
  });
});
