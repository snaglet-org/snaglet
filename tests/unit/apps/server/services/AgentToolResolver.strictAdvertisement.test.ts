/**
 * Strict allow-list advertisement (agents.tool_access_advertise_allowed_only)
 * — the opt-in small-model catalog trim. Off: the default allow-list
 * advertisement (full non-access-gated core + pinned entries). On in
 * allow_list mode: exactly allowList ∩ reachable plus the action/tool riders,
 * so a schema fetched with tool(op:schema) can still be called. On in
 * deny_list/all mode: inert, and the flag is not even read. The trim is
 * material in tokens.
 */

jest.mock('@snaglet/db/tables/skill_assignments', () => ({
  SkillAssignments: { agentHasAny: async () => false },
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
  selectAdvertisedAgentTools,
  type ResolvedAgentTool,
} from '@server/services/AgentToolResolver';
import { measureAnthropicToolCatalog } from '@server/services/ToolService/ToolFormatService';
import type { ToolRow } from '@snaglet/db/tables/tools';
import { ACCESS_GATED_CORE_TOOL_IDS, CORE_TOOL_IDS } from '@snaglet/shared/constants';

function tool(
  id: string,
  overrides: Partial<Pick<ToolRow, 'type' | 'tier' | 'aliases' | 'parametersSchema'>> = {}
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

function ids(entries: ResolvedAgentTool[]): string[] {
  return entries.map((entry) => entry.tool.id);
}

describe('selectAdvertisedAgentTools strict advertisement', () => {
  // Mirrors what resolveAgentTools produces for allowList
  // ['file_read', 'google_gmail']: listed matches + the always-available pair.
  const action = resolved(tool('action'));
  const search = resolved(tool('search'));
  const searchTools = resolved(tool('tool'));
  const clock = resolved(tool('get_current_datetime'));
  const fileRead = resolved(tool('file_read'));
  const shell = resolved(tool('shell'));
  const gmail = resolved(tool('google_gmail', { tier: 'standard' }));
  const git = resolved(tool('git', { tier: 'standard' }));

  const executionTools = [action, search, searchTools, clock, fileRead, shell, gmail, git];
  const allowedTools = [searchTools, clock, fileRead, gmail];
  const access = {
    mode: 'allow_list' as const,
    allowList: ['file_read', 'google_gmail'],
    denyList: [],
  };

  // Default allow-list advertisement: every non-access-gated core tool plus
  // pinned allowed entries.
  const defaultAdvertisement = [
    'action',
    'search',
    'get_current_datetime',
    'tool',
    'file_read',
    'google_gmail',
  ];

  it('flag off (omitted and explicit false) advertises exactly the historical set', () => {
    expect(ids(selectAdvertisedAgentTools({ allowedTools, executionTools, access }))).toEqual(
      defaultAdvertisement
    );
    expect(
      ids(
        selectAdvertisedAgentTools({
          allowedTools,
          executionTools,
          access,
          advertiseAllowedOnly: false,
        })
      )
    ).toEqual(defaultAdvertisement);
  });

  it('flag on advertises exactly allowList ∩ reachable plus the discovery riders', () => {
    expect(
      ids(
        selectAdvertisedAgentTools({
          allowedTools,
          executionTools,
          access,
          advertiseAllowedOnly: true,
        })
      )
    ).toEqual(['action', 'tool', 'file_read', 'google_gmail']);
  });

  it('is inert outside allow_list mode: all and deny_list advertise identically with the flag on', () => {
    for (const mode of ['all', 'deny_list'] as const) {
      const modeAccess = { mode, allowList: [], denyList: [] };
      const off = ids(
        selectAdvertisedAgentTools({
          allowedTools: executionTools,
          executionTools,
          access: modeAccess,
        })
      );
      const on = ids(
        selectAdvertisedAgentTools({
          allowedTools: executionTools,
          executionTools,
          access: modeAccess,
          advertiseAllowedOnly: true,
        })
      );
      expect(on).toEqual(off);
    }
  });

  it('empty allow list with the flag on advertises just the riders', () => {
    expect(
      ids(
        selectAdvertisedAgentTools({
          // Always-available pair is all resolveAgentTools yields for an
          // empty allow list.
          allowedTools: [searchTools, clock],
          executionTools,
          access: { mode: 'allow_list', allowList: [], denyList: [] },
          advertiseAllowedOnly: true,
        })
      )
    ).toEqual(['action', 'tool']);
  });

  it('advertises an access-gated tool only via an explicit grant, never as loose core', () => {
    const grantAccess = { mode: 'allow_list' as const, allowList: ['shell'], denyList: [] };
    expect(
      ids(
        selectAdvertisedAgentTools({
          allowedTools: [searchTools, clock, shell],
          executionTools,
          access: grantAccess,
          advertiseAllowedOnly: true,
        })
      )
    ).toEqual(['action', 'shell', 'tool']);
  });
});

describe('resolveAdvertisedAgentToolSets strict advertisement (agent row flag)', () => {
  const catalog = [
    tool('tool'),
    tool('get_current_datetime'),
    tool('search'),
    tool('file'),
    tool('shell'),
    tool('google_gmail', { tier: 'standard' }),
  ];

  function agentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'agent-1',
      toolAccessMode: 'allow_list',
      toolAccessAllowList: ['file'],
      toolAccessDenyList: [],
      toolAccessAdvertiseAllowedOnly: false,
      toolOverrides: null,
      mcpServers: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    listResolvableMock.mockResolvedValue(catalog);
  });

  it('flag off: allow-list advertisement is the historical full-core set (default-off parity)', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow());

    const { advertisedTools } = await resolveAdvertisedAgentToolSets('agent-1', {
      access: { mode: 'allow_list', allowList: ['file'], denyList: [] },
    });

    expect(ids(advertisedTools)).toEqual(['search', 'file', 'get_current_datetime', 'tool']);
  });

  it('flag on: advertisement trims to the allow list plus the riders', async () => {
    findAgentByIdMock.mockResolvedValue(agentRow({ toolAccessAdvertiseAllowedOnly: true }));

    const { advertisedTools, allowedTools, executionTools } = await resolveAdvertisedAgentToolSets(
      'agent-1',
      { access: { mode: 'allow_list', allowList: ['file'], denyList: [] } }
    );

    expect(ids(advertisedTools)).toEqual(['file', 'tool']);
    // The trim narrows advertisement only — reachability and the escalation
    // execution set are untouched.
    expect(ids(allowedTools)).toEqual(['tool', 'get_current_datetime', 'file']);
    expect(ids(executionTools)).toEqual(catalog.map((row) => row.id));
  });

  it('flag on outside allow_list mode is inert and the flag is never even read', async () => {
    findAgentByIdMock.mockResolvedValue(
      agentRow({
        toolAccessMode: 'all',
        toolAccessAllowList: [],
        toolAccessAdvertiseAllowedOnly: true,
      })
    );

    const { advertisedTools } = await resolveAdvertisedAgentToolSets('agent-1', {
      access: { mode: 'all', allowList: [], denyList: [] },
    });

    // Full core advertisement, untouched by the flag.
    expect(ids(advertisedTools)).toEqual([
      'search',
      'file',
      'shell',
      'get_current_datetime',
      'tool',
    ]);
    // Exactly one read: resolveAgentTools' own. The strict-flag read is
    // skipped entirely outside allow_list mode (inert means inert).
    expect(findAgentByIdMock).toHaveBeenCalledTimes(1);
  });
});

