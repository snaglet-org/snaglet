/**
 * POST /api/mcp/servers/:id/restore undoes a delete from a snapshot the
 * server kept: the exact config (env and headers included) comes back, and
 * the server is turned back on for the agents it was pruned from. The request
 * carries only the id, and no response echoes the config, so secrets never
 * travel through the client. Delete and restore each announce agent.updated
 * for every agent whose servers changed, so open agent panes follow. Real
 * route + real error middleware + real DB; only the live-connection service
 * (McpService), the credential service and the realtime broadcast are mocked
 * at their module seams.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const disconnect = jest.fn(async () => undefined);
const reload = jest.fn(async () => undefined);
const syncFromProvider = jest.fn(async () => undefined);
jest.mock('@server/services/McpService', () => ({
  mcpService: {
    disconnect: (...a: unknown[]) => disconnect(...a),
    reload: (...a: unknown[]) => reload(...a),
    syncFromProvider: (...a: unknown[]) => syncFromProvider(...a),
    getStatus: jest.fn(() => null),
    listStatuses: jest.fn(() => []),
    testConnection: jest.fn(async () => ({ ok: true })),
  },
}));
jest.mock('@server/services/ProviderCredentialService', () => ({
  providerCredentialService: {
    saveCredential: jest.fn(),
    deleteCredential: jest.fn(),
  },
}));

const emitWorkspaceEvent = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (...a: unknown[]) => emitWorkspaceEvent(...a),
}));

import { Agents, McpServers, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import mcpRouter from '@server/routes/mcp';

const PREFIX = 'mcp-undo-route';
const SERVER_ID = `mcp-${PREFIX}-target`;
const OTHER_SERVER_ID = `mcp-${PREFIX}-other`;
const AGENT_ONE = `agent-${PREFIX}-one`;
const AGENT_TWO = `agent-${PREFIX}-two`;
const AGENT_NONE = `agent-${PREFIX}-none`;
const ALL_AGENTS = [AGENT_ONE, AGENT_TWO, AGENT_NONE];
const SECRET = 'test-secret-value';

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', mcpRouter);
  app.use(errorHandler);
  return app;
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [ALL_AGENTS]);
  await pool.query(`DELETE FROM mcp_servers WHERE id = ANY($1::text[])`, [
    [SERVER_ID, OTHER_SERVER_ID],
  ]);
}

async function mcpServersOf(agentId: string): Promise<string[]> {
  const agent = await Agents.findById(agentId);
  if (!agent) throw new Error(`missing test agent ${agentId}`);
  return agent.mcpServers ?? [];
}

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanup();
  await McpServers.upsertServer({
    id: SERVER_ID,
    name: 'Undo route target',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: `Bearer ${SECRET}` },
    env: { API_TOKEN: SECRET },
    enabled: false,
    autoload: true,
    requiresConfirmation: false,
  });
  await McpServers.upsertServer({ id: OTHER_SERVER_ID, name: 'Undo route other' });
  await Agents.create({
    id: AGENT_ONE,
    name: `${PREFIX}-one`,
    mcpServers: [SERVER_ID, OTHER_SERVER_ID],
  });
  await Agents.create({ id: AGENT_TWO, name: `${PREFIX}-two`, mcpServers: [SERVER_ID] });
  await Agents.create({ id: AGENT_NONE, name: `${PREFIX}-none`, mcpServers: [] });
});

describe('POST /api/mcp/servers/:id/restore', () => {
  // Nested so this DB-querying afterAll unwinds before the shared
  // closeDatabase() registered by pgPerFileTeardown.
  afterAll(async () => {
    await cleanup();
  });

  it('brings back the exact config and the agents it was on', async () => {
    const app = makeApp();
    const before = await McpServers.findServer(SERVER_ID);
    await request(app).delete(`/api/mcp/servers/${SERVER_ID}`).expect(200);
    expect(await McpServers.findServer(SERVER_ID)).toBeNull();
    const noneBefore = await Agents.findById(AGENT_NONE);

    const res = await request(app).post(`/api/mcp/servers/${SERVER_ID}/restore`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: SERVER_ID, restored: true, agentsRestored: 2 });
    // Nothing secret comes back in the response.
    expect(JSON.stringify(res.body)).not.toContain(SECRET);

    const after = await McpServers.findServer(SERVER_ID);
    expect(after).toEqual({ ...before, updatedAt: after?.updatedAt });
    expect(await mcpServersOf(AGENT_ONE)).toEqual([OTHER_SERVER_ID, SERVER_ID]);
    expect(await mcpServersOf(AGENT_TWO)).toEqual([SERVER_ID]);
    // An agent that never had it is not touched.
    const noneAfter = await Agents.findById(AGENT_NONE);
    expect(noneAfter?.mcpServers).toEqual([]);
    expect(noneAfter?.updatedAt).toEqual(noneBefore?.updatedAt);
    // The live connection reconciles, as after a create.
    expect(syncFromProvider).toHaveBeenCalledWith(SERVER_ID);
  });

  it('announces agent.updated for every affected agent on delete and on restore', async () => {
    const app = makeApp();
    const agentUpdates = () =>
      emitWorkspaceEvent.mock.calls
        .map(([event]) => event as { type: string; agentId?: string; changed?: string[] })
        .filter((event) => event.type === 'agent.updated');

    await request(app).delete(`/api/mcp/servers/${SERVER_ID}`).expect(200);
    expect(agentUpdates()).toHaveLength(2);
    expect(agentUpdates()).toEqual(
      expect.arrayContaining([
        { type: 'agent.updated', agentId: AGENT_ONE, changed: ['mcpServers'] },
        { type: 'agent.updated', agentId: AGENT_TWO, changed: ['mcpServers'] },
      ])
    );

    emitWorkspaceEvent.mockClear();
    await request(app).post(`/api/mcp/servers/${SERVER_ID}/restore`).expect(200);
    expect(agentUpdates()).toHaveLength(2);
    expect(agentUpdates()).toEqual(
      expect.arrayContaining([
        { type: 'agent.updated', agentId: AGENT_ONE, changed: ['mcpServers'] },
        { type: 'agent.updated', agentId: AGENT_TWO, changed: ['mcpServers'] },
      ])
    );
    // AGENT_NONE never had the server: no event for it either way.
  });

  it('skips an agent deleted since, and restores only once', async () => {
    const app = makeApp();
    await request(app).delete(`/api/mcp/servers/${SERVER_ID}`).expect(200);
    await getDb().query(`DELETE FROM agents WHERE id = $1`, [AGENT_TWO]);

    const res = await request(app).post(`/api/mcp/servers/${SERVER_ID}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.data.agentsRestored).toBe(1);

    const again = await request(app).post(`/api/mcp/servers/${SERVER_ID}/restore`);
    expect(again.status).toBe(404);
    expect(again.body.success).toBe(false);
  });

  it('404s for a server that was never deleted', async () => {
    const res = await request(makeApp()).post(`/api/mcp/servers/${PREFIX}-never-deleted/restore`);

    expect(res.status).toBe(404);
    expect(syncFromProvider).not.toHaveBeenCalled();
  });

  it('refuses when a server with the same id was created in the meantime', async () => {
    const app = makeApp();
    await request(app).delete(`/api/mcp/servers/${SERVER_ID}`).expect(200);
    await McpServers.upsertServer({ id: SERVER_ID, name: 'Replacement' });

    const res = await request(app).post(`/api/mcp/servers/${SERVER_ID}/restore`);

    expect(res.status).toBe(409);
    expect((await McpServers.findServer(SERVER_ID))?.name).toBe('Replacement');
    // The grants stay off: the new server is not the one the agents had.
    expect(await mcpServersOf(AGENT_ONE)).toEqual([OTHER_SERVER_ID]);
    expect(await mcpServersOf(AGENT_TWO)).toEqual([]);
  });
});
