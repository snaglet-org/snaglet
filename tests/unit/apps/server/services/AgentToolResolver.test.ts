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
  resolveAgentTools,
  selectAdvertisedAgentTools,
  type ResolvedAgentTool,
} from '@server/services/AgentToolResolver';
import type { ToolRow } from '@snaglet/db/tables/tools';
import { CORE_TOOL_IDS } from '@snaglet/shared/constants';

function tool(
  id: string,
  overrides: Partial<Pick<ToolRow, 'type' | 'tier' | 'aliases'>> = {}
): ToolRow {
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
    ...overrides,
  } as ToolRow;
}

function resolved(row: ToolRow): ResolvedAgentTool {
  return {
    agentId: 'agent-1',
    tool: row,
    settings: {},
    requiresConfirmation: false,
  };
}

describe('AgentToolResolver always-available tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findAgentByIdMock.mockResolvedValue({
      id: 'agent-1',
      toolAccessMode: 'allow_list',
      toolAccessAllowList: [],
      toolAccessDenyList: ['tool', 'get_current_datetime'],
      toolOverrides: null,
      mcpServers: null,
    });
    listResolvableMock.mockResolvedValue([
      tool('tool'),
      tool('get_current_datetime'),
      tool('file_read'),
    ]);
  });

  it('advertises search and the clock even when an empty allow-list also denies them', async () => {
    const resolved = await resolveAgentTools('agent-1');

    expect(resolved.map((entry) => entry.tool.id)).toEqual(['tool', 'get_current_datetime']);
  });
});

describe('selectAdvertisedAgentTools', () => {
  it('keeps the ratified stable core in one shared constant (memory, shell, file, node, doc, container and table merged; subagent added; pane on demand; web_search core; owner selection adds hook, automation, agent, model, mcp, custom_tool, calendar and orient)', () => {
    expect(CORE_TOOL_IDS.size).toBe(27);
    expect(CORE_TOOL_IDS.has('web_search')).toBe(true);
    for (const id of [
      'hook',
      'automation',
      'agent',
      'model',
      'mcp',
      'custom_tool',
      'calendar',
      'orient',
    ]) {
      expect(CORE_TOOL_IDS.has(id)).toBe(true);
    }
    expect(CORE_TOOL_IDS.has('pane')).toBe(false);
  });

  it('uses the shared core set instead of mutable definition tiers', () => {
    const coreWithStandardTier = resolved(tool('search', { tier: 'standard' }));
    const nonCoreWithCoreTier = resolved(tool('google_gmail', { tier: 'core' }));

    expect(
      selectAdvertisedAgentTools({
        allowedTools: [coreWithStandardTier, nonCoreWithCoreTier],
        executionTools: [coreWithStandardTier, nonCoreWithCoreTier],
        access: { mode: 'all', allowList: [], denyList: [] },
      }).map((entry) => entry.tool.id)
    ).toEqual(['search']);
  });

  it('pins explicit builtin and MCP allow-list entries but hides other MCP tools', () => {
    const search = resolved(tool('search'));
    const gmail = resolved(tool('google_gmail', { tier: 'standard' }));
    const allowedMcp = resolved(
      tool('mcp__calendar__create', { type: 'mcp', tier: 'standard', aliases: ['calendar_create'] })
    );
    const hiddenMcp = resolved(tool('mcp__calendar__delete', { type: 'mcp', tier: 'standard' }));
    const all = [search, gmail, allowedMcp, hiddenMcp];

    expect(
      selectAdvertisedAgentTools({
        allowedTools: all,
        executionTools: all,
        access: {
          mode: 'all',
          allowList: ['google_gmail', 'calendar_create'],
          denyList: [],
        },
      }).map((entry) => entry.tool.id)
    ).toEqual(['search', 'google_gmail', 'mcp__calendar__create']);
  });

  it('keeps shell access-gated under allow-list mode; file is plain core', () => {
    // apply_patch is file(op:update) and is not gated on its own, so `file`
    // advertises like any core tool. shell stays gated.
    const search = resolved(tool('search'));
    const file = resolved(tool('file'));
    const shell = resolved(tool('shell'));

    expect(
      selectAdvertisedAgentTools({
        allowedTools: [search],
        executionTools: [search, file, shell],
        access: { mode: 'allow_list', allowList: [], denyList: [] },
      }).map((entry) => entry.tool.id)
    ).toEqual(['search', 'file']);
  });
});
