/**
 * POST /api/mcp/servers/:id/install — the MCP pane's Update. The route hands
 * the server id to McpService.updateInstall and returns its result with the
 * refreshed, decorated row (install line included). It is a person's action:
 * the agent `mcp` tool has no op for it. McpService and the DB models are
 * mocked at their module seams.
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const findServer = jest.fn<(id: string) => Promise<Record<string, unknown> | null>>();
jest.mock('@snaglet/db', () => ({
  McpServers: { findServer: (id: string) => findServer(id), listAll: async () => [] },
}));
jest.mock('@snaglet/db/tables/user_provider_credentials', () => ({
  UserProviderCredentials: { findByProviderId: async () => null },
}));

const updateInstall = jest.fn<(id: string) => Promise<Record<string, unknown>>>();
const installInfo = {
  state: 'installed',
  packageName: 'test-mcp-pkg',
  requested: null,
  installedVersion: '2.1.0',
  installedAt: '2026-01-01T00:00:00.000Z',
  reason: null,
  lastError: null,
  updatable: true,
};
jest.mock('@server/services/McpService', () => ({
  mcpService: {
    updateInstall: (id: string) => updateInstall(id),
    getInstallInfo: async () => installInfo,
    getStatus: () => 'connected',
    getStatusDetail: () => null,
    requiresCredential: () => false,
    getCredentialSpec: () => ({ requiresSecret: false, bundleFields: [] }),
    reload: async () => undefined,
  },
}));
jest.mock('@server/services/McpService/mcpServerConfig', () => ({
  createMcpServer: jest.fn(),
  deleteMcpServer: jest.fn(),
  mcpCredKeyFor: (row: { id: string; providerId: string | null }) => row.providerId ?? row.id,
  restoreMcpServer: jest.fn(),
  setMcpServerCredential: jest.fn(),
  syncMcpServer: jest.fn(),
  updateMcpServer: jest.fn(),
}));
jest.mock('@server/services/ProviderCredentialService', () => ({ providerCredentialService: {} }));
jest.mock('@server/services/AgentService', () => ({ agentService: { list: async () => [] } }));

import mcpRouter from '@server/routes/mcp';
import { errorHandler } from '@server/middleware';
import mcpToolDefinition from '@server/services/ToolService/tools/agents/mcp/definition';

function app(): express.Application {
  const a = express();
  a.use(express.json());
  a.use('/api/mcp', mcpRouter);
  a.use(errorHandler);
  return a;
}

const row = {
  id: 'test-server-a',
  providerId: null,
  name: 'Test Server A',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'test-mcp-pkg'],
  url: null,
  headers: {},
  env: {},
  scope: 'shared',
  enabled: true,
  autoload: false,
  requiresConfirmation: true,
  source: 'user',
};

beforeEach(() => {
  findServer.mockReset();
  updateInstall.mockReset();
});

describe('POST /api/mcp/servers/:id/install', () => {
  it('runs the update and returns its result with the refreshed row', async () => {
    findServer.mockResolvedValue(row);
    updateInstall.mockResolvedValue({
      ok: true,
      previousVersion: '2.0.0',
      installedVersion: '2.1.0',
      restarted: true,
    });

    const res = await request(app()).post('/api/mcp/servers/test-server-a/install');

    expect(res.status).toBe(200);
    expect(updateInstall).toHaveBeenCalledWith('test-server-a');
    expect(res.body.data).toMatchObject({
      ok: true,
      previousVersion: '2.0.0',
      installedVersion: '2.1.0',
      restarted: true,
      server: { id: 'test-server-a', status: 'connected', install: installInfo },
    });
  });

  it('reports a failed install as a result, not an HTTP error', async () => {
    findServer.mockResolvedValue(row);
    updateInstall.mockResolvedValue({
      ok: false,
      previousVersion: '2.0.0',
      installedVersion: '2.0.0',
      restarted: false,
      error: "npm wasn't found on PATH",
    });

    const res = await request(app()).post('/api/mcp/servers/test-server-a/install');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ ok: false, error: "npm wasn't found on PATH" });
  });

  it('404s for an unknown server without touching the install', async () => {
    findServer.mockResolvedValue(null);

    const res = await request(app()).post('/api/mcp/servers/test-server-gone/install');

    expect(res.status).toBe(404);
    expect(updateInstall).not.toHaveBeenCalled();
  });

  it('is not an op of the agent mcp tool', () => {
    const op = (
      mcpToolDefinition.parameters_schema.properties as Record<string, { enum?: string[] }>
    ).op;
    expect(op?.enum).toEqual([
      'list',
      'get',
      'create',
      'update',
      'delete',
      'restore',
      'test',
      'set_credential',
    ]);
  });
});
