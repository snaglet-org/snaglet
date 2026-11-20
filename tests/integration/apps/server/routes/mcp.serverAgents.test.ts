/**
 * GET/PUT /api/mcp/servers/:id/agents ("Enable for all agents"): the list names
 * every roster agent with its flag, PUT sets exactly the agents given (so
 * Enable for all, Turn off for all and Undo are one call each), archived agents
 * are not on the roster, and bad input is refused before anything changes. Real
 * route + real DB; the live-connection service is mocked so no MCP process
 * starts.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@server/services/McpService', () => ({
  mcpService: {
    disconnect: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    getStatus: jest.fn(() => null),
    listStatuses: jest.fn(() => []),
    requiresCredential: jest.fn(() => false),
    getCredentialSpec: jest.fn(() => null),
    testConnection: jest.fn(async () => ({ ok: true })),
  },
}));

import { Agents, McpServers, getDb } from '@snaglet/db';
import { errorHandler } from '@server/middleware';
import mcpRouter from '@server/routes/mcp';

const PREFIX = 'mcp-all-route';
const SERVER_ID = `mcp-${PREFIX}-target`;
const OTHER_SERVER = `mcp-${PREFIX}-other`;
const AGENT_ONE = `agent-${PREFIX}-one`;
const AGENT_TWO = `agent-${PREFIX}-two`;
const AGENT_ARCHIVED = `agent-${PREFIX}-archived`;
const OURS = [AGENT_ONE, AGENT_TWO, AGENT_ARCHIVED];

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', mcpRouter);
  app.use(errorHandler);
  return app;
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [OURS]);
  // "Enable for all" also reaches the seeded agents: take the test server off them.
  await pool.query(
    `UPDATE agents SET mcp_servers = mcp_servers - $1::text WHERE mcp_servers ? $1::text`,
    [SERVER_ID]
  );
  await pool.query(`DELETE FROM mcp_servers WHERE id = ANY($1::text[])`, [
    [SERVER_ID, OTHER_SERVER],
  ]);
}

async function serversOf(id: string): Promise<string[]> {
  return (await Agents.findById(id))?.mcpServers ?? [];
}

beforeEach(async () => {
  await cleanup();
  await McpServers.upsertServer({ id: SERVER_ID, name: 'MCP all target' });
  await McpServers.upsertServer({ id: OTHER_SERVER, name: 'MCP all other' });
  await Agents.create({
    id: AGENT_ONE,
    name: `${PREFIX}-one`,
    mcpServers: [SERVER_ID, OTHER_SERVER],
  });
  await Agents.create({ id: AGENT_TWO, name: `${PREFIX}-two`, mcpServers: [OTHER_SERVER] });
  await Agents.create({ id: AGENT_ARCHIVED, name: `${PREFIX}-archived`, mcpServers: [] });
  await getDb().query(`UPDATE agents SET archived = true, archived_at = now() WHERE id = $1`, [
    AGENT_ARCHIVED,
  ]);
});

describe('/api/mcp/servers/:id/agents', () => {
  afterAll(async () => {
    await cleanup();
  });

  it('lists every roster agent with whether it may use the server', async () => {
    const res = await request(makeApp()).get(`/api/mcp/servers/${SERVER_ID}/agents`);
    expect(res.status).toBe(200);
    const rows = res.body.data as Array<{ id: string; name: string; enabled: boolean }>;
    expect(rows.find((row) => row.id === AGENT_ONE)).toMatchObject({ enabled: true });
    expect(rows.find((row) => row.id === AGENT_TWO)).toMatchObject({ enabled: false });
    expect(rows.some((row) => row.id === AGENT_ARCHIVED)).toBe(false);
    expect(rows.some((row) => row.id === 'ghost')).toBe(false);
  });

  it('enables for all, turns off for all, and restores a set, keeping other servers', async () => {
    const app = makeApp();
    const before = (await request(app).get(`/api/mcp/servers/${SERVER_ID}/agents`)).body
      .data as Array<{ id: string; enabled: boolean }>;
    const everyone = before.map((row) => row.id);

    const all = await request(app)
      .put(`/api/mcp/servers/${SERVER_ID}/agents`)
      .send({ agentIds: everyone });
    expect(all.status).toBe(200);
    expect((all.body.data as Array<{ enabled: boolean }>).every((row) => row.enabled)).toBe(true);
    expect(await serversOf(AGENT_TWO)).toEqual([OTHER_SERVER, SERVER_ID]);
    expect(await serversOf(AGENT_ARCHIVED)).toEqual([]);

    const none = await request(app)
      .put(`/api/mcp/servers/${SERVER_ID}/agents`)
      .send({ agentIds: [] });
    expect(none.status).toBe(200);
    expect(await serversOf(AGENT_ONE)).toEqual([OTHER_SERVER]);
    expect(await serversOf(AGENT_TWO)).toEqual([OTHER_SERVER]);

    // Undo puts back exactly the set from before.
    const undo = await request(app)
      .put(`/api/mcp/servers/${SERVER_ID}/agents`)
      .send({ agentIds: before.filter((row) => row.enabled).map((row) => row.id) });
    expect(undo.status).toBe(200);
    expect(await serversOf(AGENT_ONE)).toEqual([OTHER_SERVER, SERVER_ID]);
    expect(await serversOf(AGENT_TWO)).toEqual([OTHER_SERVER]);
  });

  it('refuses unknown or archived agents and a bad body without changing anything', async () => {
    const app = makeApp();
    const unknown = await request(app)
      .put(`/api/mcp/servers/${SERVER_ID}/agents`)
      .send({ agentIds: [AGENT_TWO, AGENT_ARCHIVED] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain(AGENT_ARCHIVED);
    expect(await serversOf(AGENT_TWO)).toEqual([OTHER_SERVER]);

    const bad = await request(app)
      .put(`/api/mcp/servers/${SERVER_ID}/agents`)
      .send({ agentIds: 'all' });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .put(`/api/mcp/servers/mcp-${PREFIX}-nope/agents`)
      .send({ agentIds: [] });
    expect(missing.status).toBe(404);
  });
});