describe('strict advertisement token footprint', () => {
  it('materially shrinks the serialized catalog for a small allow list', () => {
    // Realistically fat schemas: the live core catalog measured ~13k tokens
    // across 37 advertised tools for a 4B local model.
    const fatSchema = {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [
          `param_${i}`,
          {
            type: 'string',
            description:
              'A realistic parameter description of the kind tool schemas actually carry on the wire.',
          },
        ])
      ),
      required: ['param_0'],
    };
    const coreRows = [...CORE_TOOL_IDS].map((id) =>
      resolved(tool(id, { parametersSchema: fatSchema }))
    );
    // `file`, `doc` and `table` each cover a whole family of ops.
    const allowList = ['file', 'doc', 'node', 'table', 'search'];
    const byId = new Map(coreRows.map((entry) => [entry.tool.id, entry]));
    const allowedTools = [
      ...allowList.map((id) => byId.get(id)!),
      byId.get('tool')!,
      byId.get('get_current_datetime')!,
    ];
    const access = { mode: 'allow_list' as const, allowList, denyList: [] };

    const defaultCatalog = measureAnthropicToolCatalog(
      selectAdvertisedAgentTools({ allowedTools, executionTools: coreRows, access }).map(
        (entry) => entry.tool
      )
    );
    const strictCatalog = measureAnthropicToolCatalog(
      selectAdvertisedAgentTools({
        allowedTools,
        executionTools: coreRows,
        access,
        advertiseAllowedOnly: true,
      }).map((entry) => entry.tool)
    );

    // Default allow-list behavior: every non-access-gated core tool.
    expect(defaultCatalog.toolCount).toBe(CORE_TOOL_IDS.size - ACCESS_GATED_CORE_TOOL_IDS.size);
    // Strict: the 5 listed tools + the 2 discovery riders (action, tool).
    expect(strictCatalog.toolCount).toBe(7);
    expect(strictCatalog.serializedBytes).toBeLessThan(defaultCatalog.serializedBytes * 0.5);
    expect(strictCatalog.estimatedTokens).toBeLessThan(defaultCatalog.estimatedTokens * 0.5);
  });
});
