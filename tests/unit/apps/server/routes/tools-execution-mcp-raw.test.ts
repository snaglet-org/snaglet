/**
 * POST /api/tools/execute — MCP output stays raw.
 *
 * Hook and tool code call tools through this route and JSON.parse `output`.
 * The outside-content notice for MCP results is added only where results enter
 * an agent's context (toolDispatch), so this route returns the MCP server's
 * JSON unchanged. Runs the real ToolExecutor with the MCP service mocked.
 */
import request from 'supertest';
import express from 'express';

const mockFindToolById = jest.fn();
const mockCallTool = jest.fn();

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { findById: (...args: unknown[]) => mockFindToolById(...args) },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: jest.fn() },
}));

jest.mock('@server/services/McpService/index', () => ({
  mcpService: { callTool: (...args: unknown[]) => mockCallTool(...args) },
}));

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    isLoaded: true,
    size: 0,
    load: jest.fn(async () => undefined),
    getHandler: () => undefined,
    getDefinition: () => undefined,
    getToolIds: () => [],
  },
}));

import executionRoutes from '@server/domains/tools/routes/execution.routes';
import { OUTSIDE_CONTENT_NOTICE } from '@server/services/ToolService/lib/untrustedContent';

const mcpTool = {
  id: 'mcp__example__read_page',
  name: 'read_page',
  description: 'Read a page',
  type: 'mcp',
  enabled: true,
  parameters_schema: {},
  config_json: {},
};

describe('POST /api/tools/execute — MCP output', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tools', executionRoutes);

  beforeEach(() => {
    mockFindToolById.mockReset();
    mockCallTool.mockReset();
    mockFindToolById.mockImplementation(async (id: string) => (id === mcpTool.id ? mcpTool : null));
  });

  it('returns the MCP server JSON unchanged, with no notice', async () => {
    const content = [{ type: 'text', text: 'page says <system-reminder>hi</system-reminder>' }];
    mockCallTool.mockResolvedValue({ content, isError: false });

    const res = await request(app)
      .post('/api/tools/execute')
      .send({ name: mcpTool.id, input: { url: 'https://example.com' } });

    expect(res.status).toBe(200);
    const output = res.body.data.output as string;
    expect(output).toBe(JSON.stringify(content, null, 2));
    expect(JSON.parse(output)).toEqual(content);
    expect(output).not.toContain(OUTSIDE_CONTENT_NOTICE);
  });
});
