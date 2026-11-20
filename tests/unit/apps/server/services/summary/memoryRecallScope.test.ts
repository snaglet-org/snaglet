/**
 * memoryRecallScope — the auto-recall project family:
 *   - flat thread → null (unscoped),
 *   - project thread → nearest + all ancestor projects + projects nested
 *     under the nearest one (nested families share recall both ways),
 *   - plus projects the query names (whole word, ≥ 4 chars, active only).
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const chain = jest.fn<(id: string) => Promise<Array<{ projectId: string }>>>();
const descendants = jest.fn<(id: string) => Promise<string[]>>();
const listAll = jest.fn<() => Promise<Array<{ id: string; name: string; archived: boolean }>>>();

jest.mock('@server/services/ToolService/lib/findProjectAncestor', () => ({
  findProjectAncestorChain: (...a: unknown[]) => chain(...(a as [string])),
}));
jest.mock('@server/services/ToolService/lib/findDescendantProjects', () => ({
  findDescendantProjects: (...a: unknown[]) => descendants(...(a as [string])),
}));
jest.mock('@snaglet/db/tables/projects', () => ({
  Projects: { listAll: () => listAll() },
}));

import {
  matchNamedProjects,
  resolveMemoryRecallProjectScope,
} from '@server/services/summary/memoryRecallScope';

const PROJECTS = [
  { id: 'p-ops', name: 'Ops', archived: false },
  { id: 'p-site', name: 'example-site', archived: false },
  { id: 'p-gallery', name: 'photo-gallery', archived: false },
  { id: 'p-old', name: 'legacy-portal', archived: true },
];

beforeEach(() => {
  jest.clearAllMocks();
  listAll.mockResolvedValue(PROJECTS);
  descendants.mockImplementation(async (id) => [id]);
});

describe('resolveMemoryRecallProjectScope', () => {
  it('flat thread → null (unscoped), no further lookups', async () => {
    chain.mockResolvedValue([]);
    expect(await resolveMemoryRecallProjectScope('t', 'anything')).toBeNull();
    expect(descendants).not.toHaveBeenCalled();
  });

  it('project thread → just its project when nothing is nested or named', async () => {
    chain.mockResolvedValue([{ projectId: 'p-ops' }]);
    expect(await resolveMemoryRecallProjectScope('t', 'memory recall bug')).toEqual({
      allowedProjectIds: ['p-ops'],
    });
  });

  it('nested: subproject thread includes its ancestors; descendants of the nearest too', async () => {
    chain.mockResolvedValue([{ projectId: 'p-child' }, { projectId: 'p-parent' }]);
    descendants.mockResolvedValue(['p-child', 'p-grandchild']);
    const scope = await resolveMemoryRecallProjectScope('t', 'q');
    expect(descendants).toHaveBeenCalledWith('p-child');
    expect(new Set(scope!.allowedProjectIds)).toEqual(
      new Set(['p-child', 'p-parent', 'p-grandchild'])
    );
  });

  it('nested: parent thread includes its subprojects', async () => {
    chain.mockResolvedValue([{ projectId: 'p-parent' }]);
    descendants.mockResolvedValue(['p-parent', 'p-child']);
    const scope = await resolveMemoryRecallProjectScope('t', 'q');
    expect(new Set(scope!.allowedProjectIds)).toEqual(new Set(['p-parent', 'p-child']));
  });

  it('adds a project the query names; never an unnamed other project', async () => {
    chain.mockResolvedValue([{ projectId: 'p-ops' }]);
    const scope = await resolveMemoryRecallProjectScope(
      't',
      'how did we do the paint in example-site?'
    );
    expect(new Set(scope!.allowedProjectIds)).toEqual(new Set(['p-ops', 'p-site']));
  });

  it('propagates lookup failure (caller fails closed)', async () => {
    chain.mockRejectedValue(new Error('db down'));
    await expect(resolveMemoryRecallProjectScope('t', 'q')).rejects.toThrow('db down');
  });
});

describe('matchNamedProjects', () => {
  it('case-insensitive whole-word match', () => {
    expect(matchNamedProjects('Photo-Gallery export', PROJECTS)).toEqual(['p-gallery']);
  });
  it('ignores names shorter than 4 chars ("Ops")', () => {
    expect(matchNamedProjects('the Ops server', PROJECTS)).toEqual([]);
  });
  it('no partial-word / hyphen-fragment matches', () => {
    const projects = [{ id: 'p-s', name: 'site', archived: false }];
    expect(matchNamedProjects('example-site', projects)).toEqual([]);
    expect(matchNamedProjects('websites', projects)).toEqual([]);
    expect(matchNamedProjects('the site page', projects)).toEqual(['p-s']);
  });
  it('skips archived projects', () => {
    expect(matchNamedProjects('legacy-portal notes', PROJECTS)).toEqual([]);
  });
  it('escapes regex metacharacters in names', () => {
    const projects = [{ id: 'p-x', name: 'c++ tools', archived: false }];
    expect(matchNamedProjects('about c++ tools today', projects)).toEqual(['p-x']);
  });
});
