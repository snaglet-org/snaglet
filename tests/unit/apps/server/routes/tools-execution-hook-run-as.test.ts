/**
 * POST /api/tools/execute from a hook child — run as, ask-first calls
 * and structured results. A hook set to run as an agent spawns with a
 * child-dispatch credential bound to that agent and a signed `runAs` flag
 * (hookRunner.ts). On the way back in, the call is judged by that agent's own
 * tool access (never ghost's, never wider); an ask-first tool or op is skipped
 * with a tool error since nobody can answer; only run as makes that agent the
 * ambient actor (table history, change-log); and SDK callers get
 * `structuredResult` on the handler context while a person at the panel does
 * not.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import type { Actor } from '@snaglet/shared/types/workspace-events';

const mockFindToolById = jest.fn();
const mockFindAgentById = jest.fn();
const mockExecute = jest.fn();

jest.mock('@snaglet/db/tables/tools', () => ({
  Tools: { findById: (id: string) => mockFindToolById(id) },
}));
jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: { findById: (id: string) => mockFindAgentById(id) },
}));
jest.mock('@server/services/ToolService/ToolExecutor', () => ({
  toolExecutor: { execute: (...args: unknown[]) => mockExecute(...args) },
}));
jest.mock('@server/services/subagents/helperInheritance', () => ({
  resolveHelperToolPolicy: async () => null,
}));
/** Ops the acting agent set to ask first, by tool id. */
const askFirst: Record<string, Record<string, boolean>> = {};
jest.mock('@server/services/AgentToolResolver', () => ({
  resolveAgentToolsForExecution: async (
    _agentId: string,
    options: { threadOverrides?: Record<string, { requiresConfirmation?: boolean }> } = {}
  ) => {
    const ids = new Set([...Object.keys(askFirst), ...Object.keys(options.threadOverrides ?? {})]);
    return [...ids].map((id) => {
      const opConfirmation = askFirst[id] ?? {};
      const threadAsks = options.threadOverrides?.[id]?.requiresConfirmation === true;
      return {
        agentId: 'test-agent-a',
        tool: { id },
        settings: {},
        requiresConfirmation: threadAsks || Object.values(opConfirmation).some(Boolean),
        opConfirmation: threadAsks ? undefined : opConfirmation,
      };
    });
  },
  confirmationForCall: (
    target: { requiresConfirmation: boolean; opConfirmation?: Record<string, boolean> },
    input: Record<string, unknown>
  ) =>
    typeof input.op === 'string' && target.opConfirmation && input.op in target.opConfirmation
      ? target.opConfirmation[input.op]
      : target.requiresConfirmation,
}));
/** Per-thread "ask first" overrides for test-agent-a, by thread id. */
const threadAsksFirst: Record<string, string[]> = {};
jest.mock('@server/services/ConfigResolverService', () => ({
  resolveThreadRuntimeConfig: async (threadId: string) => ({
    agentOverrides: new Map([
      [
        'test-agent-a',
        {
          toolOverrides: Object.fromEntries(
            (threadAsksFirst[threadId] ?? []).map((id) => [id, { requiresConfirmation: true }])
          ),
        },
      ],
    ]),
  }),
}));
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn(async () => undefined),
    getDefinition: () => undefined,
    getToolIds: () => ['table', 'echo_tool'],
  },
}));

import executionRoutes from '@server/domains/tools/routes/execution.routes';
import {
  getPanelToken,
  mintChildDispatchToken,
  toolDispatchAuthMiddleware,
} from '@server/middleware/panelAuth';
import { getCurrentActor } from '@server/realtime/actorContext';
import { GHOST_AGENT_ID } from '@snaglet/shared/constants/systemAgents';

const AGENT_A = 'test-agent-a';

const tableTool = {
  id: 'table',
  name: 'Table',
  description: 'Tables',
  type: 'builtin',
  enabled: true,
  parameters_schema: {},
  config_json: {},
};

interface Seen {
  actor: Actor | undefined;
  context: Record<string, unknown> | undefined;
}

let app: express.Application;
let seen: Seen[];

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use('/api/tools', toolDispatchAuthMiddleware, executionRoutes);
  app.use(
    (
      err: { statusCode?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      res.status(err.statusCode ?? 500).json({ error: { message: err.message } });
    }
  );
});

