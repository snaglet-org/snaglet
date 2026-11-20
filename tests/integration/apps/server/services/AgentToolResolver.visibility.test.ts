/**
 * Integration test: AgentToolResolver visibility model.
 *
 * Documents how global per-tool policy and per-agent policy compose.
 *
 *   1. tools.enabled     = false  → global admin policy (per-tool disable)
 *   2. per-agent denyList contains the tool id → per-agent policy
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, closeDatabase } from '@snaglet/db';
import { Tools } from '@snaglet/db/tables/tools';
import { Agents } from '@snaglet/db/tables/agents';
import { Threads } from '@snaglet/db/tables/threads';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import {
  resolveAgentTools,
  resolveAgentToolsForExecution,
} from '@server/services/AgentToolResolver';

const TOOL_ID = 'integration_visibility_test_tool';
const AGENT_ID = 'integration_visibility_test_agent';
const THREAD_ID = 'integration_visibility_test_thread';

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.thread_participants WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.tools WHERE id = $1`, [TOOL_ID]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id IN ($1, $2, $3)`, [
    TOOL_ID,
    AGENT_ID,
    THREAD_ID,
  ]);
}

async function setupFixture() {
  await Tools.upsertTool({
    id: TOOL_ID,
    name: 'Integration Test Tool',
    description: 'fixture',
    type: 'builtin',
    categoryPath: 'system/test',
    enabled: true,
  });
  await Agents.create({
    id: AGENT_ID,
    name: 'Integration Test Agent',
    role: 'test',
    toolAccessMode: 'all',
  });
  await Threads.create({ id: THREAD_ID, title: 'Integration visibility test thread' });
  await ThreadParticipants.addParticipant({ threadId: THREAD_ID, agentId: AGENT_ID });
}

async function isVisible(): Promise<boolean> {
  const resolved = await resolveAgentTools(AGENT_ID);
  return resolved.some((r) => r.tool.id === TOOL_ID);
}

describe('AgentToolResolver visibility model', () => {
  beforeEach(async () => {
    await cleanup();
    await setupFixture();
  });
  afterEach(cleanup);
  afterAll(async () => {
    await closeDatabase();
  });

  it('all gates open → tool is visible', async () => {
    expect(await isVisible()).toBe(true);
  });

  it('tools.enabled = false hides the tool', async () => {
    await Tools.setEnabled(TOOL_ID, false);
    expect(await isVisible()).toBe(false);
  });

  it('per-agent denyList containing the tool id hides it', async () => {
    await Agents.update(AGENT_ID, {
      toolAccessMode: 'deny_list',
      toolAccessDenyList: [TOOL_ID],
    });
    expect(await isVisible()).toBe(false);
  });

  it('per-agent denyList for a different tool does not hide ours', async () => {
    await Agents.update(AGENT_ID, {
      toolAccessMode: 'deny_list',
      toolAccessDenyList: ['some_other_tool'],
    });
    expect(await isVisible()).toBe(true);
  });

  it('global off cannot be overridden by per-agent allowList', async () => {
    await Tools.setEnabled(TOOL_ID, false);
    await Agents.update(AGENT_ID, {
      toolAccessMode: 'allow_list',
      toolAccessAllowList: [TOOL_ID],
    });
    expect(await isVisible()).toBe(false);
  });

  it('keeps allow-list misses hidden but runtime-resolvable for confirmation escalation', async () => {
    await Agents.update(AGENT_ID, {
      toolAccessMode: 'allow_list',
      toolAccessAllowList: ['some_other_tool'],
    });

    expect(await isVisible()).toBe(false);
    const executionTools = await resolveAgentToolsForExecution(AGENT_ID);
    expect(executionTools.some((resolved) => resolved.tool.id === TOOL_ID)).toBe(true);
  });

  it('atomically retains concurrent agent-level allow grants', async () => {
    await Agents.update(AGENT_ID, { toolAccessAllowList: ['action'] });

    await Promise.all([
      Agents.appendToolAccessAllowList(AGENT_ID, 'file_read'),
      Agents.appendToolAccessAllowList(AGENT_ID, 'workspace_search'),
    ]);

    const agent = await Agents.findById(AGENT_ID);
    expect(agent?.toolAccessAllowList).toEqual(
      expect.arrayContaining(['action', 'file_read', 'workspace_search'])
    );
  });

  it('atomically retains concurrent thread grants and inherited deny rules', async () => {
    const denyList = ['exec_command(rm:*)'];
    await Promise.all([
      ThreadParticipants.grantToolAccess(THREAD_ID, AGENT_ID, 'file_read', ['action'], denyList),
      ThreadParticipants.grantToolAccess(
        THREAD_ID,
        AGENT_ID,
        'workspace_search',
        ['action'],
        denyList
      ),
    ]);

    const participant = (await ThreadParticipants.listByThread(THREAD_ID)).find(
      (candidate) => candidate.agentId === AGENT_ID
    );
    expect(participant?.toolAccessMode).toBe('allow_list');
    expect(participant?.toolAccessAllowList).toEqual(
      expect.arrayContaining(['action', 'file_read', 'workspace_search'])
    );
    expect(participant?.toolAccessDenyList).toEqual(denyList);
  });
});
