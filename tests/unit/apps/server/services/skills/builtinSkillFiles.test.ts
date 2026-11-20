/**
 * A built-in skill can ship a file beside its SKILL.md (snaglet-projects'
 * file-search.md). The server bundle copies skill folders whole, and the skill
 * tool's `read` op serves any text file inside the skill's folder: this reads
 * every such file through readSkillFile from the real built-in folder.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, jest } from '@jest/globals';

const mockEffective = jest.fn();
jest.mock('@server/services/skills/skillCatalog', () => ({
  ...jest.requireActual<object>('@server/services/skills/skillCatalog'),
  loadEffectiveSkills: (...a: unknown[]) => mockEffective(...a),
}));
jest.mock('@server/services/settings', () => ({
  settingsService: { read: async () => 12_000 },
}));

import type { SkillRegistryRow } from '@snaglet/db';
import { readSkillFile } from '@server/services/skills/skillTool';

const DIR = path.resolve(__dirname, '../../../../../../apps/server/builtin-skills');

function builtinRow(slug: string): SkillRegistryRow {
  return {
    id: `builtin-${slug}`,
    scope: 'builtin',
    projectId: null,
    slug,
    name: slug,
    description: '',
    sourcePath: path.join(DIR, slug, 'SKILL.md'),
    contentHash: null,
    status: 'valid',
    error: null,
    indexedAt: '',
    createdAt: '',
    updatedAt: '',
  };
}

const extraFiles = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) =>
    readdirSync(path.join(DIR, d.name))
      .filter((file) => file !== 'SKILL.md')
      .map((file) => [d.name, file] as const)
  );

describe('built-in skill files beside SKILL.md', () => {
  it('snaglet-projects ships file-search.md', () => {
    expect(extraFiles).toContainEqual(['snaglet-projects', 'file-search.md']);
  });

  it.each(extraFiles)('%s/%s is served by the skill tool', async (slug, file) => {
    mockEffective.mockResolvedValue([builtinRow(slug)] as never);
    const text = await readSkillFile(
      { slug, path: file },
      { agentId: 'agent-1', threadId: 'thread-1' }
    );
    expect(text.startsWith(`[Skill ${slug} · ${file}]`)).toBe(true);
    const firstLine = readFileSync(path.join(DIR, slug, file), 'utf8').split('\n')[0]!;
    expect(text).toContain(firstLine);
  });
});
