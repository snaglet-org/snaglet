import { SNAGLET_SKILLS_DIR } from '@server/services/snagletHome';
import { operatingContextBlock } from '@server/services/SystemPromptComposer/blocks/operatingContextBlock';
import type { SystemPromptContext } from '@server/services/SystemPromptComposer/types';

const ctx = {} as SystemPromptContext;
const withDoc = { agentTools: [{ tool: { id: 'doc' } }] } as unknown as SystemPromptContext;

describe('operatingContextBlock — what Snaglet is and where things live', () => {
  it('explains every Snaglet part, then the two stores', async () => {
    const text = (await operatingContextBlock(ctx))?.text ?? '';
    for (const part of [
      'Agents',
      'Threads',
      'Messages',
      'Tables',
      'Docs',
      'Containers',
      'Projects',
      'Calendar',
      'Tools',
      'Memories',
      'Automations',
      'Hooks',
      'MCP servers',
      'Skills',
    ]) {
      expect(text).toContain(`- **${part}**`);
    }
    expect(text.indexOf('## What Snaglet is')).toBeLessThan(text.indexOf('### Where things live'));
    // No blank line between a heading, or a lead-in sentence, and what follows.
    expect(text).not.toMatch(/^#+ .*\n\n/m);
    expect(text).not.toMatch(/:\n\n- /);
    // Thread summaries ride the Messages bullet instead of a bullet of their own.
    expect(text).toContain('a rolling **thread summary**');
    // Containers are containers; "folder" is only a folder on disk.
    expect(text).toContain('a container groups docs, images and other containers');
    expect(text).not.toMatch(/projects, folders|a folder is a container|inside a folder/);
    // One name per thing: a table's record is a row; `entry` is only its id form.
    expect(text).toContain('one **row** per record (search and links call a row an `entry`)');
  });

  it('is identical for every context (cache-stable)', async () => {
    const a = await operatingContextBlock(ctx);
    const b = await operatingContextBlock({ isGroup: true } as unknown as SystemPromptContext);
    expect(a?.text).toBe(b?.text);
  });

  it('focuses on the project and lets outside context make connections', async () => {
    const text = (await operatingContextBlock(ctx))?.text ?? '';
    expect(text).toContain('keep your focus there and look there first');
    expect(text).toContain('Context from outside it can still help you make connections');
    expect(text).toContain('say where it came from');
    expect(text).not.toContain('say-so');
    expect(text).not.toContain('`node`');
  });

  it('leaves multi-thread reach to the golden rules and states no memory visibility claim', async () => {
    const text = (await operatingContextBlock(ctx))?.text ?? '';
    // That the agent sees only this thread lives once, in goldenRulesBlock's
    // "Check, don't assume". A line here saying memories are not shown would
    // contradict recall.
    expect(text).not.toContain('### Across threads');
    expect(text).not.toContain('memories are not shown');
    // The when-to-search and save-to-memory rules live once, elsewhere.
    expect(text).not.toContain('Load the `snaglet-search` skill');
    expect(text).not.toContain('save it with `memory`');
  });

  it('teaches clickable wiki links with the real id forms', async () => {
    const text = (await operatingContextBlock(ctx))?.text ?? '';
    expect(text).toContain('### Linking');
    // A link, not a chip: what it renders as, and why to use one.
    expect(text).toContain('Link what you mention instead of pasting its content');
    expect(text).toContain(
      'renders for the user as a clickable reference they can preview or open in a pane'
    );
    expect(text).not.toMatch(/\bchips?\b/i);
    for (const form of [
      '`doc-…`',
      '`thread-…`',
      '`memory-…`',
      '`[Clio](clio)`',
      '`table:<id>`',
      '`entry:<tableId>/<entryId>`',
      '`file:src/app.ts`',
    ]) {
      expect(text).toContain(form);
    }
    expect(text).toContain('never a guess');
    expect(text).not.toContain('(kind:id)');
    // A bare `entry:<id>` renders as a plain link: the chip needs the table id too.
    expect(text).not.toContain('`entry:<id>`');
  });

  it('keeps anchor detail in the snaglet-search skill, whose catalog line names it', async () => {
    const text = (await operatingContextBlock(withDoc))?.text ?? '';
    // The skill catalog lists snaglet-search as covering part-of-doc links and
    // part transclusions, so the block does not point at it a second time.
    expect(text).not.toContain('snaglet-search');
    expect(text).not.toContain('#h=');
    expect(text).not.toContain('#L12');
    const { readFileSync } = await import('fs');
    const path = await import('path');
    const skill = readFileSync(
      path.resolve(
        __dirname,
        '../../../../../../../apps/server/builtin-skills/snaglet-search/SKILL.md'
      ),
      'utf8'
    );
    expect(skill).toContain('## Links to part of a doc');
    expect(skill).toMatch(/^description: .*part of a doc/m);
    for (const form of [
      '#h=rate-limits',
      '#h3=',
      '#h=a..h=b',
      '#L12-L20',
      '#L12:5-L14:30',
      '![title](doc-…)',
    ]) {
      expect(skill).toContain(form);
    }
  });

  it('teaches where skills live, the SKILL.md frontmatter, and how to assign them, in two lines', async () => {
    const text = (await operatingContextBlock(ctx))?.text ?? '';
    expect(text).toContain('### Creating skills\nTo make or improve a skill');
    // A capability, not a push to turn every working process into a skill.
    expect(text).not.toContain('will be wanted again');
    expect(text).toContain(`${SNAGLET_SKILLS_DIR}/<slug>/SKILL.md`);
    expect(text).toContain('frontmatter `name` and `description`');
    expect(text).toContain('at most 1,024 characters');
    expect(text).not.toContain('12,000');
    expect(text).toContain('`add_skills: [slug]`');
    const section = text.split('### Creating skills')[1]?.split('###')[0] ?? '';
    expect(section.trim().split('\n')).toHaveLength(1);
  });

  it('explains transclusions only to an agent with the doc tool', async () => {
    const text = (await operatingContextBlock(withDoc))?.text ?? '';
    const passage = text.split('**Transclusions.**')[1] ?? '';
    expect(text.indexOf('### Linking')).toBeLessThan(text.indexOf('**Transclusions.**'));
    expect(passage).toContain('`![title](doc-id)`');
    expect(passage).toContain('`<transcluded-doc>`');
    expect(passage).toContain('editing it changes that doc and every doc that transcludes it');
    expect(passage).toContain('cannot transclude itself or any doc that transcludes it');
    expect((await operatingContextBlock(ctx))?.text).not.toContain('Transclusions');
    expect((await operatingContextBlock(withDoc))?.text).toBe(text);
  });

  it('a helper (subagent) run gets no Creating skills section, and is stable per row', async () => {
    const helperCtx = {
      agent: { id: 'subagent-1', parentAgentId: 'agent-orchestrator' },
    } as unknown as SystemPromptContext;
    const helper = (await operatingContextBlock(helperCtx))?.text ?? '';
    expect(helper).not.toContain('### Creating skills');
    expect(helper).toContain('### Linking');
    expect(helper).toContain('### Where things live');
    expect((await operatingContextBlock(helperCtx))?.text).toBe(helper);
  });
});
