import request from 'supertest';
import express from 'express';

// Shape thrown by the routes under test — read by the test error handler below.
interface TestAppError {
  httpStatus?: number;
  statusCode?: number;
  code?: string;
  message?: string;
}

const mockListTools = jest.fn();
const mockListResolvableTools = jest.fn();
const mockFindToolById = jest.fn();
const mockResolveAgentTools = jest.fn();
const mockFindAgentById = jest.fn();
const mockUpdateAgent = jest.fn();
const mockGetCatalogToolDefs = jest.fn();
const mockGetDefinition = jest.fn();
const mockGetToolIds = jest.fn((): string[] => []);

// The list/describe routes decorate rows with static execution metadata
// (contextRequirement / destructive / dispatchOnly) read from definition.ts
// via the registry singleton; unit runs never scan the real tool folders.
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn(async () => undefined),
    getDefinition: (id: string) => mockGetDefinition(id),
    getToolIds: () => mockGetToolIds(),
    reload: jest.fn(async () => ({ count: 0 })),
  },
}));

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: {
    listAll: mockListTools,
    listResolvable: mockListResolvableTools,
    findById: mockFindToolById,
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    findById: mockFindAgentById,
    update: mockUpdateAgent,
  },
}));

jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAgentTools: mockResolveAgentTools,
}));

// Mock the McpService barrel so the collection route's top-level import never
// pulls the live mcp-sdk into this unit run. `mcpToolDefToToolRow` is a pure
// projection (type-only imports) and is left unmocked so the route's real
// MCP-tool shaping is exercised.
jest.mock('@server/services/McpService', () => ({
  mcpService: { getCatalogToolDefs: mockGetCatalogToolDefs },
}));

