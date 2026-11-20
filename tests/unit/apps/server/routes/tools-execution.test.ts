/**
 * POST /api/tools/execute — panel act-as + safety hardening.
 *
 * This route is the panel's direct execution path. Agents' own tool calls go
 * through the socket dispatch loop (toolDispatch.ts), never this route, so
 * `act_as_agent_id` is a user-facing convenience, not an agent-reachable
 * impersonation vector. Pins: context building (none / agent_id /
 * act_as_agent_id); unknown act_as agent → 400, not 404 (ToolView reads 404
 * as "execution disabled"); act_as + agent_id → 400; act_as does not apply
 * the acted-as agent's tool-access policy (the person is the principal) while
 * agent_id does; dispatch-only tools such as get_clarification stay
 * conversation-only.
 */
import request from 'supertest';
import express from 'express';

// Shape thrown by the routes under test — read by the test error handler below.
interface TestAppError {
  httpStatus?: number;
  statusCode?: number;
  code?: string;
  message?: string;
}
import { EventEmitter } from 'events';
import path from 'path';

const mockFindToolById = jest.fn();
const mockFindAgentById = jest.fn();
const mockExecute = jest.fn();
const mockGetDefinition = jest.fn();

// jest.spyOn(fs, 'writeFileSync') can't redefine the property on this
// Node/ESM setup ("Cannot redefine property"), so writeFileSync is wrapped
// via a full jest.mock instead — the real implementation is preserved
// (real files are still written to a real tmp dir), and calls are
// recorded on a jest.fn() for the token-leak assertions below.
const mockWriteFileSync = jest.fn();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    writeFileSync: (...args: unknown[]) => {
      mockWriteFileSync(...args);
      return actual.writeFileSync(...args);
    },
  };
});

// /execute/test spawns esbuild + node directly (its own code path, separate
// from toolExecutor.execute). Mocked here so the token-leak SDK/env tests
// below don't depend on a real esbuild/node subprocess — they
// exercise the real route handler (real writeFileSync into a real tmp dir),
// just with fake, instantly-resolving children standing in for the two
// spawn() calls.
const mockSpawn = jest.fn();
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// The login-shell PATH lookup, settled to a known PATH without running a shell.
const mockLoginPath = '/login-shell/bin:/usr/bin:/bin:/usr/sbin:/sbin';
jest.mock('@server/services/ToolService/lib/loginShellPath', () => ({
  resolveLoginShellPath: () => Promise.resolve(),
  shellPath: () => mockLoginPath,
}));

function makeFakeChild(stdout = '', code = 0): EventEmitter & Record<string, unknown> {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdoutStream = new EventEmitter();
  const stderrStream = new EventEmitter();
  child.stdout = stdoutStream;
  child.stderr = stderrStream;
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.kill = jest.fn();
  queueMicrotask(() => {
    if (stdout) stdoutStream.emit('data', Buffer.from(stdout));
    child.emit('close', code, null);
  });
  return child;
}

// Op-scoped aliases: a stand-in `memory(op)` so the hook/SDK alias path is
// tested independently of the real alias table. Inert for every other id.
jest.mock('@snaglet/shared/utils/toolAliases', () => {
  const actual = jest.requireActual('@snaglet/shared/utils/toolAliases');
  const ops: Record<string, string> = { memory_save: 'create', memory_forget: 'delete' };
  const resolveToolId = (id: string) =>
    ops[id]
      ? {
          id: 'memory',
          aliasedFrom: id,
          op: ops[id],
          transformParams: (p: Record<string, unknown>) => ({ ...p, op: ops[id] }),
        }
      : actual.resolveToolId(id);
  return {
    ...actual,
    resolveToolId,
    toolIdsEquivalent: (a: string, b: string) => resolveToolId(a).id === resolveToolId(b).id,
  };
});

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { findById: mockFindToolById },
}));

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: mockFindAgentById },
}));

jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: { execute: mockExecute },
}));

// A subagent helper is judged by its orchestrator's live access. Only
// consulted for an agent row with a parentAgentId.
const mockResolveHelperToolPolicy = jest.fn();
jest.mock('@server/services/subagents/helperInheritance', () => ({
  resolveHelperToolPolicy: (...args: unknown[]) => mockResolveHelperToolPolicy(...args),
}));

// The execution-metadata helper reads static definition.ts metadata through
// the registry singleton; unit runs never scan the real tool folders.
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn(async () => undefined),
    getDefinition: (id: string) => mockGetDefinition(id),
    getToolIds: jest.fn(() => ['action', 'echo_tool', 'shell_exec', 'memory']),
  },
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

