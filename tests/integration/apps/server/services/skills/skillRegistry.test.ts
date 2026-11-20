/**
 * Skills registry against the real database and a real folder tree:
 * discovery, edit (hash changes, id stays), delete → row deleted (a skill
 * exists only while its folder does; re-adding makes a new id), invalid files
 * indexed with an error, only `~/.snaglet/skills` scanned (a project `.snaglet/skills`
 * is ignored), the startup sweep deleting leftover `project` and `missing`
 * rows, and a folder removed while the server was down deleted at start.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { Containers, getDb, Projects, SkillRegistry } from '@snaglet/db';
import {
  SkillRegistryService,
  listSkillRoots,
  markVanishedSkills,
  registerSkillFolder,
  type SkillRoot,
} from '@server/services/skills/SkillRegistryService';
import { resolveEffectiveSkills } from '@server/services/skills/resolveEffectiveSkills';
import { renderSkillCatalog, toCatalogEntries } from '@server/services/skills/skillCatalog';

const PROJECT = 'container-1111111111111-skillproj';
const md = (name: string, description = `${name} description`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}\n`;

let tmp: string;
let personalDir: string;
let projectFolder: string;

async function writeSkill(dir: string, slug: string, content: string) {
  await mkdir(path.join(dir, slug), { recursive: true });
  await writeFile(path.join(dir, slug, 'SKILL.md'), content, 'utf8');
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'skills-it-'));
  personalDir = path.join(tmp, 'home-skills');
  projectFolder = path.join(tmp, 'project');
  await mkdir(personalDir, { recursive: true });
  await mkdir(projectFolder, { recursive: true });
  await Containers.create({ id: PROJECT, name: 'Skills IT project', category: 'project' });
  await Projects.create({
    containerId: PROJECT,
    name: 'Skills IT project',
    folderPath: projectFolder,
  });
});

afterEach(async () => {
  await getDb().query('DELETE FROM public.skill_registry');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('skill registry', () => {
  const personal = (): SkillRoot => ({ scope: 'personal', projectId: null, dir: personalDir });

  it('indexes, re-indexes on edit with a stable id, deletes the row when the folder goes', async () => {
    const service = new SkillRegistryService(personalDir, 50, null);
    await writeSkill(personalDir, 'demo', md('Demo'));
    await service.syncRoots();
    try {
      const first = await SkillRegistry.findBySlug('personal', null, 'demo');
      expect(first).toMatchObject({ status: 'valid', name: 'Demo', projectId: null });
      expect(first?.sourcePath).toBe(path.join(personalDir, 'demo', 'SKILL.md'));

      // Edit with a different size so the scanner fingerprint changes.
      await writeSkill(personalDir, 'demo', md('Demo v2', 'Changed and longer description'));
      await service.scanAll();
      const edited = await SkillRegistry.findBySlug('personal', null, 'demo');
      expect(edited).toMatchObject({ id: first?.id, name: 'Demo v2', status: 'valid' });
      expect(edited?.contentHash).not.toBe(first?.contentHash);

      await rm(path.join(personalDir, 'demo'), { recursive: true });
      await service.scanAll();
      await service.idle(); // past the vanish grace period
      expect(await SkillRegistry.findBySlug('personal', null, 'demo')).toBeNull();
      expect(await SkillRegistry.findById(first!.id)).toBeNull();

      // Re-adding the folder is a new skill (new id); assignments are not restored.
      await writeSkill(personalDir, 'demo', md('Demo'));
      await service.scanAll();
      const back = await SkillRegistry.findBySlug('personal', null, 'demo');
      expect(back).toMatchObject({ status: 'valid' });
      expect(back?.id).not.toBe(first?.id);
    } finally {
      service.stop();
    }
  });

  it('indexes an invalid skill with its error instead of skipping it', async () => {
    await writeSkill(personalDir, 'broken', '# no frontmatter');
    await registerSkillFolder(personal(), 'broken');
    const row = await SkillRegistry.findBySlug('personal', null, 'broken');
    expect(row).toMatchObject({ status: 'invalid', name: '' });
    expect(row?.error).toMatch(/frontmatter/);
  });

  it('scans only ~/.snaglet/skills: a project .snaglet/skills is ignored; the startup sweep deletes project and missing rows', async () => {
    expect(await listSkillRoots(personalDir, null)).toEqual([personal()]);

    const projectSkills = path.join(projectFolder, '.snaglet', 'skills');
    await writeSkill(projectSkills, 'shared', md('Project shared'));
    await writeSkill(personalDir, 'shared', md('Personal shared'));
    // A leftover `project` row.
    const legacy = await SkillRegistry.upsertDiscovered({
      id: 'skill-legacy-project',
      scope: 'project',
      projectId: PROJECT,
      slug: 'legacy',
      name: 'Legacy',
      description: '',
      sourcePath: path.join(projectSkills, 'legacy', 'SKILL.md'),
      contentHash: null,
      status: 'valid',
      error: null,
    });

    // A leftover project row with the same slug as a personal skill.
    const legacyShared = await SkillRegistry.upsertDiscovered({
      id: 'skill-legacy-project-shared',
      scope: 'project',
      projectId: PROJECT,
      slug: 'shared',
      name: 'Project shared (old)',
      description: '',
      sourcePath: path.join(projectSkills, 'shared', 'SKILL.md'),
      contentHash: null,
      status: 'valid',
      error: null,
    });

    // A leftover personal row in the `missing` state (the CHECK allows it;
    // nothing writes it). Its folder does not exist.
    await getDb().query(
      `INSERT INTO public.skill_registry (id, scope, project_id, slug, source_path, status)
       VALUES ('skill-legacy-missing', 'personal', NULL, 'gone-before', $1, 'missing')`,
      [path.join(personalDir, 'gone-before', 'SKILL.md')]
    );

    const service = new SkillRegistryService(personalDir, undefined, null);
    await service.syncRoots();
    try {
      // Every project row and the leftover missing row are deleted; the
      // project folder is never re-indexed, so only the personal `shared` exists.
      expect(await SkillRegistry.findById(legacyShared.id)).toBeNull();
      expect(await SkillRegistry.findById(legacy.id)).toBeNull();
      expect(await SkillRegistry.findById('skill-legacy-missing')).toBeNull();
      const after = await SkillRegistry.listAll();
      expect(after.filter((r) => r.scope === 'project')).toEqual([]);
      expect(after.filter((r) => (r.status as string) === 'missing')).toEqual([]);
      expect(after.filter((r) => r.slug === 'shared').map((r) => r.scope)).toEqual(['personal']);
      expect(await SkillRegistry.findBySlug('personal', null, 'shared')).toMatchObject({
        scope: 'personal',
        projectId: null,
        name: 'Personal shared',
      });
      // Even a stale assignment to the deleted same-slug row gives one catalog
      // line: the deleted id drops as unknown before rendering.
      const personalShared = await SkillRegistry.findBySlug('personal', null, 'shared');
      const all = await SkillRegistry.listAll();
      const { effective, dropped } = resolveEffectiveSkills({
        mode: 'inherit',
        general: [{ skillId: legacyShared.id }, { skillId: personalShared!.id }],
        thread: [],
        registry: new Map(all.map((s) => [s.id, s])),
      });
      expect(dropped).toEqual([{ skillId: legacyShared.id, origin: 'general', reason: 'unknown' }]);
      const catalog = renderSkillCatalog(toCatalogEntries(effective.map((e) => e.skill)));
      expect(catalog?.split('\n').filter((l) => l.startsWith('- `shared`'))).toEqual([
        '- `shared` — Personal shared description',
      ]);
    } finally {
      service.stop();
      await rm(path.join(projectFolder, '.snaglet'), { recursive: true, force: true });
      await rm(path.join(personalDir, 'shared'), { recursive: true, force: true });
    }
  });

  it('deletes the row of a folder removed while the server was down, at start', async () => {
    await writeSkill(personalDir, 'offline', md('Offline'));
    await registerSkillFolder(personal(), 'offline');
    await rm(path.join(personalDir, 'offline'), { recursive: true });
    await markVanishedSkills(personal());
    expect(await SkillRegistry.findBySlug('personal', null, 'offline')).toBeNull();
  });

  it('the database refuses a personal row with a project and a bad slug', async () => {
    await expect(
      getDb().query(
        `INSERT INTO public.skill_registry (id, scope, project_id, slug, source_path)
         VALUES ('skill-x', 'personal', $1, 'ok', '/x')`,
        [PROJECT]
      )
    ).rejects.toThrow(/skill_registry_scope_project_chk/);
    await expect(
      getDb().query(
        `INSERT INTO public.skill_registry (id, scope, slug, source_path)
         VALUES ('skill-y', 'personal', '../evil', '/x')`
      )
    ).rejects.toThrow(/check/);
  });

  it('built-ins: indexed as scope builtin, effective with no assignment, a personal copy wins', async () => {
    const builtinDir = path.join(tmp, 'builtin-skills');
    await writeSkill(builtinDir, 'snaglet-shipped', md('Shipped'));
    await writeSkill(builtinDir, 'shared', md('Shared builtin'));
    await writeSkill(personalDir, 'shared', md('Shared personal'));
    const roots = await listSkillRoots(personalDir, builtinDir);
    expect(roots.map((r) => r.scope)).toEqual(['personal', 'builtin']);
    for (const root of roots) {
      await registerSkillFolder(root, 'shared');
      if (root.scope === 'builtin') await registerSkillFolder(root, 'snaglet-shipped');
    }
    const builtin = await SkillRegistry.listBuiltinValid();
    expect(builtin.map((r) => r.slug)).toEqual(['shared', 'snaglet-shipped']);
    expect(builtin.every((r) => r.scope === 'builtin' && r.projectId === null)).toBe(true);

    const none = resolveEffectiveSkills({
      mode: 'inherit',
      general: [],
      thread: [],
      registry: new Map(),
      builtin,
    });
    expect(none.effective.map((e) => e.skill.slug)).toEqual(['shared', 'snaglet-shipped']);

    const mine = (await SkillRegistry.findBySlug('personal', null, 'shared'))!;
    const withMine = resolveEffectiveSkills({
      mode: 'inherit',
      general: [{ skillId: mine.id }],
      thread: [],
      registry: new Map([[mine.id, mine]]),
      builtin,
    });
    expect(withMine.effective.map((e) => `${e.skill.slug}:${e.skill.scope}`)).toEqual([
      'shared:personal',
      'snaglet-shipped:builtin',
    ]);
  });

  it('the database refuses a builtin row with a project, and a duplicate builtin slug', async () => {
    await expect(
      getDb().query(
        `INSERT INTO public.skill_registry (id, scope, project_id, slug, source_path)
         VALUES ('skill-b1', 'builtin', $1, 'ok', '/x')`,
        [PROJECT]
      )
    ).rejects.toThrow(/skill_registry_scope_project_chk/);
    await getDb().query(
      `INSERT INTO public.skill_registry (id, scope, slug, source_path)
       VALUES ('skill-b2', 'builtin', 'dup', '/x')`
    );
    await expect(
      getDb().query(
        `INSERT INTO public.skill_registry (id, scope, slug, source_path)
         VALUES ('skill-b3', 'builtin', 'dup', '/y')`
      )
    ).rejects.toThrow(/skill_registry_builtin_slug_uq/);
  });
});
