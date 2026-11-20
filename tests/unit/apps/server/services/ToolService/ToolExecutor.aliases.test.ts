const handlers = new Map<string, jest.Mock>();
const definitions = new Map<string, Record<string, unknown>>();
const resolveAgentToolsMock = jest.fn();
const resolveAgentToolsForExecutionMock = jest.fn();
const findToolByIdMock = jest.fn();
const findAgentByIdMock = jest.fn();

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    size: 0,
    load: jest.fn().mockResolvedValue(undefined),
    getHandler: (id: string) => handlers.get(id),
    hasHandler: (id: string) => handlers.has(id),
    getDefinition: (id: string) => definitions.get(id),
    getToolIds: () => [...handlers.keys()],
  },
}));

jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAgentTools: (...args: unknown[]) => resolveAgentToolsMock(...args),
  resolveAgentToolsForExecution: (...args: unknown[]) => resolveAgentToolsForExecutionMock(...args),
}));

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { findById: (...args: unknown[]) => findToolByIdMock(...args) },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgentByIdMock(...args) },
}));

import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';

function agentTool(id: string): ResolvedAgentTool {
  return {
    agentId: 'agent-1',
    settings: {},
    requiresConfirmation: false,
    tool: {
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
    },
  };
}

describe('ToolExecutor permanent catalog aliases', () => {
  beforeEach(() => {
    handlers.clear();
    definitions.clear();
    jest.clearAllMocks();
    findToolByIdMock.mockResolvedValue(null);
    findAgentByIdMock.mockResolvedValue(null);
  });

  it('gives an exact live legacy handler precedence during a replacement wave', async () => {
    const legacyHandler = jest.fn().mockResolvedValue('legacy');
    const canonicalHandler = jest.fn().mockResolvedValue('canonical');
    handlers.set('workspace_search', legacyHandler);
    handlers.set('search', canonicalHandler);

    const result = await toolExecutor.execute(
      { name: 'workspace_search', input: { query: 'needle', kind: 'caller-value' } },
      agentTool('workspace_search')
    );

    expect(result).toMatchObject({ success: true, output: 'legacy' });
    expect(legacyHandler).toHaveBeenCalledWith(
      { query: 'needle', kind: 'caller-value' },
      {},
      undefined
    );
    expect(canonicalHandler).not.toHaveBeenCalled();
  });

  it('falls back to the canonical handler and pins transformed parameters after removal', async () => {
    const canonicalHandler = jest.fn().mockResolvedValue('canonical');
    handlers.set('search', canonicalHandler);

    const result = await toolExecutor.execute(
      { name: 'workspace_search', input: { query: 'needle', kind: 'files' } },
      agentTool('search')
    );

    expect(result).toMatchObject({ success: true, output: 'canonical' });
    expect(canonicalHandler).toHaveBeenCalledWith(
      { query: 'needle', kind: 'workspace' },
      {},
      undefined
    );
  });

  it('returns the intentional-removal guidance when a tombstoned handler is gone', async () => {
    const result = await toolExecutor.execute(
      { name: 'uuid_generate', input: {} },
      agentTool('uuid_generate')
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/intentionally removed/i);
    expect(result.error).toMatch(/generate an id natively/i);
  });

  it.each([
    {
      label: 'nested params',
      input: { tool: 'workspace_search', params: { query: 'nested' } },
      expected: { query: 'nested', kind: 'workspace' },
    },
    {
      label: 'flat params',
      input: { tool_name: 'workspace_search', query: 'flat' },
      expected: { query: 'flat', kind: 'workspace' },
    },
  ])(
    'dispatches action $label exactly once through alias normalization',
    async ({ input, expected }) => {
      const canonicalHandler = jest.fn().mockResolvedValue('found');
      handlers.set('search', canonicalHandler);
      const target = agentTool('search');
      resolveAgentToolsMock.mockResolvedValue([target]);
      // The gateway judges the target as a real agent; one with no row
      // behind it is refused.
      findAgentByIdMock.mockResolvedValue({ id: 'agent-1', toolAccessMode: 'all' });

      const result = await toolExecutor.execute({ name: 'action', input }, agentTool('action'), {
        agentId: 'agent-1',
      });

      expect(result).toMatchObject({ success: true, output: 'found' });
      expect(resolveAgentToolsMock).toHaveBeenCalledWith('agent-1');
      expect(resolveAgentToolsForExecutionMock).not.toHaveBeenCalled();
      expect(canonicalHandler).toHaveBeenCalledTimes(1);
      expect(canonicalHandler).toHaveBeenCalledWith(expected, {}, { agentId: 'agent-1' });
    }
  );

  it('does not let an action wrapper widen a constrained agent to a hidden target', async () => {
    resolveAgentToolsMock.mockResolvedValue([]);

    const result = await toolExecutor.execute(
      {
        name: 'action',
        input: { tool: 'workspace_search', params: { query: 'hidden' } },
      },
      agentTool('action'),
      { agentId: 'agent-1' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unavailable or not permitted/i);
    // The model still gets its next step: search, where a blocked tool is
    // listed as blocked rather than missing.
    expect(result.error).toContain("tool({op: 'search', query: '<the thing or the verb>'})");
    expect(result.error).toContain('`blocked`');
    expect(resolveAgentToolsForExecutionMock).not.toHaveBeenCalled();
  });

  it('applies target specifier policy so action cannot bypass a guarded deny', async () => {
    const shellHandler = jest.fn().mockResolvedValue('should not run');
    handlers.set('shell_exec', shellHandler);
    resolveAgentToolsMock.mockResolvedValue([agentTool('shell_exec')]);
    findAgentByIdMock.mockResolvedValue({
      id: 'agent-1',
      toolAccessMode: 'deny_list',
      toolAccessAllowList: [],
      toolAccessDenyList: ['shell_exec(rm:*)'],
    });

    const result = await toolExecutor.execute(
      {
        name: 'action',
        input: { tool: 'shell_exec', params: { command: 'rm -rf /tmp/example' } },
      },
      agentTool('action'),
      { agentId: 'agent-1' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked by tool-access policy/i);
    expect(shellHandler).not.toHaveBeenCalled();
  });

  it('transforms a retired target id before action target policy evaluation', async () => {
    const gitHandler = jest.fn().mockResolvedValue('should not run');
    handlers.set('git', gitHandler);
    resolveAgentToolsMock.mockResolvedValue([agentTool('git')]);
    findAgentByIdMock.mockResolvedValue({
      id: 'agent-1',
      toolAccessMode: 'deny_list',
      toolAccessAllowList: [],
      toolAccessDenyList: ['git_push(git push:*)'],
    });

    const result = await toolExecutor.execute(
      {
        name: 'action',
        input: {
          tool: 'git_push',
          params: { remote: 'origin', branch: 'main' },
        },
      },
      agentTool('action'),
      { agentId: 'agent-1' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked by tool-access policy/i);
    expect(gitHandler).not.toHaveBeenCalled();
  });

  it('does not let an action-routed canonical git push bypass a shell git deny', async () => {
    const gitHandler = jest.fn().mockResolvedValue('should not run');
    handlers.set('git', gitHandler);
    resolveAgentToolsMock.mockResolvedValue([agentTool('git')]);
    findAgentByIdMock.mockResolvedValue({
      id: 'agent-1',
      toolAccessMode: 'deny_list',
      toolAccessAllowList: [],
      toolAccessDenyList: ['shell_exec(git:*)'],
    });

    const result = await toolExecutor.execute(
      {
        name: 'action',
        input: {
          tool: 'git',
          params: { subcommand: 'push', remote: 'origin', branch: 'main' },
        },
      },
      agentTool('action'),
      { agentId: 'agent-1' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/blocked by tool-access policy/i);
    expect(gitHandler).not.toHaveBeenCalled();
  });
});

describe('ToolExecutor merged document aliases', () => {
  beforeEach(() => {
    handlers.clear();
    definitions.clear();
    jest.clearAllMocks();
    findToolByIdMock.mockResolvedValue(null);
    findAgentByIdMock.mockResolvedValue(null);
  });
  it.each([
    [
      'duplicate_doc',
      { source_id: 'd', source_path: '/a', op: 'delete' },
      { id: 'd', path: '/a', op: 'duplicate' },
    ],
    ['workspace_diff_doc', { doc_id: 'd', op: 'delete' }, { id: 'd', op: 'diff' }],
    [
      'convert_doc_to_container',
      { doc_id: 'd', op: 'delete' },
      { id: 'd', op: 'convert-to-container' },
    ],
    [
      'doc_history',
      { operation: 'delete', op: 'delete', snapshot_id: 's' },
      { op: 'delete-snapshot', snapshot_id: 's' },
    ],
    [
      'workspace_list_snapshots',
      { doc_path: '/a', op: 'delete' },
      { path: '/a', op: 'list-snapshots' },
    ],
  ])('routes %s to doc with canonical routing', async (name, input, expected) => {
    const handler = jest.fn().mockResolvedValue('canonical');
    handlers.set('doc', handler);
    const result = await toolExecutor.execute({ name, input }, agentTool('doc'));
    expect(result).toMatchObject({ success: true, output: 'canonical' });
    expect(handler.mock.calls[0]?.[0]).toMatchObject(expected);
  });
  it('keeps a live history handler exact during rollout', async () => {
    const handler = jest.fn().mockResolvedValue('legacy');
    handlers.set('doc_history', handler);
    handlers.set('doc', jest.fn());
    const input = { operation: 'delete', snapshot_id: 's' };
    expect(
      await toolExecutor.execute({ name: 'doc_history', input }, agentTool('doc_history'))
    ).toMatchObject({ success: true });
    expect(handler.mock.calls[0]?.[0]).toEqual(input);
    expect(handlers.get('doc')).not.toHaveBeenCalled();
  });
});
