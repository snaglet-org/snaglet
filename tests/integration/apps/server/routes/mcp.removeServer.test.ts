/**
 * DELETE /api/mcp/servers/:id cascades to agents: the response
 * reports how many agents were pruned, the DB really is reconciled, and a
 * repeated delete is the route's usual 404. Real route + real error
 * middleware + real DB; only the live-connection service (McpService) and the
 * credential service are mocked at their module seams — deleting a row must
 * not spawn or kill actual MCP processes in a test.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const disconnect = jest.fn(async () => undefined);
const reload = jest.fn(async () => undefined);
jest.mock('@server/services/McpService', () => ({
  mcpService: {
    disconnect: (...a: unknown[]) => disconnect(...a),
    reload: (...a: unknown[]) => reload(...a),
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

import { Agents, McpServers, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import mcpRouter from '@server/routes/mcp';

const PREFIX = 't008-route';
const SERVER_ID = `mcp-${PREFIX}-target`;
const AGENT_ONE = `agent-${PREFIX}-one`;
const AGENT_TWO = `agent-${PREFIX}-two`;

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', mcpRouter);
  app.use(errorHandler);
  return app;
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[AGENT_ONE, AGENT_TWO]]);
  await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [SERVER_ID]);
}

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanup();
  await McpServers.upsertServer({ id: SERVER_ID, name: 'T008 route target' });
  await Agents.create({ id: AGENT_ONE, name: `${PREFIX}-one`, mcpServers: [SERVER_ID] });
  await Agents.create({ id: AGENT_TWO, name: `${PREFIX}-two`, mcpServers: [SERVER_ID] });
});

describe('DELETE /api/mcp/servers/:id', () => {
  // Nested so this DB-querying afterAll unwinds before the shared
  // closeDatabase() registered by pgPerFileTeardown.
  afterAll(async () => {
    await cleanup();
  });

  it('deletes, prunes every referencing agent, and reports the count', async () => {
    const app = makeApp();

    const res = await request(app).delete(`/api/mcp/servers/${SERVER_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: SERVER_ID, removed: true, agentsPruned: 2 });
    expect(await McpServers.findServer(SERVER_ID)).toBeNull();
    const one = await Agents.findById(AGENT_ONE);
    const two = await Agents.findById(AGENT_TWO);
    expect(one?.mcpServers).toEqual([]);
    expect(two?.mcpServers).toEqual([]);
    // Live-connection reconcile still happens, after the transaction.
    expect(disconnect).toHaveBeenCalledWith(SERVER_ID);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('re-deleting 404s and reconnects nothing', async () => {
    const app = makeApp();
    await request(app).delete(`/api/mcp/servers/${SERVER_ID}`);
    jest.clearAllMocks();

    const res = await request(app).delete(`/api/mcp/servers/${SERVER_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
