/**
 * agent(op: update/create) skills: id-or-slug resolution, add/remove/set
 * semantics, and that bad input writes nothing.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const registry = [
  { id: 'skill-a', slug: 'tdd', scope: 'personal', projectId: null, status: 'valid' },
  { id: 'skill-b', slug: 'review', scope: 'personal', projectId: null, status: 'valid' },
  { id: 'skill-c', slug: 'review', scope: 'project', projectId: 'p1', status: 'valid' },
  { id: 'skill-d', slug: 'brainstorm', scope: 'personal', projectId: null, status: 'valid' },
  { id: 'b-search', slug: 'snaglet-search', scope: 'builtin', projectId: null, status: 'valid' },
  { id: 'b-sdk', slug: 'snaglet-sdk', scope: 'builtin', projectId: null, status: 'valid' },
  { id: 'skill-e', slug: 'snaglet-sdk', scope: 'personal', projectId: null, status: 'valid' },
];
jest.mock('@snaglet/db', () => ({
  SkillRegistry: { listAll: jest.fn(async () => registry) },
}));
const mockList = jest.fn<(agentId: string) => Promise<string[]>>();
const mockReplace = jest.fn<(agentId: string, ids: readonly string[]) => Promise<string[]>>();
jest.mock('@server/services/skills/SkillAssignmentService', () => ({
  SkillAssignmentService: { listGeneral: mockList, replaceGeneral: mockReplace },
}));
const mockCreateAgent = jest.fn(async (row: { name: string; role: string }) => ({
  id: `agent-${row.name}`,
  name: row.name,
  role: row.role,
}));
jest.mock('@server/services/AgentService', () => ({
  agentService: { create: (row: { name: string; role: string }) => mockCreateAgent(row) },
}));
jest.mock('@server/services/ConfigResolverService', () => ({ invalidateAll: async () => {} }));

import {
  applySkillChange,
  builtinSkillsNote,
  hasSkillChange,
  planSkillChange,
} from '@server/services/ToolService/handlers/agents/agentSkills';
import createAgent from '@server/services/ToolService/handlers/agents/createAgent';

const BUILTIN_IDS = new Set(['b-search', 'b-sdk']);
/** replaceGeneral as the real service behaves: built-in ids are dropped. */
const dropBuiltins = async (_a: string, ids: readonly string[]) =>
  ids.filter((id) => !BUILTIN_IDS.has(id));

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue(['skill-a', 'skill-d']);
  mockReplace.mockImplementation(async (_a, ids) => [...ids]);
});

describe('agent skills', () => {
  it('detects a skill change', () => {
    expect(hasSkillChange({})).toBe(false);
    expect(hasSkillChange({ set_skills: [] })).toBe(true);
  });

  it('adds by slug and removes by id, keeping the rest', async () => {
    const r = await applySkillChange('venus', { add_skills: ['skill-b'], remove_skills: ['tdd'] });
    expect(mockReplace).toHaveBeenCalledWith('venus', ['skill-d', 'skill-b']);
    expect(r).toMatchObject({ before: ['skill-a', 'skill-d'], after: ['skill-d', 'skill-b'] });
  });

  it('set replaces the whole set; [] clears', async () => {
    await applySkillChange('venus', { set_skills: ['brainstorm'] });
    await applySkillChange('venus', { set_skills: [] });
    expect(mockReplace.mock.calls.map((c) => c[1])).toEqual([['skill-d'], []]);
  });

  it('labels project skills in the result', async () => {
    const r = await applySkillChange('venus', { set_skills: ['skill-c'] });
    expect(r).toMatchObject({ afterLabels: ['review (project)'] });
  });

  it('refuses unknown, ambiguous and mixed input without writing', async () => {
    expect(await applySkillChange('venus', { add_skills: ['nope'] })).toMatch(/Unknown skill/);
    expect(await applySkillChange('venus', { add_skills: ['review'] })).toMatch(
      /more than one skill.*skill-b, skill-c/
    );
    expect(await applySkillChange('venus', { set_skills: ['tdd'], add_skills: ['tdd'] })).toMatch(
      /do not combine/
    );
    expect(await applySkillChange('venus', { add_skills: 'tdd' })).toMatch(/array/);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('a built-in requested by slug is reported, not assigned (the service drops it)', async () => {
    mockReplace.mockImplementation(dropBuiltins);
    const r = await applySkillChange('venus', { add_skills: ['snaglet-search', 'skill-b'] });
    expect(r).toMatchObject({
      after: ['skill-a', 'skill-d', 'skill-b'],
      builtinIgnored: ['snaglet-search'],
    });
    expect(r).not.toMatchObject({ afterLabels: expect.arrayContaining(['snaglet-search']) });
  });

  it('a slug shared by a personal skill and a built-in names the personal one', async () => {
    const plan = await planSkillChange({ set_skills: ['snaglet-sdk'] });
    expect(plan).toMatchObject({ setIds: ['skill-e'] });
    const r = await applySkillChange('venus', { set_skills: ['snaglet-sdk'] });
    expect(r).toMatchObject({ after: ['skill-e'], builtinIgnored: [] });
  });

  it('the reply note names requested built-ins, and is absent when there are none', () => {
    expect(builtinSkillsNote(['snaglet-search', 'snaglet-agent-collab'])).toEqual({
      skills_note:
        'Not assigned: snaglet-search, snaglet-agent-collab (built-in; every agent always has it).',
    });
    expect(builtinSkillsNote([])).toEqual({});
  });

  it('create: a built-in in skills is not assigned, and the reply says so', async () => {
    mockReplace.mockImplementation(dropBuiltins);
    const run = async (input: Record<string, unknown>) =>
      JSON.parse(String(await createAgent(input, {}, undefined))) as Record<string, unknown>;
    const out = await run({ name: 'N', role: 'R', skills: ['snaglet-search', 'tdd'] });
    expect(mockReplace).toHaveBeenCalledWith('agent-N', ['b-search', 'skill-a']);
    expect(out).toMatchObject({
      success: true,
      skill_ids: ['skill-a'],
      skills_note: 'Not assigned: snaglet-search (built-in; every agent always has it).',
    });
    // Only built-ins asked for: nothing assigned, still named.
    expect(await run({ name: 'O', role: 'R', skills: ['snaglet-search'] })).toMatchObject({
      success: true,
      skills_note: 'Not assigned: snaglet-search (built-in; every agent always has it).',
    });
    // No built-in asked for: no note.
    expect(await run({ name: 'M', role: 'R', skills: ['tdd'] })).not.toHaveProperty('skills_note');
  });

  it('plan resolves without touching assignments (used by create)', async () => {
    const plan = await planSkillChange({ set_skills: ['tdd', 'skill-d'] });
    expect(plan).toMatchObject({ setIds: ['skill-a', 'skill-d'] });
    expect(mockList).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
