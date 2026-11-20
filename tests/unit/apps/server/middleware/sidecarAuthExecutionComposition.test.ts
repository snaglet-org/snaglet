/**
 * Composition test for the packaged-desktop tool-execution auth pipeline.
 *
 * In a packaged build SNAGLET_AUTH_TOKEN is set, so `sidecarAuthMiddleware` gates
 * every `/api/*` request. The execution routes must still reach
 * `tools.routes.ts`'s own path-scoped auth (`X-Snaglet-Panel-Token`,
 * `X-Snaglet-Sidecar-Token`, `X-Snaglet-Child-Dispatch-Token`) instead of being 401'd
 * first. This builds a real Express app in the production middleware order
 * (sidecar auth on `/api`, as in `apps/server/src/index.ts`, then the real
 * tools router), because the behavior lives in the composition and mount
 * order; sidecarAuth.test.ts and panelAuth.test.ts cover each layer alone.
 */
import request from 'supertest';
import express from 'express';

const mockFindToolById = jest.fn();
const mockExecute = jest.fn();
const mockGetDefinition = jest.fn();

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { findById: mockFindToolById },
}));

// agent-1 exists (all mode): a child-dispatch token bound to an agent with no
// row behind it is refused.
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    findById: jest.fn(async (id: string) =>
      id === 'agent-1' ? { id: 'agent-1', name: 'Test Agent' } : null
    ),
  },
}));

jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: { execute: mockExecute },
}));

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn(async () => undefined),
    getDefinition: (id: string) => mockGetDefinition(id),
    getToolIds: jest.fn(() => ['echo_tool']),
  },
}));

// Irrelevant sub-routers stubbed so importing tools.routes.ts stays cheap —
// same pattern as tools.routes.test.ts.
jest.mock('@server/domains/tools/routes/collection.routes', () => ({
  __esModule: true,
  default: (require('express') as typeof import('express')).Router(),
}));
jest.mock('@server/domains/tools/routes/workspaces.routes', () => ({
  __esModule: true,
  default: (require('express') as typeof import('express')).Router(),
}));
jest.mock('@server/domains/tools/routes/assignments.routes', () => ({
  __esModule: true,
  default: (require('express') as typeof import('express')).Router(),
}));
jest.mock('@server/domains/tools/routes/single.routes', () => ({
  __esModule: true,
  default: (require('express') as typeof import('express')).Router(),
}));

const sampleTool = {
  id: 'echo_tool',
  name: 'Echo',
  description: 'Echo input',
  type: 'builtin',
  enabled: true,
  parameters_schema: {},
  config_json: {},
};
const sampleResult = { success: true, output: 'ok', durationMs: 1 };

const SIDECAR_TOKEN = 'packaged-sidecar-session-token';

/**
 * Fresh app assembled in production order: sidecarAuthMiddleware (global,
 * /api) → tools.routes.ts (path-scoped panel/child-dispatch auth) →
 * errorHandler. Reset + re-import per call as in tools.routes.test.ts: tokens
 * and errorHandler must come from this build's module instance.
 */
async function buildProductionOrderedApp(): Promise<{
  app: express.Application;
  panelToken: string;
  mintChildDispatchToken: (agentId?: string) => string;
}> {
  jest.resetModules();
  const { sidecarAuthMiddleware } = await import('@server/middleware/sidecarAuth');
  const toolsRoutes = (await import('@server/domains/tools/tools.routes')).default;
  const { getPanelToken, mintChildDispatchToken } = await import('@server/middleware/panelAuth');
  const { errorHandler } = await import('@server/middleware');

  const app = express();
  app.use(express.json());
  // Mirrors apps/server/src/index.ts: sidecarAuthMiddleware mounted globally
  // before any /api/* domain router, including /api/tools.
  app.use(sidecarAuthMiddleware);
  app.use('/api/tools', toolsRoutes);
  app.use(errorHandler);
  return { app, panelToken: getPanelToken(), mintChildDispatchToken };
}

const savedSidecarToken = process.env.SNAGLET_AUTH_TOKEN;
const savedDisableFlag = process.env.SNAGLET_DISABLE_TOOL_EXECUTION;

beforeEach(() => {
  jest.clearAllMocks();
  mockFindToolById.mockResolvedValue(sampleTool);
  mockExecute.mockResolvedValue(sampleResult);
  mockGetDefinition.mockReturnValue(undefined);
  // The packaged-build condition: the desktop shell has set SNAGLET_AUTH_TOKEN.
  process.env.SNAGLET_AUTH_TOKEN = SIDECAR_TOKEN;
  delete process.env.SNAGLET_DISABLE_TOOL_EXECUTION;
});

