/**
 * Tool-execution mounting + panel auth as the real app assembles them
 * (tools.routes.ts); tools-execution.test.ts covers the execution router alone.
 * By default the routes are mounted and every request needs a valid
 * X-Snaglet-Panel-Token: missing/wrong → 403, never 404 (ToolView treats 404 as
 * "route unmounted"). /execute/test gets the same enforcement, and
 * SNAGLET_DISABLE_TOOL_EXECUTION=true unmounts the routes entirely.
 * Only the DB/executor layer is mocked; panel auth and express wiring are real.
 */
import request from 'supertest';
import express from 'express';

const mockFindToolById = jest.fn();
const mockFindAgentById = jest.fn();
const mockExecute = jest.fn();
const mockGetDefinition = jest.fn();

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { findById: mockFindToolById },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: mockFindAgentById },
}));

jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: { execute: mockExecute },
}));

// A hook child's call is checked for "asks first" (hookCallConfirmation.ts,
// covered in tools-execution-hook-run-as.test.ts); none asks here.
jest.mock('@server/services/customHooks/hookCallConfirmation', () => ({
  hookCallAsksFirst: async () => false,
  hookSkippedCallResult: () => ({ success: false, output: '', error: 'skipped', durationMs: 0 }),
}));

jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn(async () => undefined),
    getDefinition: (id: string) => mockGetDefinition(id),
    getToolIds: jest.fn(() => ['shell_exec']),
  },
}));

// The other four sub-routers are irrelevant to execution mounting/auth —
// stub them so importing tools.routes.ts doesn't pull in unrelated
// dependency graphs (collection/workspace/assignment/single-tool CRUD).
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

/**
 * Fresh app plus the panel token from that same module instance. Resetting the
 * module registry re-evaluates tools.routes.ts against the current
 * SNAGLET_DISABLE_TOOL_EXECUTION value, which also regenerates panelAuth.ts's
 * PANEL_TOKEN and CHILD_DISPATCH_SECRET; a token minted from a separately
 * cached import would fail to verify, so tests mint through this build.
 * errorHandler is re-imported for the same reason: its `instanceof AppError`
 * check must see the same AppError class the fresh middleware throws, or every
 * rejection falls through as a 500.
 */
async function buildApp(): Promise<{
  app: express.Application;
  panelToken: string;
  mintChildDispatchToken: (
    agentId?: string,
    hookName?: string,
    chainDepth?: number,
    hookChain?: readonly string[]
  ) => string;
  currentChainDepth: () => number;
  currentHookChain: () => readonly string[];
}> {
  jest.resetModules();
  const toolsRoutes = (await import('@server/domains/tools/tools.routes')).default;
  const { getPanelToken, mintChildDispatchToken } = await import('@server/middleware/panelAuth');
  const { currentChainDepth, currentHookChain } = await import('@server/realtime/runContext');
  const { errorHandler } = await import('@server/middleware');
  const app = express();
  app.use(express.json());
  app.use('/api/tools', toolsRoutes);
  app.use(errorHandler);
  return {
    app,
    panelToken: getPanelToken(),
    mintChildDispatchToken,
    currentChainDepth,
    currentHookChain,
  };
}

const savedDisableFlag = process.env.SNAGLET_DISABLE_TOOL_EXECUTION;

beforeEach(() => {
  jest.clearAllMocks();
  mockFindToolById.mockResolvedValue(sampleTool);
  mockExecute.mockResolvedValue(sampleResult);
  mockGetDefinition.mockReturnValue(undefined);
});

afterEach(() => {
  if (savedDisableFlag === undefined) delete process.env.SNAGLET_DISABLE_TOOL_EXECUTION;
  else process.env.SNAGLET_DISABLE_TOOL_EXECUTION = savedDisableFlag;
});

