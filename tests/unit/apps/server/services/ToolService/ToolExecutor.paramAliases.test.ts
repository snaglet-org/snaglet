/**
 * Wiring test for the alias-normalization chokepoint: ToolExecutor.execute()
 * must apply each tool's `param_aliases` (read from its definition via
 * ToolRegistry) to the raw call input before invoking the handler — without
 * ever touching handler code. See lib/normalizeToolParams.test.ts for the
 * pure-function behavior; this file only pins down the wiring.
 */
const mockGetHandler = jest.fn();
const mockGetDefinition = jest.fn();

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    size: 0,
    load: jest.fn().mockResolvedValue(undefined),
    getHandler: (toolId: string) => mockGetHandler(toolId),
    getDefinition: (toolId: string) => mockGetDefinition(toolId),
  },
}));

import { toolExecutor } from '@server/services/ToolService/ToolExecutor';

function makeAgentTool() {
  return {
    agentId: 'test-agent',
    settings: {},
    requiresConfirmation: false,
    tool: {
      id: 'test-tool',
      name: 'Test Tool',
      description: 'A test tool',
      type: 'builtin',
      enabled: true,
      parameters_schema: {},
      config_json: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  } as Parameters<typeof toolExecutor.execute>[1];
}

describe('ToolExecutor — param_aliases normalization chokepoint', () => {
  beforeEach(() => {
    mockGetHandler.mockReset();
    mockGetDefinition.mockReset();
  });

  it('fills the internal key the handler reads from the canonical `id`', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);
    mockGetDefinition.mockReturnValue({ param_aliases: { doc_id: ['id'] } });

    const result = await toolExecutor.execute(
      { name: 'get_doc', input: { id: 'doc-1' } },
      makeAgentTool()
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({ id: 'doc-1', doc_id: 'doc-1' });
  });

  it('leaves a legacy caller sending the internal key directly untouched', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);
    mockGetDefinition.mockReturnValue({ param_aliases: { doc_id: ['id'] } });

    await toolExecutor.execute(
      { name: 'get_doc', input: { doc_id: 'doc-legacy' } },
      makeAgentTool()
    );

    expect(handler.mock.calls[0][0]).toEqual({ doc_id: 'doc-legacy' });
  });

  it('resolves multiple aliases in declared order (id first, then a legacy fallback)', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);
    mockGetDefinition.mockReturnValue({ param_aliases: { project_id: ['id', 'container_id'] } });

    await toolExecutor.execute(
      { name: 'multi_alias_tool', input: { container_id: 'c-1' } },
      makeAgentTool()
    );

    expect(handler.mock.calls[0][0]).toEqual({ container_id: 'c-1', project_id: 'c-1' });
  });

  it('is a no-op passthrough for tools with no param_aliases — unrecognized params still reach the handler as-is (and are rejected by it)', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('path is required'));
    mockGetHandler.mockReturnValue(handler);
    mockGetDefinition.mockReturnValue({});

    const result = await toolExecutor.execute(
      { name: 'file_read', input: { mystery: 'x' } },
      makeAgentTool()
    );

    expect(handler.mock.calls[0][0]).toEqual({ mystery: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('path is required');
  });

  it('still works when the registry has no definition at all for the tool', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);
    mockGetDefinition.mockReturnValue(undefined);

    await toolExecutor.execute({ name: 'mystery_tool', input: { foo: 'bar' } }, makeAgentTool());

    expect(handler.mock.calls[0][0]).toEqual({ foo: 'bar' });
  });

  it('does not aliasing across the destination/secondary param (workspace_restore_node keeps container_id distinct from id)', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);
    mockGetDefinition.mockReturnValue({ param_aliases: { node_id: ['id'] } });

    await toolExecutor.execute(
      { name: 'workspace_restore_node', input: { id: 'node-1', container_id: 'container-2' } },
      makeAgentTool()
    );

    expect(handler.mock.calls[0][0]).toEqual({
      id: 'node-1',
      container_id: 'container-2',
      node_id: 'node-1',
    });
  });
});
