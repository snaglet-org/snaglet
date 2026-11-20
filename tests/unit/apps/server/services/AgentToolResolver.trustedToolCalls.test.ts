/**
 * AgentToolResolver × trusted tool calls (agents.trusted_tool_calls).
 *
 * Trust is an agent-scoped confirmation bypass resolved here for native and
 * MCP tools alike, so dispatch only reads `requiresConfirmation`:
 *   thread override > agent trust > agent per-tool override > tool/server default.
 * It never widens access: server enablement and allow/deny filtering are
 * unchanged, which the last cases pin.
 */

const listResolvableMock = jest.fn();
const findAgentByIdMock = jest.fn();
const getToolDefsForServersMock = jest.fn();
const getConfirmationPolicyMock = jest.fn();

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
    getToolDefsForServers: (...args: unknown[]) => getToolDefsForServersMock(...args),
    getConfirmationPolicy: (...args: unknown[]) => getConfirmationPolicyMock(...args),
  },
}));

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn().mockResolvedValue(undefined),
    getAllDefinitions: jest.fn().mockReturnValue({}),
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
    tier: 'standard',
    categoryPath: 'system',
    providerId: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  } as ToolRow;
}

const GITHUB_ISSUES = {
  serverId: 'github',
  namespacedId: 'mcp__github__list_issues',
  rawToolName: 'list_issues',
  name: 'List issues',
  description: 'List issues',
  inputSchema: {},
};

function agentRow(over: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    toolAccessMode: null,
    toolAccessAllowList: null,
    toolAccessDenyList: null,
    toolOverrides: { shell_exec: { requiresConfirmation: true, settings: { cwd: '/w' } } },
    trustedToolCalls: false,
    mcpServers: ['github'],
    ...over,
  };
}

const byId = (resolved: Awaited<ReturnType<typeof resolveAgentTools>>) =>
  new Map(resolved.map((entry) => [entry.tool.id, entry]));

beforeEach(() => {
  jest.clearAllMocks();
  listResolvableMock.mockResolvedValue([tool('shell_exec'), tool('file_read')]);
  getToolDefsForServersMock.mockReturnValue([GITHUB_ISSUES]);
  getConfirmationPolicyMock.mockReturnValue(true); // the MCP server asks by default
});

describe('non-trusted agents (unchanged behavior)', () => {
  it('inherit the MCP server confirmation policy and their own per-tool flags', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow());

    const resolved = byId(await resolveAgentTools('agent-1'));

    expect(resolved.get('mcp__github__list_issues')?.requiresConfirmation).toBe(true);
    expect(resolved.get('shell_exec')?.requiresConfirmation).toBe(true);
    expect(resolved.get('file_read')?.requiresConfirmation).toBe(false);
  });
});

describe('trusted agents', () => {
  it('run permitted MCP tools without confirmation even when the server requires it', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({ trustedToolCalls: true }));

    const resolved = byId(await resolveAgentTools('agent-1'));

    expect(getConfirmationPolicyMock).toHaveBeenCalledWith('github');
    expect(resolved.get('mcp__github__list_issues')?.requiresConfirmation).toBe(false);
  });

  it('bypass agent-level per-tool confirmation for native tools while keeping settings', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({ trustedToolCalls: true }));

    const resolved = byId(await resolveAgentTools('agent-1'));

    expect(resolved.get('shell_exec')?.requiresConfirmation).toBe(false);
    expect(resolved.get('shell_exec')?.settings).toEqual({ cwd: '/w' });
  });

  it('still prompt when a thread override explicitly re-enables confirmation', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({ trustedToolCalls: true }));

    const resolved = byId(
      await resolveAgentTools('agent-1', {
        threadOverrides: {
          mcp__github__list_issues: { requiresConfirmation: true },
          shell_exec: { requiresConfirmation: true },
        },
      })
    );

    expect(resolved.get('mcp__github__list_issues')?.requiresConfirmation).toBe(true);
    expect(resolved.get('shell_exec')?.requiresConfirmation).toBe(true);
  });

  it('let a thread override explicitly disable confirmation for a non-trusted agent too', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({ trustedToolCalls: false }));

    const resolved = byId(
      await resolveAgentTools('agent-1', {
        threadOverrides: { mcp__github__list_issues: { requiresConfirmation: false } },
      })
    );

    expect(resolved.get('mcp__github__list_issues')?.requiresConfirmation).toBe(false);
  });

  it('do not gain access: a disabled MCP server stays unavailable', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({ trustedToolCalls: true, mcpServers: [] }));

    const resolved = byId(await resolveAgentTools('agent-1'));

    expect(resolved.has('mcp__github__list_issues')).toBe(false);
    expect(getToolDefsForServersMock).not.toHaveBeenCalled();
  });

  it('do not gain access: a bare deny still removes the native tool', async () => {
    findAgentByIdMock.mockResolvedValue(
      agentRow({
        trustedToolCalls: true,
        toolAccessMode: 'deny_list',
        toolAccessDenyList: ['shell_exec'],
      })
    );

    const resolved = byId(await resolveAgentTools('agent-1'));

    expect(resolved.has('shell_exec')).toBe(false);
    expect(resolved.has('file_read')).toBe(true);
  });

  it('treat a legacy row without the column as not trusted', async () => {
    const legacy = agentRow();
    delete (legacy as Record<string, unknown>).trustedToolCalls;
    findAgentByIdMock.mockResolvedValue(legacy);

    const resolved = byId(await resolveAgentTools('agent-1'));

    expect(resolved.get('mcp__github__list_issues')?.requiresConfirmation).toBe(true);
  });
});
