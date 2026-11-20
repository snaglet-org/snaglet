/**
 * mcp op restore: the agent-facing undo of op delete, through the same code as
 * POST /api/mcp/servers/:id/restore. The exact row and the agent grants come
 * back, nothing secret is returned, an agent may restore only a delete it made
 * itself, and a person (the route) may restore any. Real tool entry + real
 * route + real DB; only the live-connection service and the credential service
 * are mocked at their module seams.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

jest.mock('@server/services/McpService', () => ({
  mcpService: {
    disconnect: jest.fn(async () => undefined),
    reload: jest.fn(async () => undefined),
    syncFromProvider: jest.fn(async () => undefined),
    getStatus: jest.fn(() => null),
    listStatuses: jest.fn(() => []),
    requiresCredential: jest.fn(() => false),
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
import mcpTool from '@server/services/ToolService/tools/agents/mcp/tool';

const PREFIX = 'mcp-tool-restore';
const SERVER_ID = `mcp-${PREFIX}-target`;
const AGENT_A = `test-agent-${PREFIX}-a`;
const AGENT_B = `test-agent-${PREFIX}-b`;
const SECRET = 'test-secret-value';

interface ToolResult {
  output: string;
  rawContent: Record<string, unknown>;
}

/** Call the tool as an agent's run would. */
async function asAgent(agentId: string, input: Record<string, unknown>): Promise<ToolResult> {
  return (await mcpTool({ id: SERVER_ID, ...input }, {}, { agentId })) as ToolResult;
}

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', mcpRouter);
  app.use(errorHandler);
  return app;
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [[AGENT_A, AGENT_B]]);
  await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [SERVER_ID]);
}

async function mcpServersOf(agentId: string): Promise<string[]> {
  return (await Agents.findById(agentId))?.mcpServers ?? [];
}

beforeEach(async () => {
  await cleanup();
  await McpServers.upsertServer({
    id: SERVER_ID,
    name: 'Tool restore target',
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: `Bearer ${SECRET}` },
    env: { API_TOKEN: SECRET },
    requiresConfirmation: false,
  });
  await Agents.create({ id: AGENT_A, name: `${PREFIX}-a`, mcpServers: [SERVER_ID] });
  await Agents.create({ id: AGENT_B, name: `${PREFIX}-b`, mcpServers: [SERVER_ID] });
});

describe('mcp op restore', () => {
  // Nested so this DB-querying afterAll unwinds before the shared
  // closeDatabase() registered by pgPerFileTeardown.
  afterAll(async () => {
    await cleanup();
  });

  it('lets an agent restore its own delete: exact row, grants back, no secrets', async () => {
    const before = await McpServers.findServer(SERVER_ID);
    await asAgent(AGENT_A, { op: 'delete' });
    expect(await McpServers.findServer(SERVER_ID)).toBeNull();
    expect(await mcpServersOf(AGENT_B)).toEqual([]);

    const result = await asAgent(AGENT_A, { op: 'restore' });

    expect(result.rawContent).toEqual({
      action: 'restored',
      id: SERVER_ID,
      restored: true,
      agentsRestored: 2,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const after = await McpServers.findServer(SERVER_ID);
    expect(after).toEqual({ ...before, updatedAt: after?.updatedAt });
    expect(await mcpServersOf(AGENT_A)).toEqual([SERVER_ID]);
    expect(await mcpServersOf(AGENT_B)).toEqual([SERVER_ID]);
  });

  it("refuses an agent restoring another agent's delete; that agent still can", async () => {
    await asAgent(AGENT_B, { op: 'delete' });

    const refused = await asAgent(AGENT_A, { op: 'restore' });

    expect(refused.rawContent.error).toMatch(/deleted by someone else/);
    expect(await McpServers.findServer(SERVER_ID)).toBeNull();
    expect(await mcpServersOf(AGENT_A)).toEqual([]);
    expect((await asAgent(AGENT_B, { op: 'restore' })).rawContent.restored).toBe(true);
  });

  it("refuses an agent restoring a person's delete", async () => {
    const app = makeApp();
    await request(app).delete(`/api/mcp/servers/${SERVER_ID}`).expect(200);

    const refused = await asAgent(AGENT_A, { op: 'restore' });

    expect(refused.rawContent.error).toMatch(/deleted by someone else/);
    expect(await McpServers.findServer(SERVER_ID)).toBeNull();
    // The person's Undo still works.
    await request(app).post(`/api/mcp/servers/${SERVER_ID}/restore`).expect(200);
  });

  it("lets a person restore an agent's delete through the route", async () => {
    await asAgent(AGENT_A, { op: 'delete' });

    const res = await request(makeApp()).post(`/api/mcp/servers/${SERVER_ID}/restore`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: SERVER_ID, restored: true, agentsRestored: 2 });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(await mcpServersOf(AGENT_A)).toEqual([SERVER_ID]);
  });

  it('gives the 404 when nothing is restorable: never deleted, or already restored', async () => {
    const never = await asAgent(AGENT_A, { op: 'restore' });
    expect(never.rawContent.error).toMatch(/undo window has passed/);

    await asAgent(AGENT_A, { op: 'delete' });
    await asAgent(AGENT_A, { op: 'restore' });
    const again = await asAgent(AGENT_A, { op: 'restore' });
    expect(again.rawContent.error).toMatch(/undo window has passed/);
  });

  it('gives the 409 when a new server has taken the id, and leaves it alone', async () => {
    await asAgent(AGENT_A, { op: 'delete' });
    await McpServers.upsertServer({ id: SERVER_ID, name: 'Replacement' });

    const refused = await asAgent(AGENT_A, { op: 'restore' });

    expect(refused.rawContent.error).toMatch(/exists again/);
    expect((await McpServers.findServer(SERVER_ID))?.name).toBe('Replacement');
    expect(await mcpServersOf(AGENT_A)).toEqual([]);
    expect(await mcpServersOf(AGENT_B)).toEqual([]);
  });

  it('takes no fields but the id', async () => {
    await expect(asAgent(AGENT_A, { op: 'restore', name: 'Renamed' })).rejects.toThrow(
      /belongs to op create/
    );
  });
});
