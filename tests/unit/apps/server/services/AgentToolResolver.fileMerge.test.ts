/**
 * The real file merge, end to end: no alias mock. file_read/list/info/write/
 * edit, apply_patch, diff_files → file(op). A patch is one way to update,
 * bounded by the same path guard as file_edit.
 */
const listResolvableMock = jest.fn();
const findAgentByIdMock = jest.fn();

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { listResolvable: (...args: unknown[]) => listResolvableMock(...args) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgentByIdMock(...args) },
}));
jest.mock('@server/services/ToolAvailabilityService', () => ({
  getToolAvailability: jest.fn().mockResolvedValue('available'),
}));
jest.mock('@server/services/McpService', () => ({
  mcpService: {
    ensureServersConnected: jest.fn(),
    getToolDefsForServers: jest.fn().mockReturnValue([]),
    getConfirmationPolicy: jest.fn().mockReturnValue(true),
  },
}));

import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';
import fileDefinition from '@server/services/ToolService/tools/files/file/definition';
import { resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils/toolAliases';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const OPS = (fileDefinition.parameters_schema.properties as Record<string, { enum?: string[] }>).op
  .enum as string[];

function fileRow(): ToolRow {
  return {
    id: 'file',
    name: fileDefinition.name,
    description: fileDefinition.description,
    type: 'builtin',
    parametersSchema: fileDefinition.parameters_schema,
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier: 'core',
    categoryPath: 'files',
    providerId: null,
    sortOrder: 20,
    createdAt: '',
    updatedAt: '',
  } as ToolRow;
}

const access = (partial: Partial<ToolAccessConfig>): ToolAccessConfig => ({
  mode: 'all',
  allowList: [],
  denyList: [],
  ...partial,
});

async function advertised(partial: Partial<ToolAccessConfig>): Promise<boolean> {
  findAgentByIdMock.mockResolvedValue({
    id: 'agent-1',
    toolAccessMode: partial.mode ?? 'all',
    toolAccessAllowList: partial.allowList ?? [],
    toolAccessDenyList: partial.denyList ?? [],
    toolOverrides: null,
    mcpServers: null,
  });
  const resolved = await resolveAgentTools('agent-1');
  return resolved.some(({ tool }) => tool.id === 'file');
}

const decide = (partial: Partial<ToolAccessConfig>, name: string, input: Record<string, unknown>) =>
  evaluateToolPermission(access(partial), name, input).decision;

describe('file merge with the shipped aliases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listResolvableMock.mockResolvedValue([fileRow()]);
  });

  const PATCH_B = '*** Begin Patch\n*** Update File: /b/x\n@@\n-old\n+new\n*** End Patch';
  const PATCH_A = '*** Begin Patch\n*** Update File: /a/x\n@@\n-old\n+new\n*** End Patch';

  it('ships the six ops', () => {
    expect(OPS).toEqual(['read', 'list', 'info', 'create', 'update', 'diff']);
  });

  it('pins every retired id to exactly one op of file', () => {
    expect(resolveToolId('file_read')).toMatchObject({ id: 'file', op: 'read' });
    expect(resolveToolId('file_list')).toMatchObject({ id: 'file', op: 'list' });
    expect(resolveToolId('file_info')).toMatchObject({ id: 'file', op: 'info' });
    expect(resolveToolId('file_write')).toMatchObject({ id: 'file', op: 'create' });
    expect(resolveToolId('file_edit')).toMatchObject({ id: 'file', op: 'update' });
    expect(resolveToolId('apply_patch')).toMatchObject({ id: 'file', op: 'update' });
    expect(resolveToolId('diff_files')).toMatchObject({ id: 'file', op: 'diff' });
    expect(resolveToolId('view_image')).toMatchObject({ id: 'file', op: 'read' });
    expect(resolveToolId('repo_tree')).toMatchObject({ id: 'file', op: 'list' });
  });

  it('apply_patch folds input into patch and cannot be redirected', () => {
    const out = transformToolAliasParams(resolveToolId('apply_patch'), {
      input: PATCH_A,
      op: 'create',
    });
    expect(out).toMatchObject({ op: 'update', patch: PATCH_A });
  });

  it('path guard: file_edit(/a/**) bounds a patch touching /b/x', () => {
    const partial = { mode: 'allow_list' as const, allowList: ['file_edit(/a/**)'] };
    expect(decide(partial, 'file', { op: 'update', patch: PATCH_B })).not.toBe('allow');
    expect(decide(partial, 'apply_patch', { input: PATCH_B })).not.toBe('allow');
    expect(decide(partial, 'file', { op: 'update', patch: PATCH_A })).toBe('allow');
    expect(decide(partial, 'file', { op: 'update', path: '/a/y', edits: [] })).toBe('allow');
  });

  describe('a decoy patch cannot steer the path guard', () => {
    const SECRET = '/work/secret/x.txt';
    const DECOY = '*** Begin Patch\n*** Add File: /work/allowed/y.txt\n+hi\n*** End Patch';
    const createSecret = { op: 'create', path: SECRET, content: 'x' };
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['create', 'file', createSecret],
      ['create + decoy patch', 'file', { ...createSecret, patch: DECOY }],
      ['file_write + decoy patch', 'file_write', { path: SECRET, content: 'x', patch: DECOY }],
      [
        'update edits + decoy patch',
        'file',
        { op: 'update', path: SECRET, edits: [], patch: DECOY },
      ],
    ];

    it.each(cases)('deny_list file(/work/secret/**): %s → deny', (_label, name, input) => {
      const partial = { mode: 'deny_list' as const, denyList: ['file(/work/secret/**)'] };
      expect(decide(partial, name, input)).toBe('deny');
    });

    it.each(cases)('allow_list file(/work/allowed/**): %s → not allow', (_label, name, input) => {
      const partial = { mode: 'allow_list' as const, allowList: ['file(/work/allowed/**)'] };
      expect(decide(partial, name, input)).not.toBe('allow');
    });

    it('a patch alone into the allowed tree is still allowed', () => {
      const partial = { mode: 'allow_list' as const, allowList: ['file(/work/allowed/**)'] };
      expect(decide(partial, 'file', { op: 'update', patch: DECOY })).toBe('allow');
    });
  });

  it('a scoped deny on file_edit refuses a patch into that path', () => {
    const partial = { mode: 'deny_list' as const, denyList: ['file_edit(/b/**)'] };
    expect(decide(partial, 'file', { op: 'update', patch: PATCH_B })).toBe('deny');
    expect(decide(partial, 'file', { op: 'update', patch: PATCH_A })).toBe('allow');
  });

  it('allow: only file_read → reads only', async () => {
    const partial = { mode: 'allow_list' as const, allowList: ['file_read'] };
    expect(await advertised(partial)).toBe(true);
    expect(decide(partial, 'file', { op: 'read', path: '/x' })).toBe('allow');
    expect(decide(partial, 'file', { op: 'create', path: '/x', content: '' })).toBe('ask');
  });

  it('deny: only file_write blocks create and keeps reads and updates', async () => {
    const partial = { mode: 'deny_list' as const, denyList: ['file_write'] };
    expect(await advertised(partial)).toBe(true);
    expect(decide(partial, 'file', { op: 'create', path: '/x', content: '' })).toBe('deny');
    expect(decide(partial, 'file', { op: 'read', path: '/x' })).toBe('allow');
    expect(decide(partial, 'file', { op: 'update', path: '/x', edits: [] })).toBe('allow');
  });

  it('file_edit alone can patch (apply_patch is not gated separately)', () => {
    const partial = { mode: 'allow_list' as const, allowList: ['file_edit'] };
    expect(decide(partial, 'file', { op: 'update', patch: PATCH_B })).toBe('allow');
  });

  it('denying every retired id hides file', async () => {
    expect(
      await advertised({
        mode: 'deny_list',
        denyList: ['file_read', 'file_list', 'file_info', 'file_write', 'file_edit', 'diff_files'],
      })
    ).toBe(false);
  });
});
