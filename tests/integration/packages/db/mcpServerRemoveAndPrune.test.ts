/**
 * Removing an MCP server strips its id from every agent's `mcp_servers` array
 * in the same transaction: the server row and the agent references go
 * together or not at all. The removal hands back the deleted row and the
 * pruned agent ids, and `restoreAndRegrantAgents` puts both back. Real models
 * against this file's own database in the shared managed cluster — the
 * subject is the delete+prune contract, so nothing is mocked except the
 * injected prune failure in the rollback case.
 */

import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Agents, McpServers, getDb } from '@snaglet/db';

const PREFIX = 't008';
const SERVER_A = `mcp-${PREFIX}-alpha`;
const SERVER_B = `mcp-${PREFIX}-beta`;
const SERVER_LONELY = `mcp-${PREFIX}-lonely`;
const AGENT_BOTH = `agent-${PREFIX}-both`; // references A and B
const AGENT_DUP = `agent-${PREFIX}-dup`; // references A twice (defensive dupes)
const AGENT_NONE = `agent-${PREFIX}-none`; // references nothing
const ALL_AGENTS = [AGENT_BOTH, AGENT_DUP, AGENT_NONE];
const ALL_SERVERS = [SERVER_A, SERVER_B, SERVER_LONELY];

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM agents WHERE id = ANY($1::text[])`, [ALL_AGENTS]);
  await pool.query(`DELETE FROM mcp_servers WHERE id = ANY($1::text[])`, [ALL_SERVERS]);
}

async function mcpServersOf(agentId: string): Promise<string[]> {
  const agent = await Agents.findById(agentId);
  if (!agent) throw new Error(`missing test agent ${agentId}`);
  return agent.mcpServers ?? [];
}

async function agentsReferencing(serverId: string): Promise<number> {
  const res = await getDb().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agents WHERE mcp_servers ? $1::text`,
    [serverId]
  );
  return Number(res.rows[0]!.count);
}

beforeEach(async () => {
  jest.restoreAllMocks();
  await cleanup();
  await McpServers.upsertServer({ id: SERVER_A, name: 'T008 Alpha' });
  await McpServers.upsertServer({ id: SERVER_B, name: 'T008 Beta' });
  await McpServers.upsertServer({ id: SERVER_LONELY, name: 'T008 Lonely' });
  await Agents.create({
    id: AGENT_BOTH,
    name: `${PREFIX}-both`,
    mcpServers: [SERVER_A, SERVER_B],
  });
  await Agents.create({
    id: AGENT_DUP,
    name: `${PREFIX}-dup`,
    mcpServers: [SERVER_A, SERVER_A],
  });
  await Agents.create({ id: AGENT_NONE, name: `${PREFIX}-none`, mcpServers: [] });
});

describe('McpServers.removeAndPruneAgents', () => {
  // Nested so this DB-querying afterAll unwinds before the shared
  // closeDatabase() registered by pgPerFileTeardown.
  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanup();
  });

  it('prunes the deleted id from every referencing agent and only those', async () => {
    const noneBefore = await Agents.findById(AGENT_NONE);

    const before = await McpServers.findServer(SERVER_A);

    const result = await McpServers.removeAndPruneAgents(SERVER_A);

    expect(result).toMatchObject({ removed: true, agentsPruned: 2, server: before });
    if (!result.removed) throw new Error('expected a removal');
    expect([...result.prunedAgentIds].sort()).toEqual([AGENT_BOTH, AGENT_DUP].sort());
    expect(await McpServers.findServer(SERVER_A)).toBeNull();
    // The multi-server agent keeps its other reference; only the deleted id
    // goes, including duplicate occurrences.
    expect(await mcpServersOf(AGENT_BOTH)).toEqual([SERVER_B]);
    expect(await mcpServersOf(AGENT_DUP)).toEqual([]);
    expect(await agentsReferencing(SERVER_A)).toBe(0);
    // The non-referencing agent got no write at all — updated_at untouched.
    const noneAfter = await Agents.findById(AGENT_NONE);
    expect(noneAfter?.updatedAt).toEqual(noneBefore?.updatedAt);
  });

  it('a server referenced by nobody deletes with zero prunes', async () => {
    const result = await McpServers.removeAndPruneAgents(SERVER_LONELY);

    expect(result).toMatchObject({ removed: true, agentsPruned: 0, prunedAgentIds: [] });
    expect(await McpServers.findServer(SERVER_LONELY)).toBeNull();
    expect(await mcpServersOf(AGENT_BOTH)).toEqual([SERVER_A, SERVER_B]);
  });

  it('re-deleting is an honest no-op: removed=false, nothing touched', async () => {
    await McpServers.removeAndPruneAgents(SERVER_A);
    const bothAfterFirst = await mcpServersOf(AGENT_BOTH);

    const second = await McpServers.removeAndPruneAgents(SERVER_A);

    expect(second).toEqual({ removed: false, agentsPruned: 0 });
    expect(await mcpServersOf(AGENT_BOTH)).toEqual(bothAfterFirst);
  });

  it('a failed prune rolls the server delete back — never gone-but-referenced', async () => {
    jest
      .spyOn(Agents, 'pruneMcpServerId')
      .mockRejectedValueOnce(new Error('injected prune failure'));

    await expect(McpServers.removeAndPruneAgents(SERVER_A)).rejects.toThrow(
      'injected prune failure'
    );

    // The transaction rolled back: server row still there, agents untouched.
    expect(await McpServers.findServer(SERVER_A)).not.toBeNull();
    expect(await mcpServersOf(AGENT_BOTH)).toEqual([SERVER_A, SERVER_B]);
    expect(await mcpServersOf(AGENT_DUP)).toEqual([SERVER_A, SERVER_A]);
    expect(await agentsReferencing(SERVER_A)).toBe(2);
  });
});