jest.mock('../../../../../packages/shared/types/index.ts', () => ({
  ErrorCode: {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    FORBIDDEN: 'FORBIDDEN',
  },
  HTTP_STATUS: { BAD_REQUEST: 400, NOT_FOUND: 404, FORBIDDEN: 403 },
}));

import executionRoutes from '@server/domains/tools/routes/execution.routes';
import { SDK_RUNTIME_SOURCE } from '@server/services/ToolService/customTools/vendorSdk';
import {
  mintChildDispatchToken,
  getPanelToken,
  toolDispatchAuthMiddleware,
  verifyChildDispatchToken,
} from '@server/middleware/panelAuth';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';

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

describe('POST /api/tools/execute — act-as + hardening', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tools', executionRoutes);
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
    mockFindToolById.mockResolvedValue(sampleTool);
    mockExecute.mockResolvedValue(sampleResult);
    mockGetDefinition.mockReturnValue(undefined);
  });

  describe('context building', () => {
    it('runs with no handler context when neither agent_id nor act_as_agent_id is sent', async () => {
      const res = await request(app)
        .post('/api/tools/execute')
        .send({ name: 'echo_tool', input: { a: 1 } });

      expect(res.status).toBe(200);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [call, agentTool, context] = mockExecute.mock.calls[0];
      expect(call).toEqual({ name: 'echo_tool', input: { a: 1 } });
      expect(context).toBeUndefined();
      // The panel confirm gate is client-side; the route sends
      // requiresConfirmation: false. Pin it so a change here is deliberate.
      expect(agentTool.requiresConfirmation).toBe(false);
    });

    it('builds {agentId} context from a validated act_as_agent_id', async () => {
      mockFindAgentById.mockResolvedValue({ id: 'agent-1', name: 'Alpha' });

      const res = await request(app)
        .post('/api/tools/execute')
        .send({ name: 'echo_tool', input: {}, act_as_agent_id: 'agent-1' });

      expect(res.status).toBe(200);
      expect(mockFindAgentById).toHaveBeenCalledWith('agent-1');
      const [, agentTool, context] = mockExecute.mock.calls[0];
      expect(context).toEqual({ agentId: 'agent-1', bypassToolAccess: true });
      expect(agentTool.agentId).toBe('agent-1');
    });

    it.each([
      {
        wave: 'wave 1',
        legacyId: 'date_time',
        canonicalId: 'get_current_datetime',
        input: { timezone: 'UTC' },
      },
      {
        wave: 'wave 2',
        legacyId: 'workspace_search',
        canonicalId: 'search',
        input: { query: 'needle' },
      },
      {
        wave: 'wave 3',
        legacyId: 'google_gmail_search',
        canonicalId: 'google_gmail',
        input: { query: 'needle' },
      },
    ])(
      'resolves a retired $wave id through the public HTTP path without rewriting the executor call',
      async ({ legacyId, canonicalId, input }) => {
        mockFindToolById.mockImplementation(async (id: string) =>
          id === canonicalId ? { ...sampleTool, id: canonicalId } : null
        );

        const res = await request(app).post('/api/tools/execute').send({ name: legacyId, input });

        expect(res.status).toBe(200);
        expect(mockFindToolById.mock.calls.map(([id]) => id)).toEqual([legacyId, canonicalId]);
        const [call, agentTool] = mockExecute.mock.calls[0];
        expect(call).toEqual({ name: legacyId, input });
        expect(agentTool.tool.id).toBe(canonicalId);
      }
    );
  });

  describe('act_as validation', () => {
    it('rejects an unknown act_as_agent_id with 400 — never 404 (404 means "route unmounted" to ToolView)', async () => {
      mockFindAgentById.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/tools/execute')
        .send({ name: 'echo_tool', input: {}, act_as_agent_id: 'ghost' });

      expect(res.status).toBe(400);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('rejects agent_id + act_as_agent_id together (ambiguous principal)', async () => {
      const res = await request(app)
        .post('/api/tools/execute')
        .send({ name: 'echo_tool', input: {}, agent_id: 'a1', act_as_agent_id: 'a2' });

      expect(res.status).toBe(400);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('does not apply the acted-as agent tool-access policy — the human user is the principal', async () => {
      // shell_exec is a guarded tool (see toolPermission.ts) and this agent's
      // allow-list does not cover it — the agent itself calling would be
      // denied. act_as borrows the agent's context, not its identity, so the
      // user's run proceeds.
      mockFindToolById.mockResolvedValue({ ...sampleTool, id: 'shell_exec' });
      mockFindAgentById.mockResolvedValue({
        id: 'agent-1',
        name: 'Alpha',
        toolAccessMode: 'allow_list',
        toolAccessAllowList: ['some_other_tool'],
        toolAccessDenyList: [],
      });

      const res = await request(app)
        .post('/api/tools/execute')
        .send({ name: 'shell_exec', input: { command: 'echo hi' }, act_as_agent_id: 'agent-1' });

      expect(res.status).toBe(200);
      expect(mockExecute).toHaveBeenCalledTimes(1);
    });

    it('still applies the agent policy on the agent_id path (the agent is the caller)', async () => {
      // Same guarded tool + uncovering allow-list as above: the `ask` verdict
      // is a hard deny on this human-less route.
      mockFindToolById.mockResolvedValue({ ...sampleTool, id: 'shell_exec' });
      mockFindAgentById.mockResolvedValue({
        id: 'agent-1',
        name: 'Alpha',
        toolAccessMode: 'allow_list',
        toolAccessAllowList: ['some_other_tool'],
        toolAccessDenyList: [],
      });

      const res = await request(app)
        .post('/api/tools/execute')
        .send({ name: 'shell_exec', input: { command: 'echo hi' }, agent_id: 'agent-1' });

      expect(res.status).toBe(403);
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('dispatch-only tools', () => {
    it('allows action through to the executor-level gateway', async () => {
      // An agent_id with no agent row behind it is refused.
      mockFindAgentById.mockResolvedValue({ id: 'agent-1', name: 'Alpha' });
      mockFindToolById.mockResolvedValue({ ...sampleTool, id: 'action' });
      mockGetDefinition.mockImplementation((id: string) =>
        id === 'action' ? { id: 'action', dispatchOnly: true } : undefined
      );

      const res = await request(app)
        .post('/api/tools/execute')
        .send({
          name: 'action',
          input: { tool: 'echo_tool', params: { value: 'nested' } },
          agent_id: 'agent-1',
        });

      expect(res.status).toBe(200);
      expect(mockExecute).toHaveBeenCalledWith(
        {
          name: 'action',
          input: { tool: 'echo_tool', params: { value: 'nested' } },
        },
        expect.objectContaining({ tool: expect.objectContaining({ id: 'action' }) }),
        { agentId: 'agent-1', bypassToolAccess: false }
      );
    });

    it('still rejects non-action dispatch-only tools before their dead-end handlers', async () => {
      mockFindToolById.mockResolvedValue({ ...sampleTool, id: 'get_clarification' });
      mockGetDefinition.mockImplementation((id: string) =>
        id === 'get_clarification' ? { id: 'get_clarification', dispatchOnly: true } : undefined
      );

      const res = await request(app)
        .post('/api/tools/execute')
        .send({ name: 'get_clarification', input: { question: 'why?' } });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/live agent/i);
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/tools/execute — op-scoped aliases (saved hooks / SDK)', () => {
  let app: express.Application;
  const memoryTool = { ...sampleTool, id: 'memory', name: 'Memory' };

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tools', executionRoutes);
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
    // Only the canonical `memory` row exists; its alias ids have no rows.
    mockFindToolById.mockImplementation(async (id: string) =>
      id === 'memory' ? memoryTool : null
    );
    mockExecute.mockResolvedValue(sampleResult);
    mockGetDefinition.mockReturnValue(undefined);
  });

  function agentWith(allow: string[], deny: string[] = []) {
    mockFindAgentById.mockResolvedValue({
      id: 'agent-1',
      name: 'Alpha',
      toolAccessMode: allow.length > 0 ? 'allow_list' : 'deny_list',
      toolAccessAllowList: allow,
      toolAccessDenyList: deny,
    });
  }

  it('runs a hook calling an old id as its pinned op when that op is allowed', async () => {
    agentWith(['memory_save']);
    const res = await request(app)
      .post('/api/tools/execute')
      .send({ name: 'memory_save', input: { content: 'x' }, agent_id: 'agent-1' });
    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('refuses an old id whose op the agent was never allowed, naming allowed ops', async () => {
    agentWith(['memory_save']);
    const res = await request(app)
      .post('/api/tools/execute')
      .send({ name: 'memory_forget', input: { memory_id: 'm1' }, agent_id: 'agent-1' });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('Allowed ops: create');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('refuses the merged tool called with a denied op', async () => {
    agentWith([], ['memory_forget']);
    const res = await request(app)
      .post('/api/tools/execute')
      .send({ name: 'memory', input: { op: 'delete', memory_id: 'm1' }, agent_id: 'agent-1' });
    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('POST /api/tools/execute — narrow allow, broad deny (the per-call engine on this route)', () => {
  let app: express.Application;
  const gitTool = { ...sampleTool, id: 'git', name: 'Git', aliases: [] };
  const shellTool = { ...sampleTool, id: 'shell', name: 'Shell', aliases: ['terminal', 'bash'] };

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tools', executionRoutes);
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
    const rows: Record<string, unknown> = { git: gitTool, shell: shellTool, echo_tool: sampleTool };
    mockFindToolById.mockImplementation(async (id: string) => rows[id] ?? null);
    mockExecute.mockResolvedValue(sampleResult);
    mockGetDefinition.mockReturnValue(undefined);
  });

  function agentWith(mode: 'allow_list' | 'deny_list', list: string[]) {
    mockFindAgentById.mockResolvedValue({
      id: 'test-agent-a',
      name: 'Alpha',
      toolAccessMode: mode,
      toolAccessAllowList: mode === 'allow_list' ? list : [],
      toolAccessDenyList: mode === 'deny_list' ? list : [],
    });
  }
  const post = (name: string, input: Record<string, unknown>) =>
    request(app).post('/api/tools/execute').send({ name, input, agent_id: 'test-agent-a' });

  it('allow git_status runs git status but refuses git push, by either id', async () => {
    agentWith('allow_list', ['git_status']);
    expect((await post('git', { subcommand: 'status' })).status).toBe(200);
    const push = await post('git', { subcommand: 'push', remote: 'origin' });
    expect(push.status).toBe(403);
    expect(push.body.error.message).toContain('Allowed subcommand: status');
    expect((await post('git_push', { remote: 'origin' })).status).toBe(403);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('a bare deny on an unguarded tool is enforced here too', async () => {
    agentWith('deny_list', ['echo_tool']);
    expect((await post('echo_tool', {})).status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("a deny naming a tool's plain definition name (bash) denies the tool", async () => {
    agentWith('deny_list', ['bash']);
    expect((await post('shell', { op: 'run', cmd: 'ls' })).status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

describe('POST /api/tools/execute — the tool-visibility gate chat runs apply', () => {
  // echo_tool ("Echo") and other_tool are unguarded: no command, path or SQL
  // rule can name them, so the per-call engine alone allows any call to them
  // when no rule names them. Visibility is what keeps them off an allow-list
  // agent's hands.
  let app: express.Application;
  const otherTool = { ...sampleTool, id: 'other_tool', name: 'Other' };
  const rows: Record<string, unknown> = {
    echo_tool: sampleTool,
    other_tool: otherTool,
    action: { ...sampleTool, id: 'action', name: 'Action' },
    tool: { ...sampleTool, id: 'tool', name: 'Tools' },
    memory: { ...sampleTool, id: 'memory', name: 'Memory' },
  };

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // The real mount-site credential check, so the child-dispatch case below
    // runs exactly as a hook's or workspace tool's nested call does.
    app.use('/api/tools', toolDispatchAuthMiddleware, executionRoutes);
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
    mockFindToolById.mockImplementation(async (id: string) => rows[id] ?? null);
    mockExecute.mockResolvedValue(sampleResult);
    mockGetDefinition.mockImplementation((id: string) =>
      id === 'action' ? { id: 'action', dispatchOnly: true } : undefined
    );
    mockResolveHelperToolPolicy.mockResolvedValue(null);
  });

  function agentWith(
    mode: 'all' | 'allow_list' | 'deny_list' | null,
    list: string[] = [],
    extra: Record<string, unknown> = {}
  ) {
    mockFindAgentById.mockImplementation(async (id: string) =>
      id === 'test-agent-a'
        ? {
            id: 'test-agent-a',
            name: 'Test Agent A',
            toolAccessMode: mode,
            toolAccessAllowList: mode === 'allow_list' ? list : [],
            toolAccessDenyList: mode === 'deny_list' ? list : [],
            ...extra,
          }
        : null
    );
  }
  const panel = (body: Record<string, unknown>) =>
    request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ input: {}, ...body });
  const asAgent = (name: string, input: Record<string, unknown> = {}) =>
    panel({ name, input, agent_id: 'test-agent-a' });

  it('refuses an allow-list agent calling an unguarded tool its list does not name', async () => {
    agentWith('allow_list', ['other_tool']);

    const res = await asAgent('echo_tool', { value: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe(
      "Blocked by tool-access policy: `echo_tool` is not in this agent's tool list."
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('refuses the same call from a hook child bound to that agent (child-dispatch credential)', async () => {
    agentWith('allow_list', ['other_tool']);

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('test-agent-a', 'test-hook'))
      .send({ name: 'echo_tool', input: {} });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('`echo_tool` is not in this agent');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('runs a tool the allow list names, by id or by its exact display name', async () => {
    agentWith('allow_list', ['echo_tool']);
    expect((await asAgent('echo_tool')).status).toBe(200);
    agentWith('allow_list', ['Echo']);
    expect((await asAgent('echo_tool')).status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('keeps tool reachable for an allow-list agent, as chat does', async () => {
    agentWith('allow_list', ['other_tool']);
    expect((await asAgent('tool', { op: 'search', query: 'x' })).status).toBe(200);
  });

  it('leaves action itself to the executor gateway, which gates the target as the agent', async () => {
    agentWith('allow_list', ['other_tool']);

    const res = await asAgent('action', { tool: 'echo_tool', params: {} });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledWith(
      { name: 'action', input: { tool: 'echo_tool', params: {} } },
      expect.objectContaining({ tool: expect.objectContaining({ id: 'action' }) }),
      { agentId: 'test-agent-a', bypassToolAccess: false }
    );
  });

  it("keeps a deny-list agent's denies and runs everything else", async () => {
    agentWith('deny_list', ['echo_tool']);
    expect((await asAgent('echo_tool')).status).toBe(403);
    expect((await asAgent('other_tool')).status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it.each(['all', null] as const)(
    'leaves an agent in all mode (stored mode %p) unchanged: every tool runs',
    async (mode) => {
      agentWith(mode);
      expect((await asAgent('echo_tool')).status).toBe(200);
      expect((await asAgent('other_tool')).status).toBe(200);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    }
  );

  it('honors a bare deny left on an agent in all mode, as chat dispatch does', async () => {
    agentWith('all', [], { toolAccessDenyList: ['echo_tool', 'other_tool(x)'] });

    const res = await asAgent('echo_tool');

    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe(
      'Blocked by tool-access policy: `echo_tool` is denied for this agent (rule `echo_tool`).'
    );
    // A rule (an entry with a specifier) does nothing in all mode.
    expect((await asAgent('other_tool')).status).toBe(200);
  });

  it('act_as_agent_id skips the gate on purpose: the person at the panel is the principal', async () => {
    // Deliberate (see the route doc): act_as borrows the agent's context
    // (memory scope, per-agent MCP routing), not its permissions, and needs
    // full panel authority; the child-dispatch credential can never use it.
    agentWith('allow_list', ['other_tool']);

    const res = await panel({ name: 'echo_tool', act_as_agent_id: 'test-agent-a' });

    expect(res.status).toBe(200);
    expect(mockExecute.mock.calls[0]?.[2]).toEqual({
      agentId: 'test-agent-a',
      bypassToolAccess: true,
    });
  });

  it("judges a subagent helper by its orchestrator's access, as chat does", async () => {
    agentWith(null, [], { parentAgentId: 'test-agent-orchestrator' });
    mockResolveHelperToolPolicy.mockResolvedValue({
      access: { mode: 'allow_list', allowList: ['other_tool'], denyList: [] },
    });

    expect((await asAgent('echo_tool')).status).toBe(403);
    expect((await asAgent('other_tool')).status).toBe(200);
    expect(mockResolveHelperToolPolicy).toHaveBeenCalledWith(
      'test-agent-a',
      expect.objectContaining({ id: 'test-agent-a' })
    );
  });

  it('never lets a subagent helper run a tool helpers cannot have, whatever its mode', async () => {
    agentWith(null, [], { parentAgentId: 'test-agent-orchestrator' });

    const res = await asAgent('memory', { op: 'create', content: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('`memory`');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // An agent id that resolves to no agent row has no policy to
  // judge the call by, so the call is refused (403, like every other gate
  // refusal here), never run ungated.
  it('refuses an agent_id that names no agent instead of running ungated', async () => {
    agentWith('all');

    const res = await panel({ name: 'echo_tool', agent_id: 'test-agent-gone' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe(
      'Blocked by tool-access policy: no agent `test-agent-gone` exists (deleted, or never created), so `echo_tool` cannot run as it.'
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('refuses a child-dispatch token bound to an agent deleted after it was issued', async () => {
    agentWith('all');

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken('test-agent-gone', 'test-hook'))
      .send({ name: 'echo_tool', input: {} });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('no agent `test-agent-gone` exists');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // A tool a person runs (panel Run, `snaglet run` with no agent) and the
  // /execute/test sandbox mint a child token bound to ghost, so their nested
  // calls are judged by ghost's code-defined allow list (GHOST_TOOL_ACCESS),
  // never its row's stored access.
  it("runs a ghost-bound child's nested call by ghost's allow list", async () => {
    mockFindAgentById.mockImplementation(async (id: string) =>
      id === GHOST_AGENT_ID
        ? { id: GHOST_AGENT_ID, name: 'ghost', toolAccessMode: null, parentAgentId: null }
        : null
    );
    mockFindToolById.mockImplementation(async (id: string) =>
      id === 'table' ? { ...sampleTool, id: 'table', name: 'Table' } : (rows[id] ?? null)
    );
    const asGhostChild = (name: string, input: Record<string, unknown>) =>
      request(app)
        .post('/api/tools/execute')
        .set('X-Snaglet-Child-Dispatch-Token', mintChildDispatchToken(GHOST_AGENT_ID))
        .send({ name, input });

    const allowed = await asGhostChild('table', { op: 'read', table: 'tasks' });
    expect(allowed.status).toBe(200);
    expect(mockExecute.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ agentId: GHOST_AGENT_ID, bypassToolAccess: false })
    );

    const blocked = await asGhostChild('echo_tool', {});
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/^Blocked by tool-access policy: /);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('refuses action as an unknown agent too (the router exemption needs an agent)', async () => {
    agentWith('all');

    const res = await panel({
      name: 'action',
      input: { tool: 'echo_tool', params: {} },
      agent_id: 'test-agent-gone',
    });

    expect(res.status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('still runs a call with no agent id (a person or a local script is the principal)', async () => {
    agentWith('allow_list', ['other_tool']);

    expect((await panel({ name: 'echo_tool' })).status).toBe(200);
    expect(mockExecute.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe('POST /api/tools/execute — display names read as every path reads them', () => {
  // shell is guarded (command rules), so an allow decides the call here.
  let app: express.Application;
  const shellTool = { ...sampleTool, id: 'shell', name: 'Shell', aliases: ['terminal', 'bash'] };

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tools', executionRoutes);
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
    mockFindToolById.mockImplementation(async (id: string) => (id === 'shell' ? shellTool : null));
    mockExecute.mockResolvedValue(sampleResult);
    mockGetDefinition.mockReturnValue(undefined);
  });

  function agentWith(mode: 'allow_list' | 'deny_list', list: string[]) {
    mockFindAgentById.mockResolvedValue({
      id: 'test-agent-a',
      name: 'Test Agent A',
      toolAccessMode: mode,
      toolAccessAllowList: mode === 'allow_list' ? list : [],
      toolAccessDenyList: mode === 'deny_list' ? list : [],
    });
  }
  const runLs = () =>
    request(app)
      .post('/api/tools/execute')
      .send({ name: 'shell', input: { op: 'run', cmd: 'ls' }, agent_id: 'test-agent-a' });

  it('an allow naming the exact display name (Shell) allows the tool', async () => {
    agentWith('allow_list', ['Shell']);
    expect((await runLs()).status).toBe(200);
  });

  it('an allow naming the display name in another case, or a definition name, grants nothing', async () => {
    agentWith('allow_list', ['SHELL']);
    expect((await runLs()).status).toBe(403);
    agentWith('allow_list', ['bash']);
    expect((await runLs()).status).toBe(403);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it.each(['Shell', 'SHELL', 'Shell(ls)'])(
    'a deny naming the display name in any case (%s) denies the tool',
    async (entry) => {
      agentWith('deny_list', [entry]);
      expect((await runLs()).status).toBe(403);
      expect(mockExecute).not.toHaveBeenCalled();
    }
  );
});

// The /execute/test sandbox writes the vendored runtime (SDK_RUNTIME_SOURCE)
// to disk as its @snaglet/sdk, the same SDK a deployed tool is bundled with.
describe('the @snaglet/sdk the /execute/test sandbox writes (SDK_RUNTIME_SOURCE)', () => {
  it('never embeds a token literal — reads SNAGLET_CHILD_DISPATCH_TOKEN from the child process env at runtime', () => {
    expect(SDK_RUNTIME_SOURCE).not.toContain(getPanelToken());
    // /execute/test's sandbox spawn always mints a token bound to ghost
    // (unsaved code has no agent; see execution.routes.ts), so that's the
    // exact value that would ever be in play here, and the one asserted
    // absent from the written source.
    expect(SDK_RUNTIME_SOURCE).not.toContain(mintChildDispatchToken(GHOST_AGENT_ID));
    expect(SDK_RUNTIME_SOURCE).toContain('process.env.SNAGLET_CHILD_DISPATCH_TOKEN');
    expect(SDK_RUNTIME_SOURCE).toContain('X-Snaglet-Child-Dispatch-Token');
    // The runtime never names the panel token: the whole panel-token
    // vocabulary is absent from the written source.
    expect(SDK_RUNTIME_SOURCE).not.toContain('SNAGLET_PANEL_TOKEN');
    expect(SDK_RUNTIME_SOURCE).not.toContain('X-Snaglet-Panel-Token');
  });

  // A nested call the server refuses (in the sandbox: a tool outside ghost's
  // allow list) throws with the server's own refusal message rather than
  // returning `undefined` (which would surface later as an opaque TypeError).
  // The tool test console keys its friendly explanation on that text.
  describe('a refused call throws with the server message', () => {
    const REFUSAL = {
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: "Blocked by tool-access policy: `some_tool` is not in this agent's tool list.",
      },
    };
    const stubFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify(REFUSAL),
      json: async () => REFUSAL,
    });
    type Sdk = {
      tools: { execute: (name: string) => Promise<unknown> };
      tables: { read: (input: Record<string, unknown>) => Promise<unknown> };
    };
    // The source is ESM (the sandbox imports it as @snaglet/sdk); jest's runtime
    // can't dynamically import a runtime-written file, so evaluate it with
    // its export statements stripped and a stub fetch injected.
    function loadSdk(): Sdk {
      const source = SDK_RUNTIME_SOURCE.replace('export const snaglet =', 'const snaglet =')
        .replace('export function defineHook', 'function defineHook')
        .replace('export const HOOK_EVENT_NAMES', 'const HOOK_EVENT_NAMES')
        .replace('export default snaglet;', '');
      return (new Function('fetch', `${source}\nreturn snaglet;`) as (f: typeof stubFetch) => Sdk)(
        stubFetch
      );
    }

    beforeEach(() => {
      process.env.SNAGLET_SERVER_URL = 'http://127.0.0.1:4999';
    });
    afterEach(() => {
      delete process.env.SNAGLET_SERVER_URL;
    });

    it('snaglet.tools.execute', async () => {
      await expect(loadSdk().tools.execute('some_tool')).rejects.toThrow(
        /^Snaglet server returned 403: .*Blocked by tool-access policy: `some_tool` is not in this agent's tool list\./
      );
    });

    it('snaglet.tables.read (the call the panel Run report failed on)', async () => {
      await expect(loadSdk().tables.read({ table: 'tasks' })).rejects.toThrow(
        /^Snaglet server returned 403: .*Blocked by tool-access policy/
      );
    });
  });
});

describe('POST /api/tools/execute/test — sandbox never writes a token to disk', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/tools', executionRoutes);
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
    // First spawn() call is `npx esbuild ...`; second is
    // `node runner.js`. Both fake an instant, successful
    // exit — the point of these tests is the token-handling logic around the
    // spawns, not exercising real esbuild/node.
    mockSpawn.mockImplementation((command: string) => {
      if (command === 'npx') return makeFakeChild('', 0);
      return makeFakeChild('test-output', 0);
    });
  });

  it('does not write the panel token or the child-dispatch token to any file in the sandbox', async () => {
    const res = await request(app)
      .post('/api/tools/execute/test')
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const panelToken = getPanelToken();
    const childDispatchToken = mintChildDispatchToken(GHOST_AGENT_ID);
    expect(mockWriteFileSync.mock.calls.length).toBeGreaterThan(0);
    for (const call of mockWriteFileSync.mock.calls) {
      const content = String(call[1]);
      expect(content).not.toContain(panelToken);
      expect(content).not.toContain(childDispatchToken);
    }
  });

  it("passes SNAGLET_CHILD_DISPATCH_TOKEN (never SNAGLET_PANEL_TOKEN) via the runner child's env", async () => {
    const res = await request(app)
      .post('/api/tools/execute/test')
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(200);

    const runnerCall = mockSpawn.mock.calls.find(
      (call) =>
        call[0] === process.execPath && Array.isArray(call[1]) && call[1].includes('runner.js')
    );
    expect(runnerCall).toBeDefined();
    const env = runnerCall?.[2]?.env as Record<string, string | undefined>;
    expect(env.SNAGLET_CHILD_DISPATCH_TOKEN).toBeDefined();
    expect(env.SNAGLET_PANEL_TOKEN).toBeUndefined();
  });

  // snaglet.tables.read, parseContent, hooks.run and emit work under Test because
  // the sandbox's @snaglet/sdk is the deployed tools' own runtime, not a shim.
  it('writes the same @snaglet/sdk a deployed tool gets as the sandbox module', async () => {
    const res = await request(app)
      .post('/api/tools/execute/test')
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(200);
    const sdkWrites = mockWriteFileSync.mock.calls.filter((call) =>
      String(call[0]).endsWith(['node_modules', '@snaglet', 'sdk', 'index.js'].join(path.sep))
    );
    expect(sdkWrites).toHaveLength(1);
    expect(sdkWrites[0]?.[1]).toBe(SDK_RUNTIME_SOURCE);
  });

  // `node --input-type=module runner.js` never started: Node refuses
  // --input-type with a file entry point (ERR_INPUT_TYPE_NOT_ALLOWED). The
  // runner is a plain entry in a declared ESM package (no reliance on syntax
  // detection or an ancestor package.json), and ESM imports need the file
  // extension.
  it('starts the runner as a plain ESM entry that imports the bundle by its full name', async () => {
    const res = await request(app)
      .post('/api/tools/execute/test')
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(200);
    const runnerCall = mockSpawn.mock.calls.find((call) => call[0] === process.execPath);
    expect(runnerCall?.[1]).toEqual(['runner.js']);
    // ESM resolution ignores NODE_PATH, so the env does not carry it.
    expect(runnerCall?.[2]?.env).not.toHaveProperty('NODE_PATH');
    const runnerWrite = mockWriteFileSync.mock.calls.find((call) =>
      String(call[0]).endsWith(`${path.sep}runner.js`)
    );
    expect(String(runnerWrite?.[1])).toContain("import handler from './dist/tool.js';");
    // The package scope lookup stops at node_modules, so the SDK declares its own.
    const packageWrites = mockWriteFileSync.mock.calls
      .filter((call) => String(call[0]).endsWith(`${path.sep}package.json`))
      .map((call) => [path.basename(path.dirname(String(call[0]))), JSON.parse(String(call[1]))]);
    expect(packageWrites).toEqual([
      [expect.stringMatching(/^snaglet-tool-test-/), { type: 'module' }],
      ['sdk', { name: '@snaglet/sdk', type: 'module', main: 'index.js' }],
    ]);
  });

  // Unsaved code has no agent, so its nested calls act as the ghost system
  // actor, exactly as a saved tool a person runs does (ToolExecutor): code that
  // passes Test runs the same once deployed. A token bound to no agent would
  // be refused by /execute on every nested call.
  it('binds the runner child token to the ghost system actor, never to no agent', async () => {
    const res = await request(app)
      .post('/api/tools/execute/test')
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(200);
    const runnerCall = mockSpawn.mock.calls.find(
      (call) =>
        call[0] === process.execPath && Array.isArray(call[1]) && call[1].includes('runner.js')
    );
    const env = runnerCall?.[2]?.env as Record<string, string | undefined>;
    expect(verifyChildDispatchToken(env.SNAGLET_CHILD_DISPATCH_TOKEN ?? '')).toEqual({
      agentId: GHOST_AGENT_ID,
    });
    expect(env.SNAGLET_CHILD_DISPATCH_TOKEN).not.toBe(mintChildDispatchToken());
  });

  it('bundles with the login-shell PATH and runs the tool the way a deployed tool runs', async () => {
    const res = await request(app)
      .post('/api/tools/execute/test')
      .send({ code: 'export default async () => "hi";' });

    expect(res.status).toBe(200);
    const paths = Object.fromEntries(
      mockSpawn.mock.calls.map((call) => [
        String(call[0]),
        (call[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env?.PATH,
      ])
    );
    // The runner is ToolExecutor's: the server's own node, the inherited PATH.
    expect(paths).toEqual({ npx: mockLoginPath, [process.execPath]: process.env.PATH });
  });
});
