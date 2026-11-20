/**
 * Renaming an agent persists through every update path — the service, the
 * PATCH route and the update_agent tool — with create's name rules: unique
 * case-insensitively among other agents, not reserved, usable characters. The
 * id never changes, and other windows hear an `agent.updated` naming `name`.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Creation-time guarded defaults load the whole tool registry (seconds under
// load); they are not what this suite tests.
jest.mock('@server/services/ToolService/lib/guardedTools', () => ({
  withGuardedConfirmationDefaults: async (existing: Record<string, unknown> | null) => ({
    ...(existing ?? {}),
  }),
}));

const emitWorkspaceEvent = jest.fn();
jest.mock('@server/realtime/emit', () => ({
  emitWorkspaceEvent: (...a: unknown[]) => emitWorkspaceEvent(...a),
}));

import { getDb, Agents } from '@snaglet/db';
import { agentService } from '@server/services/AgentService';
import { errorHandler } from '@server/middleware';
import agentsRouter from '@server/domains/agents/agents.routes';
import updateAgentTool from '@server/services/ToolService/handlers/agents/updateAgent';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/agents', agentsRouter);
  app.use(errorHandler);
  return app;
}

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.members WHERE agent_id = ANY($1)`, [[AGENT_A, AGENT_B]]);
  await getDb().query(`DELETE FROM public.agents WHERE id = ANY($1)`, [[AGENT_A, AGENT_B]]);
}

async function storedName(id: string): Promise<string | undefined> {
  return (await Agents.findById(id))?.name;
}

function nameUpdateEvents(agentId: string): unknown[] {
  return emitWorkspaceEvent.mock.calls
    .map((call) => call[0] as { type: string; agentId: string; changed: string[] })
    .filter(
      (e) => e.type === 'agent.updated' && e.agentId === agentId && e.changed.includes('name')
    );
}

describe('agent rename', () => {
  afterAll(cleanup);

  beforeEach(async () => {
    await cleanup();
    await agentService.create({ name: 'Test Agent A' } as Parameters<
      typeof agentService.create
    >[0]);
    await agentService.create({ name: 'Test Agent B' } as Parameters<
      typeof agentService.create
    >[0]);
    emitWorkspaceEvent.mockClear();
  });

  it('persists a rename from the service and announces it', async () => {
    const updated = await agentService.update(AGENT_A, { name: '  Renamed Agent  ' });

    expect(updated).toMatchObject({ id: AGENT_A, name: 'Renamed Agent' });
    expect(await storedName(AGENT_A)).toBe('Renamed Agent');
    expect(nameUpdateEvents(AGENT_A)).toHaveLength(1);
  });

  it('persists a rename from the PATCH route, keeping the id', async () => {
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_A}`)
      .send({ name: 'Renamed Over HTTP' });

    expect(res.status).toBe(200);
    expect(res.body.data ?? res.body).toMatchObject({ id: AGENT_A, name: 'Renamed Over HTTP' });
    expect(await storedName(AGENT_A)).toBe('Renamed Over HTTP');
  });

  it('persists a rename from the update_agent tool', async () => {
    const raw = await updateAgentTool(
      { agent_id: AGENT_A, name: 'Renamed By Tool' },
      {},
      undefined
    );

    expect(JSON.parse(String(raw))).toMatchObject({ success: true, name: 'Renamed By Tool' });
    expect(await storedName(AGENT_A)).toBe('Renamed By Tool');
  });

  it("rejects another agent's name, case-insensitively", async () => {
    await expect(agentService.update(AGENT_A, { name: 'test agent b' })).rejects.toThrow(
      /already exists/
    );
    const res = await request(makeApp())
      .patch(`/api/agents/${AGENT_A}`)
      .send({ name: 'TEST AGENT B' });
    expect(res.status).toBe(409);
    const raw = await updateAgentTool({ agent_id: AGENT_A, name: 'Test Agent B' }, {}, undefined);
    expect(JSON.parse(String(raw))).toMatchObject({ success: false });

    expect(await storedName(AGENT_A)).toBe('Test Agent A');
  });

  it('allows re-casing its own name', async () => {
    await agentService.update(AGENT_A, { name: 'TEST AGENT A' });
    expect(await storedName(AGENT_A)).toBe('TEST AGENT A');
  });

  it('rejects reserved, empty and unusable names', async () => {
    await expect(agentService.update(AGENT_A, { name: 'Ghost' })).rejects.toThrow(/reserved/);
    await expect(agentService.update(AGENT_A, { name: '   ' })).rejects.toThrow(/non-empty/);
    await expect(agentService.update(AGENT_A, { name: '!!!' })).rejects.toThrow(
      /no usable characters/
    );
    expect(await storedName(AGENT_A)).toBe('Test Agent A');
    expect(nameUpdateEvents(AGENT_A)).toHaveLength(0);
  });

  it('does not announce a rename to the same name', async () => {
    await agentService.update(AGENT_A, { name: 'Test Agent A' });
    expect(nameUpdateEvents(AGENT_A)).toHaveLength(0);
  });
});