describe('McpServers.restoreAndRegrantAgents', () => {
  afterAll(async () => {
    await cleanup();
  });

  it('puts the row back exactly and re-adds the id once per pruned agent', async () => {
    const before = await McpServers.findServer(SERVER_A);
    const noneBefore = await Agents.findById(AGENT_NONE);
    const removal = await McpServers.removeAndPruneAgents(SERVER_A);
    if (!removal.removed) throw new Error('expected a removal');

    const result = await McpServers.restoreAndRegrantAgents(removal.server, removal.prunedAgentIds);

    expect(result).toMatchObject({ restored: true, agentsRestored: 2 });
    expect([...result.restoredAgentIds].sort()).toEqual([AGENT_BOTH, AGENT_DUP].sort());
    const after = await McpServers.findServer(SERVER_A);
    expect(after).toEqual({ ...before, updatedAt: after?.updatedAt });
    expect(await mcpServersOf(AGENT_BOTH)).toEqual([SERVER_B, SERVER_A]);
    // The duplicate collapses to one reference; the id is back either way.
    expect(await mcpServersOf(AGENT_DUP)).toEqual([SERVER_A]);
    const noneAfter = await Agents.findById(AGENT_NONE);
    expect(noneAfter?.updatedAt).toEqual(noneBefore?.updatedAt);
  });

  it('writes nothing when a server with that id exists again', async () => {
    const removal = await McpServers.removeAndPruneAgents(SERVER_A);
    if (!removal.removed) throw new Error('expected a removal');
    await McpServers.upsertServer({ id: SERVER_A, name: 'T008 Replacement' });

    const result = await McpServers.restoreAndRegrantAgents(removal.server, removal.prunedAgentIds);

    expect(result).toEqual({ restored: false, agentsRestored: 0, restoredAgentIds: [] });
    expect((await McpServers.findServer(SERVER_A))?.name).toBe('T008 Replacement');
    expect(await agentsReferencing(SERVER_A)).toBe(0);
  });

  it('skips agents that already list the id or no longer exist', async () => {
    const removal = await McpServers.removeAndPruneAgents(SERVER_A);
    if (!removal.removed) throw new Error('expected a removal');
    await getDb().query(`DELETE FROM agents WHERE id = $1`, [AGENT_DUP]);
    await getDb().query(`UPDATE agents SET mcp_servers = $2::jsonb WHERE id = $1`, [
      AGENT_BOTH,
      JSON.stringify([SERVER_B, SERVER_A]),
    ]);

    const result = await McpServers.restoreAndRegrantAgents(removal.server, removal.prunedAgentIds);

    expect(result).toEqual({ restored: true, agentsRestored: 0, restoredAgentIds: [] });
    expect(await mcpServersOf(AGENT_BOTH)).toEqual([SERVER_B, SERVER_A]);
  });
});
