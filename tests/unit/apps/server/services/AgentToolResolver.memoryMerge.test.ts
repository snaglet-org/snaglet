/**
 * The real memory merge, end to end: no alias mock. Stored access lists that
 * name the memory_* alias ids must mean exactly one op of `memory`, using
 * the shipped opAliases and the shipped `memory` definition's op enum.
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
import memoryDefinition from '@server/services/ToolService/tools/memory/memory/definition';
import { resolveToolId } from '@snaglet/shared/utils/toolAliases';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const OPS = (memoryDefinition.parameters_schema.properties as Record<string, { enum?: string[] }>)
  .op.enum as string[];

function memoryRow(): ToolRow {
  return {
    id: 'memory',
    name: memoryDefinition.name,
    description: memoryDefinition.description,
    type: 'builtin',
    parametersSchema: memoryDefinition.parameters_schema,
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier: 'core',
    categoryPath: 'memory',
    providerId: null,
    sortOrder: 30,
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
  return resolved.some(({ tool }) => tool.id === 'memory');
}

function allowedOps(partial: Partial<ToolAccessConfig>, callAs = 'memory'): string[] {
  return OPS.filter(
    (op) => evaluateToolPermission(access(partial), callAs, { op }).decision === 'allow'
  );
}

describe('memory merge with the shipped aliases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listResolvableMock.mockResolvedValue([memoryRow()]);
  });

  it('pins every retired id to exactly one op of memory', () => {
    const expected: Record<string, string> = {
      memory_search: 'search',
      memory_recall: 'search',
      memory_save: 'create',
      memory_store: 'create',
      memory_edit: 'update',
      memory_forget: 'delete',
    };
    for (const [oldId, op] of Object.entries(expected)) {
      const resolved = resolveToolId(oldId);
      expect(resolved.id).toBe('memory');
      expect(resolved.op).toBe(op);
      expect(OPS).toContain(op);
    }
  });

  it('an allow list naming only memory_save gets exactly memory(create)', async () => {
    const partial = { mode: 'allow_list' as const, allowList: ['memory_save'] };
    expect(await advertised(partial)).toBe(true);
    expect(allowedOps(partial)).toEqual(['create']);
    // Calling through the alias id cannot be redirected to another op.
    expect(evaluateToolPermission(access(partial), 'memory_save', { op: 'delete' }).decision).toBe(
      'allow'
    );
    expect(resolveToolId('memory_save').transformParams?.({ op: 'delete' })).toMatchObject({
      op: 'create',
    });
  });

  it('denying only memory_forget keeps memory advertised without delete', async () => {
    const partial = { mode: 'deny_list' as const, denyList: ['memory_forget'] };
    expect(await advertised(partial)).toBe(true);
    expect(allowedOps(partial)).toEqual(['search', 'create', 'update']);
  });

  it('denying all four retired ids hides memory', async () => {
    const partial = {
      mode: 'deny_list' as const,
      denyList: ['memory_save', 'memory_search', 'memory_edit', 'memory_forget'],
    };
    expect(await advertised(partial)).toBe(false);
  });

  it('an old caller passing the ignored `key` to memory_forget still resolves to delete', () => {
    const params = resolveToolId('memory_forget').transformParams?.({ key: 'x', query: 'y' });
    expect(params).toMatchObject({ op: 'delete', query: 'y' });
  });
});
