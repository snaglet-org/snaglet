/**
 * Op-scoped aliases at the MCP boundary: an alias `snaglet_*` name absorbed into a
 * merged `tool(op)` stays callable, lands on the op it stands for (callers
 * cannot redirect it), and never reaches an op the curated tier does not
 * expose. Uses a fake `memory(op)` alias table independent of the real one:
 * memory_save → memory(op:create), memory_forget → memory(op:delete), with
 * only `create`/`search` curated.
 */
const getDefinitionMock = jest.fn();
const executeMock = jest.fn();

const FAKE_ALIASES: Record<string, { id: string; op: string }> = {
  memory_save: { id: 'memory', op: 'create' },
  memory_forget: { id: 'memory', op: 'delete' },
};

jest.mock('@snaglet/shared/utils', () => {
  const actual = jest.requireActual('@snaglet/shared/utils');
  const resolveToolId = (id: string) => {
    const spec = FAKE_ALIASES[id];
    if (!spec) return { id };
    return {
      id: spec.id,
      aliasedFrom: id,
      op: spec.op,
      transformParams: (params: Record<string, unknown>) => ({ ...params, op: spec.op }),
    };
  };
  return { ...actual, resolveToolId };
});

jest.mock('@server/domains/mcp/mcpProjection', () => {
  const actual = jest.requireActual('@server/domains/mcp/mcpProjection');
  const curatedIds = [...actual.CURATED_TOOL_IDS, 'memory'];
  const curatedOps = { memory: ['create', 'search'] };
  return {
    ...actual,
    fromMcpToolName: (name: string) => actual.fromMcpToolName(name, { curatedIds, curatedOps }),
    isExternalOpAllowed: (toolId: string, op: string | null) =>
      actual.isExternalOpAllowed(toolId, op, curatedOps),
  };
});

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    load: jest.fn().mockResolvedValue(undefined),
    getDefinition: (...args: unknown[]) => getDefinitionMock(...args),
    getAllDefinitions: jest.fn().mockReturnValue({}),
  },
}));

jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: { execute: (...args: unknown[]) => executeMock(...args) },
}));

jest.mock('@snaglet/db', () => ({ Containers: {}, Projects: {} }));

jest.mock('@server/realtime/actorContext', () => ({
  runWithActor: (_actor: unknown, operation: () => unknown) => operation(),
}));

import { mcpGatewayService } from '@server/domains/mcp/McpGatewayService';

const caller = { memberId: 'member-1', name: 'External test' };

function memoryDefinition() {
  return {
    id: 'memory',
    name: 'memory',
    description: 'memory',
    type: 'builtin',
    tier: 'core',
    categoryPath: 'memory',
    parameters_schema: {},
    keywords: [],
  };
}

describe('McpGatewayService op-scoped aliases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getDefinitionMock.mockImplementation((id: string) =>
      id === 'memory' ? memoryDefinition() : undefined
    );
    executeMock.mockResolvedValue({ success: true, output: 'ok', durationMs: 1 });
  });

  it('runs an old curated name as its pinned op of the merged tool', async () => {
    const result = await mcpGatewayService.executeExternalToolCall(
      'snaglet_memory_save',
      { content: 'x' },
      caller
    );
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(executeMock).toHaveBeenCalledWith(
      { name: 'memory_save', input: { content: 'x', op: 'create' } },
      expect.objectContaining({ tool: expect.objectContaining({ id: 'memory' }) }),
      {}
    );
  });

  it('cannot redirect an old name to another op by passing `op`', async () => {
    await mcpGatewayService.executeExternalToolCall(
      'snaglet_memory_save',
      { content: 'x', op: 'delete' },
      caller
    );
    expect(executeMock).toHaveBeenCalledWith(
      expect.objectContaining({ input: { content: 'x', op: 'create' } }),
      expect.anything(),
      {}
    );
  });

  it('does not expose an old name whose op was never curated', async () => {
    const result = await mcpGatewayService.executeExternalToolCall(
      'snaglet_memory_forget',
      { memory_id: 'm1' },
      caller
    );
    expect(result.isError).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('refuses an uncurated op on the merged tool name with a plain message', async () => {
    const result = await mcpGatewayService.executeExternalToolCall(
      'snaglet_memory',
      { op: 'delete', memory_id: 'm1' },
      caller
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('op `delete`');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('allows a curated op on the merged tool name', async () => {
    await mcpGatewayService.executeExternalToolCall(
      'snaglet_memory',
      { op: 'search', query: 'q' },
      caller
    );
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});
