/**
 * Strict advertisement rider gating (design decision on
 * tool_access_advertise_allowed_only): the tool/action
 * discovery riders ride along with a strict advertisement even when not in
 * the allow list — unless access-gated for the agent. Today neither rider is
 * in ACCESS_GATED_CORE_TOOL_IDS, so this suite widens the gated set (module
 * mock) to pin the behavior for any future in which one becomes gated: an
 * ungated rider still rides, a gated rider stays out, and an explicit
 * allow-list grant re-admits it through the normal intersection.
 */

jest.mock('@snaglet/shared/constants', () => {
  const actual = jest.requireActual('@snaglet/shared/constants');
  return {
    ...actual,
    ACCESS_GATED_CORE_TOOL_IDS: new Set([...actual.ACCESS_GATED_CORE_TOOL_IDS, 'action']),
  };
});

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { listResolvable: jest.fn() },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: jest.fn() },
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
  selectAdvertisedAgentTools,
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

function resolved(row: ToolRow): ResolvedAgentTool {
  return { agentId: 'agent-1', tool: row, settings: {}, requiresConfirmation: false };
}

describe('strict advertisement excludes an access-gated rider', () => {
  const toolTool = resolved(tool('tool'));
  const actionTool = resolved(tool('action'));
  const fileRead = resolved(tool('file_read'));
  const executionTools = [toolTool, actionTool, fileRead];

  it('a gated rider does not ride along; the ungated rider still does', () => {
    const advertised = selectAdvertisedAgentTools({
      allowedTools: [toolTool, fileRead],
      executionTools,
      access: { mode: 'allow_list', allowList: ['file_read'], denyList: [] },
      advertiseAllowedOnly: true,
    });

    expect(advertised.map((entry) => entry.tool.id)).toEqual(['tool', 'file_read']);
  });

  it('an explicit allow-list grant re-admits the gated rider via the normal intersection', () => {
    const advertised = selectAdvertisedAgentTools({
      allowedTools: [toolTool, actionTool, fileRead],
      executionTools,
      access: {
        mode: 'allow_list',
        allowList: ['file_read', 'action'],
        denyList: [],
      },
      advertiseAllowedOnly: true,
    });

    expect(advertised.map((entry) => entry.tool.id)).toEqual(['action', 'tool', 'file_read']);
  });
});
