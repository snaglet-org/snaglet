/**
 * Every built-in skill the system prompt tells an agent to load must exist in
 * the shipped folder, and each shipped skill must be a valid SKILL.md short
 * enough to load in one part. Skills have no length limit (a long one loads in
 * parts), but a built-in is read by many agents, so it stays whole. A rename or deletion cannot leave the prompt pointing at nothing.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';
import { SKILL_DESCRIPTION_MAX_CHARS, readSkillFolder } from '@server/services/skills/skillFile';
import { toolSettings } from '@server/services/settings/categories/tool';

const ROOT = path.resolve(__dirname, '../../../../../..');
const BUILTIN = path.join(ROOT, 'apps/server/builtin-skills');
const BLOCKS = path.join(ROOT, 'apps/server/src/services/SystemPromptComposer/blocks');

/** Room in one `skill` load at the default max_result_chars, after its header line. */
const ONE_PART_CHARS = toolSettings.maxResultChars.default - 200;

// Every built-in slug the composer names: a pointer ("the `snaglet-x` skill", in
// a block or the turn-context tail) or a quoted slug (skillCatalogBlock's list
// of skills hidden from helpers). The skill catalog itself says when to load
// each one, so the blocks name few of them.
const COMPOSER = path.join(ROOT, 'apps/server/src/services/SystemPromptComposer');
const referenced = new Set<string>();
for (const dir of [BLOCKS, COMPOSER]) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/\\?`(snaglet-[a-z0-9-]+)\\?` skill/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/\bthe (snaglet-[a-z0-9-]+) skill/g)) referenced.add(m[1]);
    for (const m of src.matchAll(/'(snaglet-[a-z0-9-]+)'/g)) referenced.add(m[1]);
  }
}

describe('skills the prompt references', () => {
  it('finds the references (guards the scan itself)', () => {
    // The helper's hidden list names the hub and its three leaves; the
    // unread-DM line points straight at snaglet-dms.
    expect([...referenced].sort()).toEqual(
      expect.arrayContaining([
        'snaglet-agent-collab',
        'snaglet-dms',
        'snaglet-group-threads',
        'snaglet-other-threads',
      ])
    );
    expect(referenced.has('snaglet-cross-thread')).toBe(false);
  });

  it.each([...referenced].sort())('%s ships as a built-in skill', (slug) => {
    expect(existsSync(path.join(BUILTIN, slug, 'SKILL.md'))).toBe(true);
  });
});

