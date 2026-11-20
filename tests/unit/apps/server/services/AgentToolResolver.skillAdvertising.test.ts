/**
 * `skill` is advertised per agent, never per thread.
 *
 *  - an agent with no skill assigned anywhere: `skill` is in none of the
 *    allowed / execution / advertised sets (all-access and allow-list)
 *  - an agent with a skill anywhere: `skill` advertised like any core tool
 *  - a valid built-in skill exists: every agent gets `skill`, assigned or not
 *  - the lookup is keyed on the agent id only, and a lookup failure hides it
 */

// The Discussions feature flag is read by resolveAdvertisedAgentToolSets; mock
// it so these skill-focused cases do not touch the DB. Default ON here so the
// flag never removes a tool these assertions care about.
const isEnabledMock = jest.fn().mockResolvedValue(true);
jest.mock('@snaglet/db/tables/feature_flags', () => ({
  FeatureFlags: { isEnabled: (...args: unknown[]) => isEnabledMock(...args) },
}));

const agentHasAnyMock = jest.fn();
jest.mock('@snaglet/db/tables/skill_assignments', () => ({
  SkillAssignments: { agentHasAny: (...args: unknown[]) => agentHasAnyMock(...args) },
}));

const listBuiltinValidMock = jest.fn();
jest.mock('@snaglet/db/tables/skill_registry', () => ({
  SkillRegistry: { listBuiltinValid: (...args: unknown[]) => listBuiltinValidMock(...args) },
}));

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

import {
  resolveAdvertisedAgentToolSets,
  type ResolvedAgentTool,
} from '@server/services/AgentToolResolver';
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
    categoryPath: 'system',
    providerId: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  } as ToolRow;
}

const ids = (tools: ResolvedAgentTool[]) => tools.map((t) => t.tool.id);
const ALL = { mode: 'all' as const, allowList: [], denyList: [] };
const ALLOW = { mode: 'allow_list' as const, allowList: ['skill', 'search'], denyList: [] };

beforeEach(() => {
  jest.clearAllMocks();
  isEnabledMock.mockResolvedValue(true);
  listBuiltinValidMock.mockResolvedValue([]);
  listResolvableMock.mockResolvedValue([
    tool('search_tools'),
    tool('search'),
    tool('memory'),
    tool('skill'),
  ]);
  findAgentByIdMock.mockResolvedValue({
    id: 'agent-1',
    toolAccessMode: 'all',
    toolAccessAllowList: [],
    toolAccessDenyList: [],
    toolAccessAdvertiseAllowedOnly: false,
    toolOverrides: null,
    mcpServers: null,
  });
});

describe('resolveAdvertisedAgentToolSets: per-agent `skill` advertising', () => {
  it.each([
    ['all-access', ALL],
    ['allow-list', ALLOW],
  ])('no skills anywhere (%s): `skill` is in no set', async (_label, access) => {
    agentHasAnyMock.mockResolvedValue(false);
    const sets = await resolveAdvertisedAgentToolSets('agent-1', { access });
    expect(ids(sets.allowedTools)).not.toContain('skill');
    expect(ids(sets.executionTools)).not.toContain('skill');
    expect(ids(sets.advertisedTools)).not.toContain('skill');
    expect(ids(sets.advertisedTools)).toContain('search');
  });

  it.each([
    ['all-access', ALL],
    ['allow-list', ALLOW],
  ])('a skill assigned anywhere (%s): `skill` advertised', async (_label, access) => {
    agentHasAnyMock.mockResolvedValue(true);
    const sets = await resolveAdvertisedAgentToolSets('agent-1', { access });
    expect(ids(sets.advertisedTools)).toContain('skill');
    expect(ids(sets.executionTools)).toContain('skill');
  });

  it.each([
    ['all-access', ALL],
    ['allow-list', ALLOW],
  ])('nothing assigned but a built-in exists (%s): `skill` advertised', async (_label, access) => {
    agentHasAnyMock.mockResolvedValue(false);
    listBuiltinValidMock.mockResolvedValue([{ id: 'skill-b', slug: 'snaglet-sdk' }]);
    const sets = await resolveAdvertisedAgentToolSets('agent-1', { access });
    expect(ids(sets.advertisedTools)).toContain('skill');
    expect(ids(sets.executionTools)).toContain('skill');
  });

  it('a skill is assigned: the built-in lookup is skipped', async () => {
    agentHasAnyMock.mockResolvedValue(true);
    await resolveAdvertisedAgentToolSets('agent-1', { access: ALL });
    expect(listBuiltinValidMock).not.toHaveBeenCalled();
  });

  it('keyed on the agent id alone, whatever thread overrides are passed', async () => {
    agentHasAnyMock.mockResolvedValue(true);
    const a = await resolveAdvertisedAgentToolSets('agent-1', { access: ALL });
    const b = await resolveAdvertisedAgentToolSets('agent-1', {
      access: ALL,
      threadOverrides: { memory: { enabled: true } } as never,
    });
    expect(agentHasAnyMock.mock.calls).toEqual([['agent-1'], ['agent-1']]);
    expect(ids(b.advertisedTools)).toEqual(ids(a.advertisedTools));
  });

  it.each([
    ['assignment', () => agentHasAnyMock.mockRejectedValue(new Error('db down'))],
    [
      'built-in',
      () => {
        agentHasAnyMock.mockResolvedValue(false);
        listBuiltinValidMock.mockRejectedValue(new Error('db down'));
      },
    ],
  ])('a failed %s lookup hides `skill` rather than failing the turn', async (_label, fail) => {
    fail();
    const sets = await resolveAdvertisedAgentToolSets('agent-1', { access: ALL });
    expect(ids(sets.advertisedTools)).not.toContain('skill');
    expect(ids(sets.advertisedTools)).toContain('search');
  });

  it('a tool-less model gets nothing and never queries assignments', async () => {
    const sets = await resolveAdvertisedAgentToolSets('agent-1', {
      access: ALL,
      modelSupportsTools: false,
    });
    expect(sets.advertisedTools).toEqual([]);
    expect(agentHasAnyMock).not.toHaveBeenCalled();
  });
});
