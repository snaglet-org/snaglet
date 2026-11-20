/**
 * Op-scoped aliases: an alias id absorbed into a merged `tool(op)` keeps
 * meaning exactly one op in stored access lists — no silent widening or
 * narrowing. Uses a stand-in `memory(op)` so the test does not depend on the
 * shipped alias table.
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

jest.mock('@snaglet/shared/utils/toolAliases', () => {
  const actual = jest.requireActual('@snaglet/shared/utils/toolAliases');
  const ops: Record<string, string> = {
    memory_save: 'create',
    memory_search: 'search',
    memory_edit: 'update',
    memory_forget: 'delete',
  };
  const resolveToolId = (id: string) =>
    ops[id]
      ? {
          id: 'memory',
          aliasedFrom: id,
          op: ops[id],
          transformParams: (p: Record<string, unknown>) => ({ ...p, op: ops[id] }),
        }
      : actual.resolveToolId(id);
  return {
    ...actual,
    resolveToolId,
    toolIdsEquivalent: (a: string, b: string) => resolveToolId(a).id === resolveToolId(b).id,
    toolAliasIdsFor: (target: string) =>
      resolveToolId(target).id === 'memory' ? Object.keys(ops) : actual.toolAliasIdsFor(target),
  };
});

import { resolveAgentTools } from '@server/services/AgentToolResolver';
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const MEMORY_OPS = ['search', 'create', 'update', 'delete'];

function tool(id: string, ops?: string[]): ToolRow {
  return {
    id,
    name: id,
    description: id,
    type: 'builtin',
    parametersSchema: ops
      ? { type: 'object', properties: { op: { type: 'string', enum: ops } } }
      : {},
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier: 'core',
    categoryPath: 'test',
    providerId: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  } as ToolRow;
}

function agent(access: Partial<ToolAccessConfig>) {
  return {
    id: 'agent-1',
    toolAccessMode: access.mode ?? 'all',
    toolAccessAllowList: access.allowList ?? [],
    toolAccessDenyList: access.denyList ?? [],
    toolOverrides: null,
    mcpServers: null,
  };
}

async function advertisedIds(access: Partial<ToolAccessConfig>): Promise<string[]> {
  findAgentByIdMock.mockResolvedValue(agent(access));
  const resolved = await resolveAgentTools('agent-1');
  return resolved.map(({ tool: row }) => row.id);
}

const access = (partial: Partial<ToolAccessConfig>): ToolAccessConfig => ({
  mode: 'all',
  allowList: [],
  denyList: [],
  ...partial,
});

describe('op-scoped aliases after a merge (memory_* → memory)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listResolvableMock.mockResolvedValue([tool('memory', MEMORY_OPS), tool('file_read')]);
  });

  describe('advertisement', () => {
    it('advertises the merged tool when an allow list names one old id', async () => {
      expect(await advertisedIds({ mode: 'allow_list', allowList: ['memory_save'] })).toEqual([
        'memory',
      ]);
    });

    it('keeps the merged tool visible when only some ops are denied', async () => {
      expect(await advertisedIds({ mode: 'deny_list', denyList: ['memory_forget'] })).toContain(
        'memory'
      );
    });

    it('hides the merged tool when every op is denied by old ids', async () => {
      const ids = await advertisedIds({
        mode: 'deny_list',
        denyList: ['memory_save', 'memory_search', 'memory_edit', 'memory_forget'],
      });
      expect(ids).not.toContain('memory');
      expect(ids).toContain('file_read');
    });

    it('a canonical bare deny still hides the whole tool', async () => {
      expect(await advertisedIds({ mode: 'deny_list', denyList: ['memory'] })).not.toContain(
        'memory'
      );
    });
  });

  describe('per-call permission', () => {
    const active = new Set(['memory', 'file_read']);

    it('allow-listing memory_save permits create and not delete', () => {
      const a = access({ mode: 'allow_list', allowList: ['memory_save'] });
      expect(
        evaluateToolPermission(a, 'memory', { op: 'create' }, { activeToolIds: active }).decision
      ).toBe('allow');
      const verdict = evaluateToolPermission(
        a,
        'memory',
        { op: 'delete' },
        { activeToolIds: active }
      );
      expect(verdict.decision).toBe('ask');
      expect(verdict.reason).toContain('Allowed ops: create');
    });

    it('denying memory_forget blocks delete only', () => {
      const a = access({ mode: 'deny_list', denyList: ['memory_forget'] });
      expect(
        evaluateToolPermission(a, 'memory', { op: 'delete' }, { activeToolIds: active }).decision
      ).toBe('deny');
      expect(
        evaluateToolPermission(a, 'memory', { op: 'search' }, { activeToolIds: active }).decision
      ).toBe('allow');
    });

    it('a call through the old id pins its op and cannot be redirected', () => {
      const a = access({ mode: 'deny_list', denyList: ['memory_forget'] });
      // memory_save pins op=create, so smuggling op:'delete' cannot reach delete via it.
      expect(
        evaluateToolPermission(a, 'memory_save', { op: 'delete' }, { activeToolIds: active })
          .decision
      ).toBe('allow');
      expect(
        evaluateToolPermission(a, 'memory_forget', {}, { activeToolIds: active }).decision
      ).toBe('deny');
    });
  });
});

/**
 * The access matrix: each stored-list shape, checked end to end against both
 * surfaces — is `memory` advertised, and which ops does
 * the per-call check allow? `refused` ops must carry a plain message.
 */