describe('every shipped built-in skill', () => {
  const slugs = readdirSync(BUILTIN, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it.each(slugs)('%s is valid and every file in it loads in one part', async (slug) => {
    const parsed = await readSkillFolder(BUILTIN, slug);
    expect(parsed.error ?? null).toBeNull();
    expect(parsed.description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX_CHARS);
    for (const file of readdirSync(path.join(BUILTIN, slug))) {
      const body = readFileSync(path.join(BUILTIN, slug, file), 'utf8');
      expect({ file, fits: body.length <= ONE_PART_CHARS }).toEqual({ file, fits: true });
    }
  });

  it.each(slugs)(
    '%s: every extra file is named in its SKILL.md, and every file it names exists',
    (slug) => {
      const files = readdirSync(path.join(BUILTIN, slug));
      const skill = readFileSync(path.join(BUILTIN, slug, 'SKILL.md'), 'utf8');
      for (const file of files.filter((f) => f !== 'SKILL.md')) {
        expect({ slug, file, named: skill.includes(`\`${file}\``) }).toEqual({
          slug,
          file,
          named: true,
        });
      }
      for (const m of skill.matchAll(/`([a-z0-9-]+\.md)`/g)) {
        if (m[1] === 'SKILL.md') continue;
        expect({ slug, file: m[1], exists: files.includes(m[1]!) }).toEqual({
          slug,
          file: m[1],
          exists: true,
        });
      }
    }
  );

  it('keeps the collaboration skills as single files', () => {
    for (const slug of [
      'snaglet-agent-collab',
      'snaglet-group-threads',
      'snaglet-other-threads',
      'snaglet-dms',
    ]) {
      expect(readdirSync(path.join(BUILTIN, slug))).toEqual(['SKILL.md']);
    }
  });
});

describe('skills that name other skills', () => {
  const slugs = readdirSync(BUILTIN, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it.each(slugs)('%s only points at built-in skills that exist', (slug) => {
    const body = readFileSync(path.join(BUILTIN, slug, 'SKILL.md'), 'utf8');
    // Every backticked `snaglet-…` slug is a skill (commands such as `snaglet run` have
    // a space, so they never match).
    for (const m of body.matchAll(/`(snaglet-[a-z0-9-]+)`/g)) expect(slugs).toContain(m[1]);
  });
});

describe('built-in skill frontmatter', () => {
  it('names every skill by its folder slug, the name the catalog shows', () => {
    const dirs = readdirSync(BUILTIN, { withFileTypes: true }).filter((d) => d.isDirectory());
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const text = readFileSync(path.join(BUILTIN, d.name, 'SKILL.md'), 'utf8');
      const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
      expect({ folder: d.name, name }).toEqual({ folder: d.name, name: d.name });
    }
  });
});

describe('one vocabulary across the built-in skills', () => {
  const slugs = readdirSync(BUILTIN, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  it.each(slugs)(
    '%s says link (not chip), transclude (not embed), container (not folder)',
    (slug) => {
      const body = readFileSync(path.join(BUILTIN, slug, 'SKILL.md'), 'utf8');
      expect(body).not.toMatch(/\bchips?\b/i);
      expect(body).not.toMatch(/\bembed(s|ded)?\b|inline reference/i);
      // "Folder" is a folder on disk only; a workspace container is a container.
      expect(body).not.toMatch(/projects and folders|project, folder or|a folder is a container/i);
    }
  );
});

describe('tasks may be table rows, never must be', () => {
  const slugs = readdirSync(BUILTIN, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it('snaglet-projects says a task can be a row, and why rows suit long-term tasks', () => {
    const body = readFileSync(path.join(BUILTIN, 'snaglet-projects', 'SKILL.md'), 'utf8');
    const section = body.split('## Tasks and tables')[1]?.split(/\n## /)[0] ?? '';
    expect(section).toContain("A task doesn't have to be a table row");
    expect(section).toContain('rows are an efficient way to query and track long-term tasks');
  });

  it.each(slugs)('%s does not require tasks to be table rows', (slug) => {
    const body = readFileSync(path.join(BUILTIN, slug, 'SKILL.md'), 'utf8');
    expect(body).not.toMatch(/\btasks? (?:are|is|must be) (?:always )?(?:a )?(?:table )?rows?\b/i);
    expect(body).not.toMatch(/\btasks and other (?:table )?rows\b/i);
  });
});

describe('snaglet-sdk content', () => {
  const body = readFileSync(path.join(BUILTIN, 'snaglet-sdk', 'SKILL.md'), 'utf8');

  it('encourages condensing recurring work, and keeps the boundary', () => {
    const description = /^description: (.*)$/m.exec(body)?.[1] ?? '';
    expect(description).toContain(
      'repeating the same tool calls or a complex operation will recur'
    );
    expect(description).toContain('condense it into a script, custom tool, hook or automation');
    expect(description).toContain('one run replaces many turns of repeated calls');
    expect(description).toContain('keeps bulk data out of your context');
    expect(description).toContain('the decisions stay with you or the user');
    expect(description).toContain('Not for small one-off edits or steps that need judgment');
    // Each form with when it is right and where it is built.
    for (const form of [
      '**Script** (`snaglet run`, run from `shell`): a bulk job now',
      '**Custom tool** (`custom_tool` op `create`): a routine agents will call again',
      '**Hook** (`hook` op `create`, in `~/.snaglet/hooks/`): something that should happen when an event occurs',
      '**Automation** (`automation` op `create`): something that should happen on a schedule',
    ]) {
      expect(body).toContain(form);
    }
  });

  it('fetches schemas with tool op schema, not the retired get_tool_schema', () => {
    expect(body).not.toContain('get_tool_schema');
    expect(body).toContain('`tool` op `schema`');
  });

  it('says new hooks are created disabled, a person enables them, and run makes real changes', () => {
    expect(body).toContain('`hook` tool');
    expect(body).toContain('op `create`');
    expect(body).toContain('registered **disabled**');
    expect(body).toContain('a person turns it on');
    expect(body).toContain('`force: true`');
    expect(body).toContain('real changes');
    expect(body).toMatch(/never claim (it|the hook|a hook) runs automatically/i);
  });

  it('guards against hooks that trigger themselves', () => {
    expect(body).toContain('### Avoid feedback loops');
    const section = body.split('### Avoid feedback loops')[1]?.split(/\n#{2,3} /)[0] ?? '';
    expect(
      section
        .trim()
        .split('\n')
        .filter((l) => l.startsWith('- '))
    ).toHaveLength(3);
  });

  it('explains the scripts folder is created by snaglet create-script', () => {
    expect(body).toContain('created by `snaglet create-script`');
  });
});
