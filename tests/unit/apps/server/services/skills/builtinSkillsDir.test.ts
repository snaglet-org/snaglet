/**
 * Built-in skills: the shipped folder is found from source, an env override
 * wins, and every shipped skill parses as a valid SKILL.md.
 */
import { readdirSync } from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  builtinSkillsDirCandidates,
  resolveBuiltinSkillsDir,
} from '@server/services/skills/builtinSkillsDir';
import { readSkillFolder } from '@server/services/skills/skillFile';

const REPO_DIR = path.resolve(__dirname, '../../../../../../apps/server/builtin-skills');

afterEach(() => {
  delete process.env.SNAGLET_BUILTIN_SKILLS_DIR;
});

describe('builtinSkillsDir', () => {
  it('finds apps/server/builtin-skills from the source tree', () => {
    expect(resolveBuiltinSkillsDir()).toBe(REPO_DIR);
  });

  it('SNAGLET_BUILTIN_SKILLS_DIR wins and is the only candidate', () => {
    process.env.SNAGLET_BUILTIN_SKILLS_DIR = '/opt/snaglet/skills';
    expect(builtinSkillsDirCandidates()).toEqual(['/opt/snaglet/skills']);
  });

  it('returns null when no candidate exists', () => {
    process.env.SNAGLET_BUILTIN_SKILLS_DIR = '/nonexistent/snaglet-builtin-skills';
    expect(resolveBuiltinSkillsDir()).toBeNull();
  });
});

describe('shipped built-in skills', () => {
  const slugs = readdirSync(REPO_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  it('ships the snaglet-* set', () => {
    expect(slugs).toEqual([
      'snaglet-agent-collab',
      'snaglet-dms',
      'snaglet-group-threads',
      'snaglet-other-threads',
      'snaglet-projects',
      'snaglet-sdk',
      'snaglet-search',
    ]);
  });

  it.each(slugs)('%s is a valid SKILL.md', async (slug) => {
    const parsed = await readSkillFolder(REPO_DIR, slug);
    expect(parsed.error ?? null).toBeNull();
    expect(parsed.status).toBe('valid');
  });
});