describe('tools.routes — default mounting (SNAGLET_DISABLE_TOOL_EXECUTION unset)', () => {
  beforeEach(() => {
    delete process.env.SNAGLET_DISABLE_TOOL_EXECUTION;
  });

  test('POST /execute with no panel token → 403 JSON envelope, not 404', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/tools/execute').send({ name: 'echo_tool' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('POST /execute with the wrong panel token → 403', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', 'definitely-wrong')
      .send({ name: 'echo_tool' });

    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('POST /execute with the correct panel token → executes', async () => {
    const { app, panelToken } = await buildApp();
    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', panelToken)
      .send({ name: 'echo_tool', input: { a: 1 } });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  test('act_as_agent_id validation still applies once the token check passes', async () => {
    mockFindAgentById.mockResolvedValue(null);
    const { app, panelToken } = await buildApp();
    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', panelToken)
      .send({ name: 'echo_tool', act_as_agent_id: 'ghost' });

    expect(res.status).toBe(400); // unknown agent — never 404, see execution.routes.ts
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('POST /execute/test with no panel token → 403 (same enforcement as /execute)', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/tools/execute/test')
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('POST /execute/test with the wrong panel token → 403', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/tools/execute/test')
      .set('X-Snaglet-Panel-Token', 'nope')
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(403);
  });
});

describe('tools.routes — narrow child-dispatch credential', () => {
  beforeEach(() => {
    delete process.env.SNAGLET_DISABLE_TOOL_EXECUTION;
  });

  test('POST /execute with a token bound to agent-1 + matching agent_id → executes (runs the tool as this agent)', async () => {
    mockFindAgentById.mockResolvedValue({ id: 'agent-1', name: 'Alpha' });
    const { app, mintChildDispatchToken } = await buildApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ name: 'echo_tool', input: {}, agent_id: 'agent-1' });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockFindAgentById).toHaveBeenCalledWith('agent-1');
  });

  test('/execute runs the tool at the chain depth signed into the token', async () => {
    mockFindAgentById.mockResolvedValue({ id: 'agent-1', name: 'Alpha' });
    const { app, mintChildDispatchToken, currentChainDepth } = await buildApp();
    let seen: number | null = null;
    mockExecute.mockImplementation(async () => {
      seen = currentChainDepth();
      return sampleResult;
    });

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1', 'some-hook', 2))
      .send({ name: 'echo_tool', input: {}, agent_id: 'agent-1' });

    expect(res.status).toBe(200);
    expect(seen).toBe(2);
  });

  test('/execute runs the tool in the hook chain signed into the token', async () => {
    mockFindAgentById.mockResolvedValue({ id: 'agent-1', name: 'Alpha' });
    const { app, mintChildDispatchToken, currentHookChain } = await buildApp();
    let seen: readonly string[] | null = null;
    mockExecute.mockImplementation(async () => {
      seen = currentHookChain();
      return sampleResult;
    });

    const res = await request(app)
      .post('/api/tools/execute')
      .set(
        'X-Snaglet-Child-Dispatch-Token',
        mintChildDispatchToken('agent-1', 'some-hook', 2, ['other-hook', 'some-hook'])
      )
      .send({ name: 'echo_tool', input: {}, agent_id: 'agent-1', hookChain: [] });

    expect(res.status).toBe(200);
    expect(seen).toEqual(['other-hook', 'some-hook']);
  });

  test('a panel caller is a person (depth 0, no chain) even if the body claims one', async () => {
    const { app, panelToken, currentChainDepth, currentHookChain } = await buildApp();
    let seen: { depth: number; chain: readonly string[] } | null = null;
    mockExecute.mockImplementation(async () => {
      seen = { depth: currentChainDepth(), chain: currentHookChain() };
      return sampleResult;
    });

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', panelToken)
      .send({ name: 'echo_tool', input: {}, chainDepth: 4, hookChain: ['some-hook'] });

    expect(res.status).toBe(200);
    expect(seen).toEqual({ depth: 0, chain: [] });
  });

  test('POST /execute with a token bound to agent-1 + agent_id omitted → still executes as agent-1 (the binding, not the body, is authoritative)', async () => {
    mockFindAgentById.mockResolvedValue({ id: 'agent-1', name: 'Alpha' });
    const { app, mintChildDispatchToken } = await buildApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ name: 'echo_tool', input: {} });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockFindAgentById).toHaveBeenCalledWith('agent-1');
  });

  test('rejects a token bound to agent-1 whose body claims agent_id agent-2, and never executes as agent-2', async () => {
    // Raw-fetch impersonation: a workspace-tool/hook child spawned for agent-1
    // (holding its own bound token) learns agent-2's id (e.g. via
    // GET /api/agents) and names it in the request body. The token's binding
    // is the sole source of truth, so a mismatch is an outright rejection.
    mockFindAgentById.mockResolvedValue({ id: 'agent-2', name: 'Bravo' });
    const { app, mintChildDispatchToken } = await buildApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ name: 'echo_tool', input: {}, agent_id: 'agent-2' });

    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
    // The impersonated agent's policy must never even be looked up.
    expect(mockFindAgentById).not.toHaveBeenCalledWith('agent-2');
  });

  test('POST /execute with a wrong/forged X-Snaglet-Child-Dispatch-Token → 403 (does not fall back to unauthenticated)', async () => {
    const { app } = await buildApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', 'not-the-token')
      .send({ name: 'echo_tool', input: {}, agent_id: 'agent-1' });

    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('POST /execute with a bound child-dispatch token + act_as_agent_id → 403 (never panel/act_as authority, regardless of binding)', async () => {
    const { app, mintChildDispatchToken } = await buildApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ name: 'echo_tool', input: {}, act_as_agent_id: 'agent-1' });

    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('POST /execute with an unbound child-dispatch token (no agent context at mint time) → 403 (agent_id required — never the unguarded bucket)', async () => {
    const { app, mintChildDispatchToken } = await buildApp();

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken())
      .send({ name: 'echo_tool', input: {} });

    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test('POST /execute/test with a bound child-dispatch token (no panel token) → 403 (arbitrary-code sandbox needs full panel authority)', async () => {
    const { app, mintChildDispatchToken } = await buildApp();

    const res = await request(app)
      .post('/api/tools/execute/test')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(403);
  });

  test('POST /execute/log with a bound child-dispatch token → allowed (logging is not a privileged operation)', async () => {
    const { app, mintChildDispatchToken } = await buildApp();

    const res = await request(app)
      .post('/api/tools/execute/log')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('agent-1'))
      .send({ level: 'info', message: 'hello from a workspace tool' });

    expect(res.status).toBe(200);
  });
});

describe('tools.routes — SNAGLET_DISABLE_TOOL_EXECUTION=true (opt-out escape hatch)', () => {
  test('POST /execute is unmounted entirely → 404', async () => {
    process.env.SNAGLET_DISABLE_TOOL_EXECUTION = 'true';
    const { app, panelToken } = await buildApp();
    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', panelToken)
      .send({ name: 'echo_tool' });

    // Falls through to the /:id wildcard sub-router (single.routes, stubbed
    // to an empty router here) with nothing matching → Express's own 404.
    expect(res.status).toBe(404);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