describe('access matrix (advertise + per-call)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listResolvableMock.mockResolvedValue([tool('memory', MEMORY_OPS), tool('file_read')]);
  });

  const cases: Array<{
    name: string;
    access: Partial<ToolAccessConfig>;
    advertised: boolean;
    allowed: string[];
  }> = [
    {
      name: 'allow only an alias',
      access: { mode: 'allow_list', allowList: ['memory_save'] },
      advertised: true,
      allowed: ['create'],
    },
    {
      name: 'deny only an alias',
      access: { mode: 'deny_list', denyList: ['memory_forget'] },
      advertised: true,
      allowed: ['search', 'create', 'update'],
    },
    {
      name: 'mix: two aliases allowed, one of them also denied',
      access: {
        mode: 'allow_list',
        allowList: ['memory_save', 'memory_forget'],
        denyList: ['memory_forget'],
      },
      advertised: true,
      allowed: ['create'],
    },
    {
      name: 'bare new-tool allow covers every op',
      access: { mode: 'allow_list', allowList: ['memory'] },
      advertised: true,
      allowed: MEMORY_OPS,
    },
    {
      name: 'every op denied by aliases hides the tool',
      access: {
        mode: 'deny_list',
        denyList: ['memory_save', 'memory_search', 'memory_edit', 'memory_forget'],
      },
      advertised: false,
      allowed: [],
    },
  ];

  it.each(cases)('$name', async ({ access: partial, advertised, allowed }) => {
    expect((await advertisedIds(partial)).includes('memory')).toBe(advertised);
    for (const op of MEMORY_OPS) {
      const verdict = evaluateToolPermission(access(partial), 'memory', { op });
      if (allowed.includes(op)) {
        expect(verdict.decision).toBe('allow');
      } else {
        expect(verdict.decision).not.toBe('allow');
        expect(verdict.reason).toMatch(new RegExp(`op \`${op}\``));
      }
    }
  });

  it('a refused op names the allowed ops in plain words', () => {
    const verdict = evaluateToolPermission(
      access({ mode: 'allow_list', allowList: ['memory_save', 'memory_search'] }),
      'memory',
      { op: 'delete' }
    );
    expect(verdict.decision).toBe('ask');
    expect(verdict.reason).toBe(
      'Not covered by an allow rule: op `delete` of `memory` is not enabled for you. Allowed ops: create, search.'
    );
  });
});