afterEach(() => {
  if (savedSidecarToken === undefined) delete process.env.SNAGLET_AUTH_TOKEN;
  else process.env.SNAGLET_AUTH_TOKEN = savedSidecarToken;
  if (savedDisableFlag === undefined) delete process.env.SNAGLET_DISABLE_TOOL_EXECUTION;
  else process.env.SNAGLET_DISABLE_TOOL_EXECUTION = savedDisableFlag;
});

describe('packaged tool-execution auth pipeline (production middleware order, SNAGLET_AUTH_TOKEN set)', () => {
  test.each(['/API/TOOLS/EXECUTE', '/Api/Tools/Execute'])(
    '%s still uses the execution credential gate',
    async (route) => {
      const { app, panelToken } = await buildProductionOrderedApp();
      const rejected = await request(app).post(route).send({ name: 'echo_tool', input: {} });
      expect(rejected.status).toBe(403);
      expect(mockExecute).not.toHaveBeenCalled();
      const accepted = await request(app)
        .post(route)
        .set('X-Snaglet-Panel-Token', panelToken)
        .send({ name: 'echo_tool', input: {} });
      expect(accepted.status).toBe(200);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    }
  );
  test('a valid X-Snaglet-Sidecar-Token (packaged `snaglet run`) reaches /api/tools/execute', async () => {
    const { app } = await buildProductionOrderedApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Sidecar-Token', SIDECAR_TOKEN)
      .send({ name: 'echo_tool', input: {} });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalled();
  });

  test('a valid X-Snaglet-Child-Dispatch-Token (server-spawned custom tool/hook) reaches /api/tools/execute', async () => {
    const { app, mintChildDispatchToken } = await buildProductionOrderedApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ name: 'echo_tool', agent_id: 'agent-1', input: {} });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalled();
  });

  test('a valid X-Snaglet-Panel-Token (desktop UI) reaches /api/tools/execute', async () => {
    const { app, panelToken } = await buildProductionOrderedApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', panelToken)
      .send({ name: 'echo_tool', input: {} });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalled();
  });

  test('a valid X-Snaglet-Panel-Token reaches /api/tools/execute/test (full panel authority)', async () => {
    const { app, panelToken } = await buildProductionOrderedApp();

    const res = await request(app)
      .post('/api/tools/execute/test')
      .set('X-Snaglet-Panel-Token', panelToken)
      .send({ code: 'export default async () => "hi";' });

    // Not asserting 200 here — /execute/test spawns real esbuild/node in
    // this composition test, which is slow/unnecessary for an auth pin. Any
    // response other than the auth-layer's 401/403 proves the request
    // reached the route handler.
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  }, 30_000);

  test('a child-dispatch token is still rejected at /api/tools/execute/test (must stay panel/sidecar-only)', async () => {
    const { app, mintChildDispatchToken } = await buildProductionOrderedApp();

    const res = await request(app)
      .post('/api/tools/execute/test')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(403);
  });

  test('missing credentials on /api/tools/execute are still rejected (never silently open)', async () => {
    const { app } = await buildProductionOrderedApp();

    const res = await request(app).post('/api/tools/execute').send({ name: 'echo_tool' });

    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('an unrelated /api route is unaffected — still requires the plain sidecar session token', async () => {
    const { app } = await buildProductionOrderedApp();

    // No /api/providers router is mounted here, so a request that clears
    // sidecarAuthMiddleware falls through to Express's 404. The point is only
    // that the 401 applies without the x-snaglet-token and not with it.
    const rejected = await request(app).get('/api/providers');
    expect(rejected.status).toBe(401);

    const passedAuth = await request(app)
      .get('/api/providers')
      .set('x-snaglet-token', SIDECAR_TOKEN);
    expect(passedAuth.status).not.toBe(401);
  });

  test('an execution-scoped X-Snaglet-Panel-Token does not grant access to an unrelated /api route (deferral stays narrow)', async () => {
    const { app, panelToken } = await buildProductionOrderedApp();

    const res = await request(app).get('/api/providers').set('X-Snaglet-Panel-Token', panelToken);

    // sidecarAuthMiddleware must not treat X-Snaglet-Panel-Token as a general
    // bypass for non-execution routes — only x-snaglet-token/?snaglet_token= (or the
    // narrow execution-path deferral) satisfies it.
    expect(res.status).toBe(401);
  });
});