function agentA(mode: 'all' | 'allow_list', allowList: string[] = []) {
  mockFindAgentById.mockImplementation(async (id: unknown) => {
    if (id === AGENT_A) {
      return {
        id: AGENT_A,
        name: 'Test Agent A',
        toolAccessMode: mode,
        toolAccessAllowList: allowList,
        toolAccessDenyList: [],
        parentAgentId: null,
      };
    }
    if (id === GHOST_AGENT_ID) {
      return { id: GHOST_AGENT_ID, name: 'ghost', toolAccessMode: null, parentAgentId: null };
    }
    return null;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seen = [];
  for (const id of Object.keys(askFirst)) delete askFirst[id];
  for (const id of Object.keys(threadAsksFirst)) delete threadAsksFirst[id];
  mockFindToolById.mockImplementation(async (id: unknown) => (id === 'table' ? tableTool : null));
  mockExecute.mockImplementation(async (...args: unknown[]) => {
    seen.push({
      actor: getCurrentActor(),
      context: args[2] as Record<string, unknown> | undefined,
    });
    return { success: true, output: 'ok', durationMs: 1 };
  });
});

const fromHook = (
  agentId: string,
  { runAs = false, input = { op: 'read', table: 'tasks' } as Record<string, unknown> } = {}
) =>
  request(app)
    .post('/api/tools/execute')
    .set(
      'X-Snaglet-Child-Dispatch-Token',
      mintChildDispatchToken(agentId, 'test-hook', 1, ['test-hook'], false, runAs)
    )
    .send({ name: 'table', input });

describe('a hook child acting as an agent', () => {
  it('under run as, writes as that agent and gets structured results', async () => {
    agentA('all');

    const res = await fromHook(AGENT_A, { runAs: true });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].actor).toEqual({
      actorKind: 'agent',
      actorId: AGENT_A,
      actorName: 'Test Agent A',
    });
    expect(seen[0].context).toMatchObject({
      agentId: AGENT_A,
      hookOrigin: { kind: 'hook', hookName: 'test-hook' },
      hookRunAs: true,
      structuredResult: true,
    });
  });

  it("acting as the event's agent without run as keeps the request's actor (attribution is opt-in)", async () => {
    agentA('all');

    const res = await fromHook(AGENT_A);

    expect(res.status).toBe(200);
    expect(seen[0].actor).toBeUndefined();
    expect(seen[0].context).not.toHaveProperty('hookRunAs');
  });

  it('skips a call to an op the agent set to ask first, with or without run as', async () => {
    agentA('all');
    askFirst.table = { read: false, write: true };

    for (const runAs of [true, false]) {
      const res = await fromHook(AGENT_A, {
        runAs,
        input: { op: 'write', table: 'tasks', insert: [] },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(false);
      expect(res.body.data.error).toContain("Tool 'table (write)' was not run");
    }
    expect(mockExecute).not.toHaveBeenCalled();

    // The same agent's op that does not ask still runs.
    expect((await fromHook(AGENT_A, { runAs: true })).status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it("honors an 'ask first' set on the hook run's thread", async () => {
    agentA('all');
    threadAsksFirst['thread-1111111111111-aaaaaaaaa'] = ['table'];
    const call = (threadId?: string) =>
      request(app)
        .post('/api/tools/execute')
        .set(
          'X-Snaglet-Child-Dispatch-Token',
          mintChildDispatchToken(AGENT_A, 'test-hook', 1, ['test-hook'], false, true, threadId)
        )
        .send({ name: 'table', input: { op: 'read', table: 'tasks' } });

    const inThread = await call('thread-1111111111111-aaaaaaaaa');
    expect(inThread.body.data.success).toBe(false);
    expect(inThread.body.data.error).toContain('was not run');
    expect(mockExecute).not.toHaveBeenCalled();

    // Another thread (or none) has no such setting: the call runs.
    expect((await call('thread-2222222222222-bbbbbbbbb')).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it("is judged by that agent's own access, never the system actor's", async () => {
    // ghost may call `table`; an agent whose allow list names nothing may not.
    agentA('allow_list', []);

    const res = await fromHook(AGENT_A, { runAs: true });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('Blocked by tool-access policy');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('a ghost run keeps the ambient actor and the system policy', async () => {
    agentA('all');

    const res = await fromHook(GHOST_AGENT_ID);

    expect(res.status).toBe(200);
    expect(seen[0].actor).toBeUndefined();
    expect(seen[0].context).toMatchObject({ agentId: GHOST_AGENT_ID, structuredResult: true });
  });

  it('a person at the panel gets no structured flag', async () => {
    agentA('all');

    const res = await request(app)
      .post('/api/tools/execute')
      .set('X-Snaglet-Panel-Token', getPanelToken())
      .send({ name: 'table', input: { op: 'read' }, agent_id: AGENT_A });

    expect(res.status).toBe(200);
    expect(seen[0].context).not.toHaveProperty('structuredResult');
    expect(seen[0].actor).toBeUndefined();
  });
});
