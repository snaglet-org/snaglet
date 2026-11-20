/**
 * deleteMcpServer keeps the deleted row, the pruned agent ids and who deleted
 * it in server memory for MCP_SERVER_UNDO_WINDOW_MS, and restoreMcpServer
 * replays exactly that snapshot: for a person always, for an agent only when
 * that agent made the delete. Both announce `agent.updated` for every agent
 * whose servers changed. The install folder of an npx server is removed only
 * once the window has passed without a restore. The model seam (McpServers),
 * the live-connection service and the realtime surface are mocked; the DB
 * side of delete and restore has its own integration test.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { McpServerRow } from '@snaglet/db/tables/mcp_servers';

const mockRemove = jest.fn<(id: string) => Promise<unknown>>();
const mockRestore =
  jest.fn<(server: McpServerRow, agentIds: readonly string[]) => Promise<unknown>>();
jest.mock('@snaglet/db', () => ({
  McpServers: {
    removeAndPruneAgents: mockRemove,
    restoreAndRegrantAgents: mockRestore,
    findServer: jest.fn(async () => null),
  },
}));
jest.mock('@snaglet/db/tables/providers', () => ({
  Providers: { findById: jest.fn(async () => null) },
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {},
}));
const mockEmitAgentUpdated = jest.fn<(agentId: string, changed: string[]) => void>();
jest.mock('@server/realtime/surfaces/agents', () => ({
  emitAgentUpdated: mockEmitAgentUpdated,
}));
const mockSync = jest.fn(async () => undefined);
const mockRemoveInstall = jest.fn<(id: string) => Promise<void>>(async () => undefined);
jest.mock('@server/services/McpService', () => ({
  mcpService: {
    disconnect: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    syncFromProvider: mockSync,
    removeInstall: mockRemoveInstall,
  },
}));

import {
  MCP_SERVER_UNDO_WINDOW_MS,
  deleteMcpServer,
  restoreMcpServer,
  type McpServerActor,
} from '@server/services/McpService/mcpServerConfig';

const PERSON: McpServerActor = { kind: 'person' };
const AGENT_A: McpServerActor = { kind: 'agent', agentId: 'test-agent-a' };
const AGENT_B: McpServerActor = { kind: 'agent', agentId: 'test-agent-b' };

const server: McpServerRow = {
  id: 'test-server',
  providerId: null,
  name: 'Test server',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'test-mcp'],
  url: null,
  headers: {},
  env: { API_TOKEN: 'test-secret-value' },
  scope: 'shared',
  enabled: true,
  autoload: false,
  requiresConfirmation: true,
  source: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockRemove.mockResolvedValue({
    removed: true,
    agentsPruned: 1,
    server,
    prunedAgentIds: ['test-agent-a'],
  });
  mockRestore.mockResolvedValue({
    restored: true,
    agentsRestored: 1,
    restoredAgentIds: ['test-agent-a'],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('MCP server delete + undo', () => {
  it('reports the delete without the config', async () => {
    const result = await deleteMcpServer(server.id, PERSON);

    expect(result).toEqual({ id: server.id, removed: true, agentsPruned: 1 });
  });

  it('restores the snapshot it kept: the deleted row and the pruned agents', async () => {
    await deleteMcpServer(server.id, PERSON);

    const result = await restoreMcpServer(server.id, PERSON);

    expect(result).toEqual({ id: server.id, restored: true, agentsRestored: 1 });
    expect(mockRestore).toHaveBeenCalledWith(server, ['test-agent-a']);
    expect(mockSync).toHaveBeenCalledWith(server.id);
    // The snapshot is spent: a second undo has nothing to restore.
    await expect(restoreMcpServer(server.id, PERSON)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('stays restorable just inside the window and not after it', async () => {
    await deleteMcpServer(server.id, PERSON);
    jest.advanceTimersByTime(MCP_SERVER_UNDO_WINDOW_MS - 1);
    await expect(restoreMcpServer(server.id, PERSON)).resolves.toMatchObject({ restored: true });

    await deleteMcpServer(server.id, PERSON);
    jest.advanceTimersByTime(MCP_SERVER_UNDO_WINDOW_MS);
    await expect(restoreMcpServer(server.id, PERSON)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockRestore).toHaveBeenCalledTimes(1);
  });

  it('removes the install folder only when the window passes without a restore', async () => {
    await deleteMcpServer(server.id, PERSON);
    jest.advanceTimersByTime(MCP_SERVER_UNDO_WINDOW_MS - 1);
    expect(mockRemoveInstall).not.toHaveBeenCalled();
    await restoreMcpServer(server.id, PERSON);
    jest.advanceTimersByTime(MCP_SERVER_UNDO_WINDOW_MS);
    expect(mockRemoveInstall).not.toHaveBeenCalled();

    await deleteMcpServer(server.id, PERSON);
    jest.advanceTimersByTime(MCP_SERVER_UNDO_WINDOW_MS);
    expect(mockRemoveInstall).toHaveBeenCalledTimes(1);
    expect(mockRemoveInstall).toHaveBeenCalledWith(server.id);
  });

  it('a newer delete of the same id replaces the older snapshot and its timer', async () => {
    await deleteMcpServer(server.id, PERSON);
    jest.advanceTimersByTime(MCP_SERVER_UNDO_WINDOW_MS - 1);
    const renamed = { ...server, name: 'Renamed server' };
    mockRemove.mockResolvedValueOnce({
      removed: true,
      agentsPruned: 0,
      server: renamed,
      prunedAgentIds: [],
    });
    await deleteMcpServer(server.id, PERSON);
    // The first delete's timer would have fired here.
    jest.advanceTimersByTime(1);

    await restoreMcpServer(server.id, PERSON);

    expect(mockRestore).toHaveBeenCalledWith(renamed, []);
  });

  it('lets an agent restore a server it deleted itself', async () => {
    await deleteMcpServer(server.id, AGENT_A);

    await expect(restoreMcpServer(server.id, AGENT_A)).resolves.toEqual({
      id: server.id,
      restored: true,
      agentsRestored: 1,
    });
    expect(mockRestore).toHaveBeenCalledWith(server, ['test-agent-a']);
  });

  it("refuses an agent restoring another agent's or a person's delete, and keeps it for them", async () => {
    await deleteMcpServer(server.id, AGENT_B);
    await expect(restoreMcpServer(server.id, AGENT_A)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(/deleted by someone else/),
    });
    // The deleting agent can still undo it.
    await expect(restoreMcpServer(server.id, AGENT_B)).resolves.toMatchObject({ restored: true });

    await deleteMcpServer(server.id, PERSON);
    await expect(restoreMcpServer(server.id, AGENT_A)).rejects.toMatchObject({ statusCode: 403 });
    await expect(restoreMcpServer(server.id, PERSON)).resolves.toMatchObject({ restored: true });
    expect(mockRestore).toHaveBeenCalledTimes(2);
  });

  it("lets a person restore an agent's delete", async () => {
    await deleteMcpServer(server.id, AGENT_A);

    await expect(restoreMcpServer(server.id, PERSON)).resolves.toMatchObject({ restored: true });
  });

  it('gives an agent the same 404 once its own delete is past the window', async () => {
    await deleteMcpServer(server.id, AGENT_A);
    jest.advanceTimersByTime(MCP_SERVER_UNDO_WINDOW_MS);

    await expect(restoreMcpServer(server.id, AGENT_A)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockRestore).not.toHaveBeenCalled();
  });

  it('announces agent.updated for every pruned agent, and for every regranted one', async () => {
    mockRemove.mockResolvedValueOnce({
      removed: true,
      agentsPruned: 2,
      server,
      prunedAgentIds: ['test-agent-a', 'test-agent-b'],
    });
    await deleteMcpServer(server.id, PERSON);
    expect(mockEmitAgentUpdated.mock.calls).toEqual([
      ['test-agent-a', ['mcpServers']],
      ['test-agent-b', ['mcpServers']],
    ]);

    mockEmitAgentUpdated.mockClear();
    // test-agent-b was deleted in the meantime, so only test-agent-a gets it back.
    await restoreMcpServer(server.id, PERSON);
    expect(mockEmitAgentUpdated.mock.calls).toEqual([['test-agent-a', ['mcpServers']]]);
  });

  it('announces nothing when a restore is refused', async () => {
    await deleteMcpServer(server.id, AGENT_A);
    mockEmitAgentUpdated.mockClear();

    await expect(restoreMcpServer(server.id, AGENT_B)).rejects.toMatchObject({ statusCode: 403 });
    mockRestore.mockResolvedValueOnce({ restored: false, agentsRestored: 0, restoredAgentIds: [] });
    await expect(restoreMcpServer(server.id, AGENT_A)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockEmitAgentUpdated).not.toHaveBeenCalled();
  });

  it('keeps the snapshot when the id is taken again, and says why', async () => {
    await deleteMcpServer(server.id, PERSON);
    mockRestore.mockResolvedValueOnce({ restored: false, agentsRestored: 0, restoredAgentIds: [] });

    await expect(restoreMcpServer(server.id, PERSON)).rejects.toMatchObject({ statusCode: 409 });
    expect(mockSync).not.toHaveBeenCalled();
  });
});
