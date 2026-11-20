/**
 * The real shell merge, end to end: no alias mock. exec_command / shell_exec /
 * write_stdin → shell(op: run|write). Old access entries keep their meaning,
 * including inside the command guard engine (shell is a guarded tool).
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
import shellDefinition from '@server/services/ToolService/tools/shell/shell/definition';
import { resolveToolId, transformToolAliasParams } from '@snaglet/shared/utils/toolAliases';
import type { ToolRow } from '@snaglet/db/tables/tools';
import type { ToolAccessConfig } from '@snaglet/shared/types';

const OPS = (shellDefinition.parameters_schema.properties as Record<string, { enum?: string[] }>).op
  .enum as string[];

function shellRow(): ToolRow {
  return {
    id: 'shell',
    name: shellDefinition.name,
    description: shellDefinition.description,
    type: 'builtin',
    parametersSchema: shellDefinition.parameters_schema,
    keywords: [],
    aliases: [],
    source: null,
    configJson: {},
    enabled: true,
    tier: 'core',
    categoryPath: 'shell',
    providerId: null,
    sortOrder: 20,
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
  return resolved.some(({ tool }) => tool.id === 'shell');
}

const decide = (partial: Partial<ToolAccessConfig>, name: string, input: Record<string, unknown>) =>
  evaluateToolPermission(access(partial), name, input).decision;

describe('shell merge with the shipped aliases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    listResolvableMock.mockResolvedValue([shellRow()]);
  });

  it('ships ops run and write', () => {
    expect(OPS).toEqual(['run', 'write']);
  });

  it('pins every retired id to exactly one op of shell', () => {
    expect(resolveToolId('exec_command')).toMatchObject({ id: 'shell', op: 'run' });
    expect(resolveToolId('shell_exec')).toMatchObject({ id: 'shell', op: 'run' });
    expect(resolveToolId('write_stdin')).toMatchObject({ id: 'shell', op: 'write' });
  });

  it('shell_exec callers keep their params and are marked for the legacy output contract', () => {
    const r = resolveToolId('shell_exec');
    expect(transformToolAliasParams(r, { command: 'ls', cwd: '/tmp', timeout_ms: 60000 })).toEqual({
      command: 'ls',
      cwd: '/tmp',
      cmd: 'ls',
      workdir: '/tmp',
      timeout_ms: 60000,
      legacy_output: 'shell_exec',
      op: 'run',
    });
    // exec_command callers keep the session envelope.
    expect(
      transformToolAliasParams(resolveToolId('exec_command'), { cmd: 'ls' })
    ).not.toHaveProperty('legacy_output');
    // An old id cannot be redirected to another op.
    expect(transformToolAliasParams(r, { command: 'ls', op: 'write' })).toMatchObject({
      op: 'run',
    });
  });

  it('allow: only exec_command → shell(run) only, under the usual command guard', async () => {
    const partial = { mode: 'allow_list' as const, allowList: ['exec_command'] };
    expect(await advertised(partial)).toBe(true);
    expect(decide(partial, 'shell', { op: 'run', cmd: 'ls' })).toBe('allow');
    expect(decide(partial, 'shell', { op: 'write', session_id: 1 })).toBe('ask');
  });

  it('allow: only write_stdin never approves a command (guard-engine op scoping)', async () => {
    const partial = {
      mode: 'allow_list' as const,
      allowList: ['write_stdin', 'shell_exec(git:*)'],
    };
    expect(decide(partial, 'shell', { op: 'write', session_id: 1, chars: 'y\n' })).toBe('allow');
    expect(decide(partial, 'shell', { op: 'run', cmd: 'git status' })).toBe('allow');
    expect(decide(partial, 'shell', { op: 'run', cmd: 'rm -rf /tmp/x' })).toBe('ask');
  });

  it('deny: only write_stdin keeps run working and blocks write', async () => {
    const partial = { mode: 'deny_list' as const, denyList: ['write_stdin'] };
    expect(await advertised(partial)).toBe(true);
    expect(decide(partial, 'shell', { op: 'run', cmd: 'ls' })).toBe('allow');
    expect(decide(partial, 'shell', { op: 'write', session_id: 1 })).toBe('deny');
  });

  it('a scoped deny on an old id still applies to the merged tool', () => {
    const partial = { mode: 'deny_list' as const, denyList: ['shell_exec(rm:*)'] };
    expect(decide(partial, 'shell', { op: 'run', cmd: 'rm -rf /tmp/x' })).toBe('deny');
    expect(decide(partial, 'exec_command', { cmd: 'rm -rf /tmp/x' })).toBe('deny');
    expect(decide(partial, 'shell', { op: 'run', cmd: 'ls' })).toBe('allow');
  });

  it('denying all three retired ids hides shell', async () => {
    expect(
      await advertised({
        mode: 'deny_list',
        denyList: ['exec_command', 'shell_exec', 'write_stdin'],
      })
    ).toBe(false);
  });

  it('a bare new-tool allow covers both ops', () => {
    const partial = { mode: 'allow_list' as const, allowList: ['shell'] };
    expect(decide(partial, 'shell', { op: 'run', cmd: 'rm -rf /tmp/x' })).toBe('allow');
    expect(decide(partial, 'shell', { op: 'write', session_id: 1 })).toBe('allow');
  });
});
