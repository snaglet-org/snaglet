const getDefinitionMock = jest.fn();
const executeMock = jest.fn();

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    load: jest.fn().mockResolvedValue(undefined),
    getDefinition: (...args: unknown[]) => getDefinitionMock(...args),
    getAllDefinitions: jest.fn().mockReturnValue({}),
  },
}));

jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: {
    execute: (...args: unknown[]) => executeMock(...args),
  },
}));

jest.mock('@snaglet/db', () => ({
  Containers: {},
  Projects: {},
}));

jest.mock('@server/realtime/actorContext', () => ({
  runWithActor: (_actor: unknown, operation: () => unknown) => operation(),
}));

import { mcpGatewayService } from '@server/domains/mcp/McpGatewayService';

function definition(id: string) {
  return {
    id,
    name: id,
    description: id,
    type: 'builtin',
    tier: 'core',
    categoryPath: 'search',
    parameters_schema: {},
    keywords: [],
  };
}

describe('McpGatewayService permanent catalog aliases', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps an old snaglet_ boundary name working after only the canonical definition remains', async () => {
    getDefinitionMock.mockImplementation((id: string) =>
      id === 'search' ? definition('search') : undefined
    );
    executeMock.mockResolvedValue({
      success: true,
      output: 'mcp result',
      durationMs: 1,
    });

    const result = await mcpGatewayService.executeExternalToolCall(
      'snaglet_workspace_search',
      { query: 'needle', kind: 'files' },
      { memberId: 'member-1', name: 'External test' }
    );

    expect(result).toEqual({ content: [{ type: 'text', text: 'mcp result' }] });
    expect(executeMock).toHaveBeenCalledWith(
      {
        name: 'workspace_search',
        input: { query: 'needle', kind: 'workspace' },
      },
      expect.objectContaining({
        tool: expect.objectContaining({ id: 'search' }),
      }),
      {}
    );
  });
});
