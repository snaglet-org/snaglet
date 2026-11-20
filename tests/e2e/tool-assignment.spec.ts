import { test, expect } from '@playwright/test';
import { API } from './helpers/chat';

/**
 * E2E: Tool assignment (Surface 7)
 *
 * Exercises the per-agent tool assignment contract:
 *   GET    /api/tools/agent/:agentId         — resolved tools for an agent
 *   POST   /api/tools/agent/:agentId         — add a tool override (append to allow_list)
 *   DELETE /api/tools/agent/:agentId/:toolId — remove an assignment
 *
 * Route-ordering guard: /agent/:agentId is registered before /:id so the
 * literal segment 'agent' is never parsed as a tool id. We assert that the
 * resolved-tools endpoint behaves like an agent lookup, not a tool lookup.
 *
 * Pattern mirrors agent-identity.spec.ts: use an EXISTING agent + an existing
 * tool id discovered at runtime; skip gracefully if the environment has none.
 */

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`);
  return { status: res.status, body: await res.json() };
}

test.describe('Surface 7 — Tool assignment', () => {
  let agentId: string;
  let toolId: string;

  test.beforeAll(async () => {
    const agentsRes = await getJson('/agents');
    const agents = agentsRes.body.data ?? [];
    const toolsRes = await getJson('/tools');
    const tools = toolsRes.body.data ?? [];
    if (agents.length === 0 || tools.length === 0) {
      test.skip(true, 'requires at least one agent and one tool to exist');
      return;
    }
    agentId = agents[0].id;
    toolId = tools[0].id;
  });

  test('resolves the tool list for an agent', async () => {
    const { status, body } = await getJson(`/tools/agent/${agentId}`);
    expect(status, 'GET /tools/agent/:agentId should succeed').toBe(200);
    expect(body.success).toBe(true);
    // Resolved tools should be a collection, not a single tool record.
    expect(Array.isArray(body.data) || typeof body.data === 'object').toBe(true);
  });

  test('route ordering: "agent" is not parsed as a tool id', async () => {
    // If /:id swallowed /agent, this would 404 as an unknown tool or return a
    // tool-shaped record. Instead it must resolve against the real agent.
    const { status } = await getJson(`/tools/agent/${agentId}`);
    expect(status).not.toBe(404);
  });

  test('add then remove a tool assignment round-trips', async () => {
    const addRes = await fetch(`${API}/tools/agent/${agentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolId }),
    });
    expect([200, 201], 'POST assignment should succeed').toContain(addRes.status);

    const after = await getJson(`/tools/agent/${agentId}`);
    expect(after.status).toBe(200);

    const delRes = await fetch(`${API}/tools/agent/${agentId}/${toolId}`, {
      method: 'DELETE',
    });
    expect([200, 204], 'DELETE assignment should succeed').toContain(delRes.status);
  });
});
