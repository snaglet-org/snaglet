/**
 * A rule entry naming a tool by its display name (`Shell` for shell) must read
 * the same in tool visibility, the per-call permission engine and the
 * headless gate (/api/tools/execute, the action gateway): narrow allow, broad
 * deny. An allow names the tool only by its exact display name; a deny names
 * it by its id or display name in any case (ruleNamesTool).
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
import {
  evaluateHeadlessToolCall,
  isToolVisible,
} from '@server/services/ToolService/lib/toolVisibility';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';

function tool(id: string, name: string, extra: Partial<ToolRow> = {}): ToolRow {
  return {
    id,
    name,
    description: id,
    type: 'builtin',
    parametersSchema: {},
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier: 'standard',
    categoryPath: 'test',
    providerId: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
    ...extra,
  } as ToolRow;
}

const SHELL = tool('shell', 'Shell', {
  aliases: ['terminal', 'bash'],
  parametersSchema: { type: 'object', properties: { op: { type: 'string', enum: ['run'] } } },
});
const NOTE = tool('note_tool', 'Note');
const ROWS = [SHELL, NOTE];
const ACTIVE = new Set(ROWS.map((row) => row.id));

const access = (partial: Partial<ToolAccessConfig>): ToolAccessConfig => ({
  mode: 'all',
  allowList: [],
  denyList: [],
  ...partial,
});

async function visibleIds(a: ToolAccessConfig): Promise<string[]> {
  findAgentByIdMock.mockResolvedValue({
    id: 'test-agent-a',
    toolAccessMode: a.mode,
    toolAccessAllowList: a.allowList,
    toolAccessDenyList: a.denyList,
    toolOverrides: null,
    mcpServers: null,
  });
  return (await resolveAgentTools('test-agent-a')).map(({ tool: row }) => row.id);
}

const runLs = { op: 'run', cmd: 'ls' };
const engine = (a: ToolAccessConfig) =>
  evaluateToolPermission(a, 'shell', runLs, {
    toolAliases: SHELL.aliases,
    toolName: SHELL.name,
    activeToolIds: ACTIVE,
  }).decision;
const headless = (a: ToolAccessConfig, row: ToolRow = SHELL, input = runLs) =>
  evaluateHeadlessToolCall(a, row, input, { activeToolIds: ACTIVE }).decision;

beforeEach(() => {
  jest.clearAllMocks();
  listResolvableMock.mockResolvedValue(ROWS);
});

describe('allow side: only the exact display name grants', () => {
  it('allow Shell shows shell and allows the guarded call on every path', async () => {
    const a = access({ mode: 'allow_list', allowList: ['Shell'] });
    expect(await visibleIds(a)).toContain('shell');
    expect(engine(a)).toBe('allow');
    expect(headless(a)).toBe('allow');
  });

  it('allow SHELL grants nothing on any path', async () => {
    const a = access({ mode: 'allow_list', allowList: ['SHELL'] });
    expect(await visibleIds(a)).not.toContain('shell');
    expect(engine(a)).toBe('ask');
    expect(headless(a)).toBe('deny');
  });

  it('a specifier allow under the display name applies to the tool', () => {
    const a = access({ mode: 'allow_list', allowList: ['Shell(git:*)'] });
    expect(isToolVisible(SHELL, a, ACTIVE)).toBe(true);
    const judge = (cmd: string) =>
      evaluateToolPermission(
        a,
        'shell',
        { op: 'run', cmd },
        { toolName: 'Shell', toolAliases: SHELL.aliases }
      ).decision;
    expect(judge('git status')).toBe('allow');
    expect(judge('rm -rf /tmp/a')).toBe('ask');
  });

  it('an unguarded tool listed by its display name runs headless; another case does not', () => {
    expect(headless(access({ mode: 'allow_list', allowList: ['Note'] }), NOTE, {})).toBe('allow');
    expect(headless(access({ mode: 'allow_list', allowList: ['note'] }), NOTE, {})).toBe('deny');
  });
});

describe('deny side: the id or display name in any case denies', () => {
  it.each(['Shell', 'SHELL', 'shell', 'sHeLl'])(
    'deny %s hides shell and every path denies it',
    async (entry) => {
      const a = access({ mode: 'deny_list', denyList: [entry] });
      expect(await visibleIds(a)).not.toContain('shell');
      expect(await visibleIds(a)).toContain('note_tool');
      expect(engine(a)).toBe('deny');
      expect(headless(a)).toBe('deny');
    }
  );

  it('a specifier deny under the display name blocks only matching commands', async () => {
    const a = access({ mode: 'deny_list', denyList: ['SHELL(rm:*)'] });
    expect(await visibleIds(a)).toContain('shell');
    const judge = (cmd: string) =>
      evaluateToolPermission(
        a,
        'shell',
        { op: 'run', cmd },
        { toolName: 'Shell', toolAliases: SHELL.aliases }
      ).decision;
    expect(judge('rm -rf /tmp/a')).toBe('deny');
    expect(judge('ls')).toBe('allow');
  });

  it('a deny by display name holds in allow-list mode too', () => {
    const a = access({ mode: 'allow_list', allowList: ['shell'], denyList: ['Shell'] });
    expect(engine(a)).toBe('deny');
    expect(headless(a)).toBe('deny');
  });
});
