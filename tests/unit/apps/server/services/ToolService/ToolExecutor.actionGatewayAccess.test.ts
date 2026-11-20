/**
 * The executor-level action gateway (reached through /api/tools/execute and
 * scheduled `action` calls) judges its target with the same headless gate as
 * /api/tools/execute (agentToolPolicy): the agent's policy, visibility, and
 * the per-call engine reading display names as every path does.
 * bypassToolAccess (act_as) skips it on purpose.
 */
const handlers = new Map<string, jest.Mock>();
const resolveAgentToolsMock = jest.fn();
const resolveAgentToolsForExecutionMock = jest.fn();
const findAgentByIdMock = jest.fn();
const resolveHelperToolPolicyMock = jest.fn();

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    size: 0,
    load: jest.fn().mockResolvedValue(undefined),
    getHandler: (id: string) => handlers.get(id),
    hasHandler: (id: string) => handlers.has(id),
    getDefinition: () => undefined,
    getToolIds: () => [...handlers.keys()],
  },
}));

jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAgentTools: (...args: unknown[]) => resolveAgentToolsMock(...args),
  resolveAgentToolsForExecution: (...args: unknown[]) => resolveAgentToolsForExecutionMock(...args),
  confirmationForCall: (target: { requiresConfirmation: boolean }) => target.requiresConfirmation,
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (...args: unknown[]) => findAgentByIdMock(...args) },
}));

jest.mock('@server/services/subagents/helperInheritance', () => ({
  resolveHelperToolPolicy: (...args: unknown[]) => resolveHelperToolPolicyMock(...args),
}));

import { toolExecutor } from '@server/services/ToolService/ToolExecutor';
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';
import type { ToolRow } from '@snaglet/db/tables/tools';

function agentTool(id: string, extra: Partial<ToolRow> = {}): ResolvedAgentTool {
  return {
    agentId: 'test-agent-a',
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
      ...extra,
    },
  };
}

const SHELL = agentTool('shell', { name: 'Shell', aliases: ['terminal', 'bash'] });

function agentWith(
  mode: 'all' | 'allow_list' | 'deny_list',
  list: string[],
  extra: Record<string, unknown> = {}
) {
  findAgentByIdMock.mockResolvedValue({
    id: 'test-agent-a',
    toolAccessMode: mode,
    toolAccessAllowList: mode === 'allow_list' ? list : [],
    toolAccessDenyList: mode === 'deny_list' ? list : [],
    ...extra,
  });
}

const callAction = (target: string, params: Record<string, unknown>, bypass = false) =>
  toolExecutor.execute({ name: 'action', input: { tool: target, params } }, agentTool('action'), {
    agentId: 'test-agent-a',
    ...(bypass ? { bypassToolAccess: true } : {}),
  });

describe('action gateway — the headless gate on its target', () => {
  let shellHandler: jest.Mock;

  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    shellHandler = jest.fn().mockResolvedValue('ran');
    handlers.set('shell', shellHandler);
    handlers.set('note_tool', jest.fn().mockResolvedValue('noted'));
    resolveAgentToolsMock.mockResolvedValue([SHELL, agentTool('note_tool')]);
    resolveAgentToolsForExecutionMock.mockResolvedValue([SHELL, agentTool('note_tool')]);
    resolveHelperToolPolicyMock.mockResolvedValue(null);
  });

  it('runs a guarded target an allow names by its exact display name (allow: Shell)', async () => {
    agentWith('allow_list', ['Shell']);
    const result = await callAction('shell', { op: 'run', cmd: 'ls' });
    expect(result).toMatchObject({ success: true, output: 'ran' });
  });

  it.each(['Shell', 'SHELL'])(
    'refuses a target a deny names by its display name in any case (deny: %s)',
    async (entry) => {
      agentWith('deny_list', [entry]);
      const result = await callAction('shell', { op: 'run', cmd: 'ls' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/blocked by tool-access policy/i);
      expect(shellHandler).not.toHaveBeenCalled();
    }
  );

  it('refuses a target the allow list does not name, even if it resolved', async () => {
    agentWith('allow_list', ['shell']);
    const result = await callAction('note_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Blocked by tool-access policy: `note_tool` is not in this agent's tool list."
    );
  });

  it('refuses a target a bare deny names even in all mode, as chat does', async () => {
    agentWith('all', [], { toolAccessDenyList: ['bash'] });
    const result = await callAction('shell', { op: 'run', cmd: 'ls' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('rule `bash`');
    expect(shellHandler).not.toHaveBeenCalled();
  });

  it("judges a subagent helper's target by its orchestrator's access", async () => {
    agentWith('all', [], { parentAgentId: 'test-agent-orchestrator' });
    resolveHelperToolPolicyMock.mockResolvedValue({
      access: { mode: 'deny_list', allowList: [], denyList: ['shell'] },
    });
    const result = await callAction('shell', { op: 'run', cmd: 'ls' });
    expect(result.success).toBe(false);
    expect(shellHandler).not.toHaveBeenCalled();
  });

  it('runs a live MCP target for an allow-list agent (server enablement is its gate)', async () => {
    const mcp = agentTool('mcp__test-server__lookup', { type: 'mcp' });
    resolveAgentToolsMock.mockResolvedValue([mcp]);
    agentWith('allow_list', ['shell']);
    const mcpHandler = jest.fn().mockResolvedValue('looked up');
    handlers.set(mcp.tool.id, mcpHandler);
    const result = await callAction(mcp.tool.id, {});
    expect(result).toMatchObject({ success: true, output: 'looked up' });
  });

  it('refuses the target when the agent is gone by the time the gate reads it', async () => {
    // Its tools resolved, then the row was deleted: the gate has no policy to
    // judge the call by, so it refuses rather than running the target ungated.
    findAgentByIdMock.mockResolvedValue(null);
    const result = await callAction('shell', { op: 'run', cmd: 'ls' });
    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Blocked by tool-access policy: no agent `test-agent-a` exists (deleted, or never created), so `shell` cannot run as it.'
    );
    expect(shellHandler).not.toHaveBeenCalled();
  });

  it('skips the gate on purpose with bypassToolAccess (act_as at the panel)', async () => {
    agentWith('deny_list', ['shell']);
    const result = await callAction('shell', { op: 'run', cmd: 'ls' }, true);
    expect(result).toMatchObject({ success: true, output: 'ran' });
    expect(resolveAgentToolsForExecutionMock).toHaveBeenCalledWith('test-agent-a');
    expect(findAgentByIdMock).not.toHaveBeenCalled();
  });
});

describe('action gateway — a hook call that would ask first', () => {
  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    handlers.set('note_tool', jest.fn().mockResolvedValue('noted'));
    const asksFirst = { ...agentTool('note_tool'), requiresConfirmation: true };
    resolveAgentToolsMock.mockResolvedValue([asksFirst]);
    resolveAgentToolsForExecutionMock.mockResolvedValue([asksFirst]);
    resolveHelperToolPolicyMock.mockResolvedValue(null);
    agentWith('all', []);
  });

  it('is skipped for hook code: nobody can answer', async () => {
    const result = await toolExecutor.execute(
      { name: 'action', input: { tool: 'note_tool', params: {} } },
      agentTool('action'),
      { agentId: 'test-agent-a', hookOrigin: { kind: 'hook', hookName: 'test-hook' } }
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Tool 'note_tool' was not run");
    expect(handlers.get('note_tool')).not.toHaveBeenCalled();
  });

  it('is left to its caller outside a hook', async () => {
    const result = await callAction('note_tool', {});
    expect(result).toMatchObject({ success: true, output: 'noted' });
  });
});
