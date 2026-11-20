/**
 * A tool's own definition names (`aliases` on its definition, e.g. shell's
 * bash/terminal) and old ids that pin a non-op param (git_status) must read the
 * same in tool visibility as in the per-call permission check: narrow allow,
 * broad deny. A plain definition name denies the tool it names and never
 * grants it; an old id among the definition names keeps its pins. Real alias
 * table.
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

import { resolveAgentTools, selectAdvertisedAgentTools } from '@server/services/AgentToolResolver';
import { evaluateToolPermission } from '@server/services/ToolService/lib/toolPermission';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';

function tool(id: string, aliases: string[] = [], ops?: string[]): ToolRow {
  return {
    id,
    name: id,
    description: id,
    type: 'builtin',
    parametersSchema: ops
      ? { type: 'object', properties: { op: { type: 'string', enum: ops } } }
      : {},
    keywords: [],
    aliases,
    source: null,
    configJson: {},
    enabled: true,
    tier: 'standard',
    categoryPath: 'test',
    providerId: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  } as ToolRow;
}

const SHELL = tool('shell', ['terminal', 'bash'], ['run', 'write']);
const TABLE = tool(
  'table',
  ['table_read', 'table_write', 'table_schema', 'table_delete'],
  ['read', 'write', 'schema', 'delete']
);
const GIT = tool('git');
const ROWS = [SHELL, TABLE, GIT];

const access = (partial: Partial<ToolAccessConfig>): ToolAccessConfig => ({
  mode: 'all',
  allowList: [],
  denyList: [],
  ...partial,
});

async function visibleIds(partial: Partial<ToolAccessConfig>): Promise<string[]> {
  findAgentByIdMock.mockResolvedValue({
    id: 'test-agent-a',
    toolAccessMode: partial.mode ?? 'all',
    toolAccessAllowList: partial.allowList ?? [],
    toolAccessDenyList: partial.denyList ?? [],
    toolOverrides: null,
    mcpServers: null,
  });
  return (await resolveAgentTools('test-agent-a')).map(({ tool: row }) => row.id);
}

beforeEach(() => {
  jest.clearAllMocks();
  listResolvableMock.mockResolvedValue(ROWS);
});

describe('plain definition names: deny everywhere, never allow', () => {
  it('deny bash hides shell, and every permission path denies it', async () => {
    expect(await visibleIds({ mode: 'deny_list', denyList: ['bash'] })).not.toContain('shell');
    const verdict = evaluateToolPermission(
      access({ mode: 'deny_list', denyList: ['bash'] }),
      'shell',
      { op: 'run', cmd: 'ls' },
      { toolAliases: SHELL.aliases }
    );
    expect(verdict.decision).toBe('deny');
  });

  it('a specifier deny under a plain name applies to the tool', () => {
    const a = access({ mode: 'deny_list', denyList: ['terminal(rm:*)'] });
    const judge = (cmd: string) =>
      evaluateToolPermission(a, 'shell', { op: 'run', cmd }, { toolAliases: SHELL.aliases })
        .decision;
    expect(judge('rm -rf /tmp/a')).toBe('deny');
    expect(judge('ls')).toBe('allow');
  });

  it('allow bash neither shows shell nor allows a call', async () => {
    const a = access({ mode: 'allow_list', allowList: ['bash'] });
    expect(await visibleIds(a)).not.toContain('shell');
    expect(
      evaluateToolPermission(a, 'shell', { op: 'run', cmd: 'ls' }, { toolAliases: SHELL.aliases })
        .decision
    ).toBe('ask');
  });

  it('allow bash pins nothing into the advertisement (pinning needs access first)', () => {
    const allowedTools = [GIT].map((row) => ({
      agentId: 'test-agent-a',
      tool: row,
      settings: {},
      requiresConfirmation: false,
    }));
    const executionTools = ROWS.map((row) => ({
      agentId: 'test-agent-a',
      tool: row,
      settings: {},
      requiresConfirmation: false,
    }));
    const advertised = selectAdvertisedAgentTools({
      allowedTools,
      executionTools,
      access: access({ mode: 'allow_list', allowList: ['bash', 'git'] }),
      advertiseAllowedOnly: true,
    }).map(({ tool: row }) => row.id);
    expect(advertised).toContain('git');
    expect(advertised).not.toContain('shell');
  });
});

describe('old ids among the definition names keep their pins', () => {
  it('allow table_read shows table, allows read, asks for delete', async () => {
    const a = access({ mode: 'allow_list', allowList: ['table_read'] });
    expect(await visibleIds(a)).toContain('table');
    const judge = (op: string) =>
      evaluateToolPermission(a, 'table', { op }, { toolAliases: TABLE.aliases }).decision;
    expect(judge('read')).toBe('allow');
    expect(judge('delete')).toBe('ask');
  });

  it('deny table_delete keeps table visible and denies only delete', async () => {
    const a = access({ mode: 'deny_list', denyList: ['table_delete'] });
    expect(await visibleIds(a)).toContain('table');
    const judge = (op: string) =>
      evaluateToolPermission(a, 'table', { op }, { toolAliases: TABLE.aliases }).decision;
    expect(judge('delete')).toBe('deny');
    expect(judge('read')).toBe('allow');
  });
});

describe('non-op pins in visibility', () => {
  it('allow git_status shows git (some calls are allowed)', async () => {
    expect(await visibleIds({ mode: 'allow_list', allowList: ['git_status'] })).toContain('git');
  });

  it('deny git_push hides the whole git tool', async () => {
    expect(await visibleIds({ mode: 'deny_list', denyList: ['git_push'] })).not.toContain('git');
  });
});
