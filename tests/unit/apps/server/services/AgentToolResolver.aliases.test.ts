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
import type { ToolRow } from '@snaglet/db/tables/tools';

function tool(id: string): ToolRow {
  return {
    id,
    name: id,
    description: id,
    type: 'builtin',
    parametersSchema: {},
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
  };
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    toolAccessMode: 'allow_list',
    toolAccessAllowList: ['workspace_search'],
    toolAccessDenyList: [],
    toolOverrides: null,
    mcpServers: null,
    ...overrides,
  };
}

describe('AgentToolResolver permanent catalog aliases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findAgentByIdMock.mockResolvedValue(agent());
  });

  it('does not widen an exact legacy row to its canonical peer while both are active', async () => {
    listResolvableMock.mockResolvedValue([tool('workspace_search'), tool('search')]);

    const resolved = await resolveAgentTools('agent-1');

    expect(resolved.map(({ tool: row }) => row.id)).toEqual(['workspace_search']);
  });

  it('resolves an orphaned legacy allow-list entry to the canonical row', async () => {
    listResolvableMock.mockResolvedValue([tool('search')]);

    const resolved = await resolveAgentTools('agent-1');

    expect(resolved.map(({ tool: row }) => row.id)).toEqual(['search']);
  });

  it('falls back to a stored legacy override only after the exact row is retired', async () => {
    findAgentByIdMock.mockResolvedValue(
      agent({
        toolOverrides: {
          workspace_search: {
            settings: { scope: 'old-config' },
            requiresConfirmation: true,
          },
        },
      })
    );
    listResolvableMock.mockResolvedValue([tool('search')]);

    const [resolved] = await resolveAgentTools('agent-1');

    expect(resolved).toMatchObject({
      settings: { scope: 'old-config' },
      requiresConfirmation: true,
    });
  });

  it('keeps the legacy override on the legacy row while both rows are active', async () => {
    findAgentByIdMock.mockResolvedValue(
      agent({
        toolAccessMode: 'all',
        toolAccessAllowList: [],
        toolOverrides: {
          workspace_search: { settings: { owner: 'legacy' } },
        },
      })
    );
    listResolvableMock.mockResolvedValue([tool('workspace_search'), tool('search')]);

    const resolved = await resolveAgentTools('agent-1');

    expect(resolved.find(({ tool: row }) => row.id === 'workspace_search')?.settings).toEqual({
      owner: 'legacy',
    });
    expect(resolved.find(({ tool: row }) => row.id === 'search')?.settings).toEqual({});
  });
});
