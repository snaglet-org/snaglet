/**
 * New-agent creation × guarded confirmation defaults — through the two real
 * public entry points (both funnel into agentService.create):
 *
 *   1. POST /api/agents (the UI create route), mounted with the real
 *      AgentService and only the DB/table layer mocked.
 *   2. The create_agent builtin tool handler, invoked the way ToolExecutor
 *      invokes it (tests/support/toolHarness).
 *
 * Both must persist per-tool `requiresConfirmation: true` overrides for the
 * guarded set (call-time-guarded kinds + destructive builtins), and an
 * explicit caller override must win over the default.
 */

import request from 'supertest';
import express from 'express';

const mockListAgents = jest.fn();
const mockFindAgentById = jest.fn();
const mockFindAgentByName = jest.fn();
const mockCreateAgent = jest.fn();

jest.mock('@snaglet/db/tables/agents', () => ({
  Agents: {
    list: mockListAgents,
    findById: mockFindAgentById,
    findByName: mockFindAgentByName,
    create: mockCreateAgent,
  },
}));

jest.mock('@snaglet/db/tables/models', () => ({
  Models: {
    findByProviderAndModelId: jest.fn().mockResolvedValue({ maxOutputTokens: 8192 }),
  },
}));

// Controlled registry for the guarded-set derivation.
jest.mock('@server/services/ToolService/ToolRegistry', () => ({
  toolRegistry: {
    load: jest.fn().mockResolvedValue(undefined),
    getAllDefinitions: jest.fn().mockReturnValue({
      delete_doc: { id: 'delete_doc', destructive: true },
      file_read: { id: 'file_read' },
    }),
  },
}));

// Fire-and-forget hook payload builder reads the DB — inert here.
jest.mock('@server/services/customHooks/agentCreateEvent', () => ({
  emitAgentCreate: jest.fn(),
}));

// Route-level collaborators (same seams the existing routes test mocks).
jest.mock('@server/realtime/surfaces/agents', () => ({
  emitAgentCreated: jest.fn(),
  emitAgentDeleted: jest.fn(),
  emitAgentUpdated: jest.fn(),
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: { getSafeById: jest.fn() },
}));

import agentsRouter from '@server/domains/agents/agents.routes';
import { agentService } from '@server/services/AgentService';
import createAgentHandler from '@server/services/ToolService/handlers/agents/createAgent';
import { runTool } from '../../../../support/toolHarness';
import { GUARDED_TOOL_KINDS } from '@snaglet/shared/utils';

function makeAgentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'newbot',
    name: 'NewBot',
    role: 'Helper',
    avatarUrl: null,
    credentialId: null,
    modelId: 'claude-sonnet-4-5',
    systemPrompt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

type Overrides = Record<string, { requiresConfirmation?: boolean }>;

function createdOverrides(): Overrides {
  expect(mockCreateAgent).toHaveBeenCalledTimes(1);
  return (mockCreateAgent.mock.calls[0][0] as { toolOverrides: Overrides }).toolOverrides;
}

function expectGuarded(overrides: Overrides): void {
  for (const toolId of Object.keys(GUARDED_TOOL_KINDS)) {
    expect(overrides[toolId]).toEqual({ requiresConfirmation: true });
  }
  expect(overrides.delete_doc).toEqual({ requiresConfirmation: true });
  expect(overrides.file_read).toBeUndefined();
}

describe('guarded defaults at agent creation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Non-empty roster: ensureDefaults never seeds in these tests.
    mockListAgents.mockResolvedValue([makeAgentRow({ id: 'existing', name: 'Existing' })]);
    mockFindAgentById.mockResolvedValue(null);
    mockFindAgentByName.mockResolvedValue(null);
    mockCreateAgent.mockImplementation(async (input: Record<string, unknown>) =>
      makeAgentRow(input)
    );
  });

  describe('via POST /api/agents (real route + real AgentService)', () => {
    let app: express.Application;

    beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use('/api/agents', agentsRouter);
      app.use(
        (
          err: { statusCode?: number; code?: string; message?: string },
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction
        ) => {
          res
            .status(err.statusCode || 500)
            .json({ error: { code: err.code, message: err.message } });
        }
      );
    });

    it('persists guarded requiresConfirmation overrides for a plain create body', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'NewBot', role: 'Helper', provider: 'anthropic' });

      expect(res.status).toBe(201);
      expectGuarded(createdOverrides());
    });
  });

  describe('via the create_agent builtin tool', () => {
    it('persists guarded requiresConfirmation overrides', async () => {
      const result = await runTool<{ success: boolean; agent_id: string }>(createAgentHandler, {
        name: 'ToolBot',
        role: 'Helper',
      });

      expect(result.success).toBe(true);
      expectGuarded(createdOverrides());
    });
  });

  describe('explicit caller overrides win over the default', () => {
    it('keeps an explicit requiresConfirmation:false through agentService.create', async () => {
      await agentService.create({
        name: 'TrustedBot',
        role: 'Helper',
        provider: 'anthropic',
        modelId: null,
        credentialId: null,
        identity: null,
        rawSystemPrompt: null,
        systemPrompt: '',
        toolAccessMode: null,
        toolAccessAllowList: null,
        toolAccessDenyList: null,
        mcpServers: null,
        toolOverrides: { shell_exec: { requiresConfirmation: false } },
        maxToolCallsPerTurn: null,
        maxDurationSeconds: null,
        fallbacks: null,
        disableModelFallback: false,
      } as Parameters<typeof agentService.create>[0]);

      const overrides = createdOverrides();
      expect(overrides.shell_exec).toEqual({ requiresConfirmation: false });
      // siblings still get the default
      expect(overrides.file_write).toEqual({ requiresConfirmation: true });
    });
  });
});