jest.mock('../../../../../apps/server/src/middleware/index.ts', () => ({
  asyncHandler:
    (
      fn: (
        req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => Promise<unknown>
    ) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) =>
      fn(req, res, next).catch(next),
  validateBody: jest.fn(
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  ),
  validateQuery: jest.fn(
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  ),
  validateParams: jest.fn(
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  ),
  requestLogger: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  oauthRateLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  apiRateLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

jest.mock('@snaglet/shared/utils/errors', () => {
  class AppError extends Error {
    code: string;
    httpStatus: number;
    constructor(message: string, code: string, httpStatus: number) {
      super(message);
      this.code = code;
      this.httpStatus = httpStatus;
    }
  }
  return {
    AppError,
    AuthError: AppError,
    ValidationAppError: AppError,
    NotFoundError: AppError,
    ConflictError: AppError,
    RateLimitError: AppError,
  };
});

import toolsRouter from '@server/domains/tools/tools.routes';

const sampleTool = {
  id: 'file',
  name: 'File',
  description: 'Read files',
  type: 'builtin',
  enabled: true,
  parameters_schema: {},
  config_json: {},
};

const baseAgent = (fields: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'Test',
  ...fields,
});

describe('Tools Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tools', toolsRouter);
    app.use(
      (
        err: TestAppError,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        res.status(err.httpStatus || 500).json({ error: { code: err.code, message: err.message } });
      }
    );
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCatalogToolDefs.mockReturnValue([]);
    mockGetDefinition.mockReturnValue(undefined);
  });

  describe('GET /api/tools', () => {
    it('should list all tools', async () => {
      mockListTools.mockResolvedValue([sampleTool]);

      const res = await request(app).get('/api/tools');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(mockListTools).toHaveBeenCalled();
    });

    it('should list only resolvable tools when ?active=true', async () => {
      mockListResolvableTools.mockResolvedValue([sampleTool]);

      const res = await request(app).get('/api/tools?active=true');

      expect(res.status).toBe(200);
      expect(mockListResolvableTools).toHaveBeenCalled();
      expect(mockListTools).not.toHaveBeenCalled();
    });

    it('should not include live MCP tools by default', async () => {
      mockListTools.mockResolvedValue([sampleTool]);

      const res = await request(app).get('/api/tools');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe('file');
      expect(mockGetCatalogToolDefs).not.toHaveBeenCalled();
    });

    it('should append live MCP tools (grouped under integrations/<serverId>) when ?includeMcp=true', async () => {
      mockListTools.mockResolvedValue([sampleTool]);
      mockGetCatalogToolDefs.mockReturnValue([
        {
          serverId: 'notion',
          namespacedId: 'mcp__notion__search',
          rawToolName: 'search',
          name: 'search',
          description: 'Search Notion',
          inputSchema: { type: 'object' },
        },
      ]);

      const res = await request(app).get('/api/tools?includeMcp=true');

      expect(res.status).toBe(200);
      expect(mockGetCatalogToolDefs).toHaveBeenCalled();
      expect(res.body.data).toHaveLength(2);

      const mcp = res.body.data.find((t: { id: string }) => t.id === 'mcp__notion__search');
      expect(mcp).toBeDefined();
      expect(mcp.type).toBe('mcp');
      expect(mcp.categoryPath).toBe('integrations/notion');
      // MCP tools are gated per-server, so a listed one is available by construction.
      expect(mcp.availability).toBe('available');
      // The native builtin still leads the list.
      expect(res.body.data[0].id).toBe('file');
    });

    it('should return only persisted tools when ?includeMcp=true but no MCP servers are warm', async () => {
      mockListTools.mockResolvedValue([sampleTool]);
      mockGetCatalogToolDefs.mockReturnValue([]);

      const res = await request(app).get('/api/tools?includeMcp=true');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe('file');
    });
  });

  describe('GET /api/tools/agent/:agentId', () => {
    it('should resolve tools for an agent', async () => {
      mockResolveAgentTools.mockResolvedValue([
        { agentId: 'a1', tool: sampleTool, settings: {}, requiresConfirmation: false },
      ]);

      const res = await request(app).get('/api/tools/agent/a1');

      expect(res.status).toBe(200);
      expect(mockResolveAgentTools).toHaveBeenCalledWith('a1');
      expect(res.body.data).toHaveLength(1);
    });
  });

  describe('POST /api/tools/agent/:agentId', () => {
    it('should write a tool override into agent.configJson.toolOverrides', async () => {
      mockFindToolById.mockResolvedValue(sampleTool);
      mockFindAgentById.mockResolvedValue(baseAgent());
      mockUpdateAgent.mockResolvedValue(baseAgent());

      const res = await request(app)
        .post('/api/tools/agent/a1')
        .send({ toolId: 'file_read', settings: { maxDepth: 5 }, requiresConfirmation: true });

      expect(res.status).toBe(201);
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({
          toolOverrides: {
            file_read: { settings: { maxDepth: 5 }, requiresConfirmation: true },
          },
        })
      );
    });

    it('should also append to toolAccessAllowList when agent is in allow_list mode', async () => {
      mockFindToolById.mockResolvedValue(sampleTool);
      mockFindAgentById.mockResolvedValue(
        baseAgent({ toolAccessMode: 'allow_list', toolAccessAllowList: ['existing_tool'] })
      );
      mockUpdateAgent.mockResolvedValue(baseAgent());

      const res = await request(app).post('/api/tools/agent/a1').send({ toolId: 'file_read' });

      expect(res.status).toBe(201);
      const next = mockUpdateAgent.mock.calls[0][1];
      expect(next.toolAccessAllowList).toContain('file_read');
      expect(next.toolAccessAllowList).toContain('existing_tool');
    });

    it('should return 400 when toolId missing', async () => {
      const res = await request(app).post('/api/tools/agent/a1').send({});

      expect(res.status).toBe(400);
    });

    it('should return 404 when tool not found', async () => {
      mockFindToolById.mockResolvedValue(null);

      const res = await request(app).post('/api/tools/agent/a1').send({ toolId: 'nonexistent' });

      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/tools/agent/:agentId', () => {
    it('should switch the agent to allow_list mode and replace toolAllowList', async () => {
      mockFindAgentById.mockResolvedValue(baseAgent());
      mockUpdateAgent.mockResolvedValue(baseAgent());

      const res = await request(app)
        .put('/api/tools/agent/a1')
        .send({ toolIds: ['file_read', 'file_write'] });

      expect(res.status).toBe(200);
      expect(mockUpdateAgent).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({
          toolAccessMode: 'allow_list',
          toolAccessAllowList: ['file_read', 'file_write'],
        })
      );
    });

    it('should return 400 when toolIds not an array', async () => {
      const res = await request(app).put('/api/tools/agent/a1').send({ toolIds: 'not-array' });

      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/tools/:id', () => {
    it('should return tool by id', async () => {
      mockFindToolById.mockResolvedValue(sampleTool);

      const res = await request(app).get('/api/tools/file');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('file');
    });

    it('should return 404 when not found', async () => {
      mockFindToolById.mockResolvedValue(null);

      const res = await request(app).get('/api/tools/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/tools/agent/:agentId/:toolId', () => {
    it('should remove the tool override and prune from toolAllowList', async () => {
      mockFindAgentById.mockResolvedValue(
        baseAgent({
          toolAccessMode: 'allow_list',
          toolAccessAllowList: ['file_read', 'file_write'],
          toolOverrides: { file_read: { requiresConfirmation: true } },
        })
      );
      mockUpdateAgent.mockResolvedValue(baseAgent());

      const res = await request(app).delete('/api/tools/agent/a1/file_read');

      expect(res.status).toBe(200);
      const next = mockUpdateAgent.mock.calls[0][1];
      expect(next.toolAccessAllowList).toEqual(['file_write']);
      expect(next.toolOverrides).not.toHaveProperty('file_read');
    });

    it('should return 404 when nothing to remove', async () => {
      mockFindAgentById.mockResolvedValue(baseAgent());

      const res = await request(app).delete('/api/tools/agent/a1/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/tools/agent/:agentId/:toolId', () => {
    it('should update an existing tool override', async () => {
      mockFindAgentById.mockResolvedValue(
        baseAgent({
          toolOverrides: { file_read: { settings: { old: true } } },
        })
      );
      mockUpdateAgent.mockResolvedValue(baseAgent());

      const res = await request(app)
        .patch('/api/tools/agent/a1/file_read')
        .send({ settings: { maxLines: 100 }, requiresConfirmation: true });

      expect(res.status).toBe(200);
      const next = mockUpdateAgent.mock.calls[0][1];
      expect(next.toolOverrides.file_read).toEqual({
        settings: { maxLines: 100 },
        requiresConfirmation: true,
      });
    });

    it('should return 404 when no existing override for the tool', async () => {
      mockFindAgentById.mockResolvedValue(baseAgent());

      const res = await request(app)
        .patch('/api/tools/agent/a1/nonexistent')
        .send({ requiresConfirmation: false });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/tools — edge cases', () => {
    it('should return empty array when no tools exist', async () => {
      mockListTools.mockResolvedValue([]);

      const res = await request(app).get('/api/tools');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.data).toHaveLength(0);
    });

    it('should include success and timestamp in response', async () => {
      mockListTools.mockResolvedValue([sampleTool]);

      const res = await request(app).get('/api/tools');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.timestamp).toBeDefined();
      expect(typeof res.body.timestamp).toBe('string');
    });
  });

  describe('GET /api/tools/:id — response format', () => {
    it('should return full response shape with data, success, and timestamp', async () => {
      mockFindToolById.mockResolvedValue(sampleTool);

      const res = await request(app).get('/api/tools/file');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        data: { ...sampleTool, availability: 'available' },
        success: true,
        timestamp: expect.any(String),
      });
    });
  });

  describe('canonical ids only (old ids stay resolve-only)', () => {
    // Alias ids keep soft-retired rows (enabled=false): they resolve as
    // aliases but are never offered.
    const retired = (id: string) => ({ ...sampleTool, id, name: id, enabled: false });
    const shell = { ...sampleTool, id: 'shell', name: 'Shell' };
    const rows = [
      shell,
      retired('exec_command'),
      retired('sketch_create'),
      retired('sandbox_run'),
      sampleTool,
    ];
    const ids = (res: request.Response) => res.body.data.map((t: { id: string }) => t.id);

    it('GET /api/tools drops retired old ids (aliases and tombstones)', async () => {
      mockListTools.mockResolvedValue(rows);

      const res = await request(app).get('/api/tools');

      expect(res.status).toBe(200);
      expect(ids(res)).toEqual(['shell', 'file']);
    });

    it('drops them from ?active=true and ?includeMcp=true lists too', async () => {
      mockListResolvableTools.mockResolvedValue(rows);
      mockListTools.mockResolvedValue(rows);

      expect(ids(await request(app).get('/api/tools?active=true'))).toEqual(['shell', 'file']);
      expect(ids(await request(app).get('/api/tools?includeMcp=true'))).toEqual(['shell', 'file']);
    });

    it('keeps an old id that still has a live definition of its own', async () => {
      mockListTools.mockResolvedValue(rows);
      mockGetToolIds.mockReturnValueOnce(['shell', 'file', 'exec_command']);

      const res = await request(app).get('/api/tools');

      expect(ids(res)).toEqual(['shell', 'exec_command', 'file']);
    });

    it('GET /api/tools/agent/:agentId lists no old ids', async () => {
      mockResolveAgentTools.mockResolvedValue(
        rows.map((tool) => ({ agentId: 'a1', tool, settings: {}, requiresConfirmation: false }))
      );

      const res = await request(app).get('/api/tools/agent/a1');

      expect(res.body.data.map((t: { tool: { id: string } }) => t.tool.id)).toEqual([
        'shell',
        'file',
      ]);
    });

    it('GET /api/tools/:id answers an old id with the tool it now names', async () => {
      mockFindToolById.mockImplementation(async (id: string) =>
        id === 'shell' ? shell : id === 'exec_command' ? retired('exec_command') : null
      );

      const res = await request(app).get('/api/tools/exec_command');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('shell');
    });

    it('GET /api/tools/:id keeps a removal tombstone on its own row', async () => {
      mockFindToolById.mockImplementation(async (id: string) =>
        id === 'sandbox_run' ? retired('sandbox_run') : null
      );

      const res = await request(app).get('/api/tools/sandbox_run');

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe('sandbox_run');
    });
  });

  describe('execution metadata exposure (contextRequirement / destructive / dispatchOnly)', () => {
    // The panel drives its act-as picker, confirm gate, and hidden-Run state
    // from these fields — declared once in each tool's definition.ts, exposed
    // through the same list/describe payloads the panel already consumes.
    it('GET /api/tools surfaces definition-declared metadata on each row', async () => {
      mockListTools.mockResolvedValue([
        { ...sampleTool, id: 'memory' },
        { ...sampleTool, id: 'database_execute' },
        { ...sampleTool, id: 'action' },
        { ...sampleTool, id: 'plain_tool' },
      ]);
      mockGetDefinition.mockImplementation(
        (id: string) =>
          ({
            memory: { id: 'memory', contextRequirement: 'agent-required' },
            database_execute: { id: 'database_execute', destructive: true },
            action: { id: 'action', dispatchOnly: true },
          })[id]
      );

      const res = await request(app).get('/api/tools');

      expect(res.status).toBe(200);
      const byId = Object.fromEntries(res.body.data.map((t: { id: string }) => [t.id, t]));
      expect(byId.memory.contextRequirement).toBe('agent-required');
      expect(byId.database_execute.destructive).toBe(true);
      expect(byId.action.dispatchOnly).toBe(true);
      // Unmarked tools stay clean — no noise keys added to every row.
      expect(byId.plain_tool).not.toHaveProperty('contextRequirement');
      expect(byId.plain_tool).not.toHaveProperty('destructive');
      expect(byId.plain_tool).not.toHaveProperty('dispatchOnly');
    });

    it('GET /api/tools/:id surfaces the same metadata on the single-tool payload', async () => {
      mockFindToolById.mockResolvedValue({ ...sampleTool, id: 'memory' });
      mockGetDefinition.mockImplementation((id: string) =>
        id === 'memory' ? { id: 'memory', contextRequirement: 'agent-required' } : undefined
      );

      const res = await request(app).get('/api/tools/memory');

      expect(res.status).toBe(200);
      expect(res.body.data.contextRequirement).toBe('agent-required');
    });
  });
});
