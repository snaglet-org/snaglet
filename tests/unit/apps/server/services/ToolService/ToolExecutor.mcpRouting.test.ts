/**
 * ToolExecutor — which connection an MCP call runs on. A resolved MCP tool
 * names the agent whose per-agent connection it uses (`mcpAgentId`): a
 * subagent helper's tool names its orchestrator, so the helper's calls run
 * on the orchestrator's server instance, not a new process of its own.
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

const mockCallTool = jest.fn();
jest.mock('@server/services/McpService/index', () => ({
  mcpService: { callTool: (...args: unknown[]) => mockCallTool(...args) },
}));

import { toolExecutor } from '@server/services/ToolService/ToolExecutor';

const MCP_TOOL = 'mcp__test-server-a__list_issues';
const ORCH = 'test-agent-a';
const HELPER = 'subagent-11111111-1111-4111-8111-111111111111';

function mcpAgentTool(agentId: string, mcpAgentId?: string) {
  return {
    agentId,
    ...(mcpAgentId ? { mcpAgentId } : {}),
    settings: {},
    requiresConfirmation: false,
    tool: {
      id: MCP_TOOL,
      name: 'list_issues',
      description: 'List issues',
      type: 'mcp',
      enabled: true,
      parameters_schema: {},
      config_json: {},
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  } as Parameters<typeof toolExecutor.execute>[1];
}

describe('ToolExecutor — MCP connection routing', () => {
  beforeEach(() => {
    mockGetHandler.mockReset().mockReturnValue(undefined);
    mockGetDefinition.mockReset().mockReturnValue(undefined);
    mockCallTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  });

  it("runs a helper's call on its orchestrator's connection", async () => {
    const result = await toolExecutor.execute(
      { name: MCP_TOOL, input: {} },
      mcpAgentTool(HELPER, ORCH),
      { agentId: HELPER, threadId: 'thread-2222222222222-bbbbbbbbb' }
    );
    expect(result.success).toBe(true);
    expect(mockCallTool).toHaveBeenCalledWith(MCP_TOOL, {}, { agentId: ORCH });
  });

  it('falls back to the calling agent when the tool names none', async () => {
    await toolExecutor.execute({ name: MCP_TOOL, input: {} }, mcpAgentTool(ORCH), {
      agentId: ORCH,
    });
    expect(mockCallTool).toHaveBeenCalledWith(MCP_TOOL, {}, { agentId: ORCH });
  });
});
