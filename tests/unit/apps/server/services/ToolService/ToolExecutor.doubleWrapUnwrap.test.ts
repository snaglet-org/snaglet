/**
 * Wiring test for the double-wrap unwrap chokepoint: ToolExecutor.execute()
 * must unwrap `{ function_name: <this tool>, arguments: {…} }` shaped input
 * to the inner arguments object before alias normalization and the handler —
 * and must not touch anything that is not exactly that shape. See
 * lib/unwrapDoubleWrappedInput.test.ts for the pure-function contract; this
 * file only pins down the wiring.
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
import type { ResolvedAgentTool } from '@server/services/AgentToolResolver';

function makeAgentTool(toolId = 'test-tool'): ResolvedAgentTool {
  return {
    agentId: 'test-agent',
    settings: {},
    requiresConfirmation: false,
    tool: {
      id: toolId,
      name: 'Test Tool',
      description: 'A test tool',
      type: 'builtin',
      enabled: true,
      parameters_schema: {},
      config_json: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  } as unknown as ResolvedAgentTool;
}

describe('ToolExecutor — double-wrapped input unwrap', () => {
  beforeEach(() => {
    mockGetHandler.mockReset();
    mockGetDefinition.mockReset();
    mockGetDefinition.mockReturnValue({});
  });

  it('unwraps { function_name, arguments } naming the invoked tool before the handler runs', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);

    const result = await toolExecutor.execute(
      {
        name: 'create_doc',
        input: {
          function_name: 'create_doc',
          arguments: { title: 'Release Notes', content: 'body' },
        },
      },
      makeAgentTool('create_doc')
    );

    expect(result.success).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toEqual({ title: 'Release Notes', content: 'body' });
  });

  it('matches the wrapper against the resolved tool row id as well as the call name', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);

    // Display-name style invocation whose resolved row is the wrapped tool.
    await toolExecutor.execute(
      { name: 'edit_doc', input: { tool: 'edit_doc', args: { doc_id: 'd1', content: 'x' } } },
      makeAgentTool('edit_doc')
    );

    expect(handler.mock.calls[0][0]).toEqual({ doc_id: 'd1', content: 'x' });
  });

  it('applies param_aliases to the unwrapped input (unwrap happens first)', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);
    mockGetDefinition.mockReturnValue({ param_aliases: { doc_id: ['id'] } });

    await toolExecutor.execute(
      { name: 'get_doc', input: { function_name: 'get_doc', arguments: { id: 'doc-1' } } },
      makeAgentTool('get_doc')
    );

    expect(handler.mock.calls[0][0]).toEqual({ id: 'doc-1', doc_id: 'doc-1' });
  });

  it('does not unwrap when the wrapper names a different tool', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);

    const wrapper = { function_name: 'edit_doc', arguments: { title: 'T' } };
    await toolExecutor.execute({ name: 'create_doc', input: wrapper }, makeAgentTool('create_doc'));

    expect(handler.mock.calls[0][0]).toEqual(wrapper);
  });

  it('does not unwrap when extra meaningful keys ride alongside the wrapper pair', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);

    const input = {
      function_name: 'create_doc',
      arguments: { title: 'Inner' },
      title: 'Outer',
    };
    await toolExecutor.execute({ name: 'create_doc', input }, makeAgentTool('create_doc'));

    expect(handler.mock.calls[0][0]).toEqual(input);
  });

  it('does not unwrap non-object arguments (e.g. a JSON string)', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    mockGetHandler.mockReturnValue(handler);

    const input = { function_name: 'create_doc', arguments: '{"title":"T"}' };
    await toolExecutor.execute({ name: 'create_doc', input }, makeAgentTool('create_doc'));

    expect(handler.mock.calls[0][0]).toEqual(input);
  });
});
