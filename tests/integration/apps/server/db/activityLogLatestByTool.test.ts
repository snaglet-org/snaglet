/**
 * AgentActivityLog.getLatestByTool against the real database: a compaction record is the newest
 * `compaction_summary` row for one agent in one thread, never another thread's or agent's.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Threads } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Runs } from '@snaglet/db/tables/runs';

const PREFIX = 'latest-by-tool-it';
const THREAD_ID = `thread-${PREFIX}`;
const OTHER_THREAD_ID = `thread-${PREFIX}-other`;
const AGENT_ID = `agent-${PREFIX}`;
const OTHER_AGENT_ID = `agent-${PREFIX}-other`;
const RUN_ID = `run-${PREFIX}`;
const OTHER_RUN_ID = `run-${PREFIX}-other`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.agent_activity_log WHERE agent_id = ANY($1)`, [
    [AGENT_ID, OTHER_AGENT_ID],
  ]);
  await pool.query(`DELETE FROM public.runs WHERE id = ANY($1)`, [[RUN_ID, OTHER_RUN_ID]]);
  await pool.query(`DELETE FROM public.threads WHERE id = ANY($1)`, [[THREAD_ID, OTHER_THREAD_ID]]);
  await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1)`, [[THREAD_ID, OTHER_THREAD_ID]]);
  await pool.query(`DELETE FROM public.agents WHERE id = ANY($1)`, [[AGENT_ID, OTHER_AGENT_ID]]);
}

const log = (runId: string, agentId: string, tool: string, marker: string) =>
  AgentActivityLog.logActivity({
    agentId,
    runId,
    actionType: 'tool_call',
    triggerType: 'manual',
    tool,
    toolOutput: { marker },
  });

describe('AgentActivityLog.getLatestByTool', () => {
  beforeAll(async () => {
    await cleanup();
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    await Threads.create({ id: OTHER_THREAD_ID, title: `${PREFIX} other thread` });
    await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
    await Agents.create({ id: OTHER_AGENT_ID, name: `${PREFIX}-other-agent` });
    for (const [run, thread, agent] of [
      [RUN_ID, THREAD_ID, AGENT_ID],
      [OTHER_RUN_ID, OTHER_THREAD_ID, AGENT_ID],
    ] as const) {
      await Runs.create({
        id: run,
        threadId: thread,
        agentId: agent,
        providerId: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        status: 'completed',
      });
    }
  });
  afterAll(cleanup);

  it('returns the newest row of that tool for this thread and agent only', async () => {
    await log(RUN_ID, AGENT_ID, 'compaction_summary', 'first');
    await new Promise((resolve) => setTimeout(resolve, 15));
    await log(RUN_ID, AGENT_ID, 'compaction_summary', 'second');
    await log(RUN_ID, AGENT_ID, 'thread_summary', 'digest');
    await log(OTHER_RUN_ID, AGENT_ID, 'compaction_summary', 'other thread');

    const latest = await AgentActivityLog.getLatestByTool(
      THREAD_ID,
      AGENT_ID,
      'compaction_summary'
    );
    expect(latest?.toolOutput).toEqual({ marker: 'second' });

    expect(
      await AgentActivityLog.getLatestByTool(THREAD_ID, OTHER_AGENT_ID, 'compaction_summary')
    ).toBeNull();
    expect(
      (await AgentActivityLog.getLatestByTool(OTHER_THREAD_ID, AGENT_ID, 'compaction_summary'))
        ?.toolOutput
    ).toEqual({ marker: 'other thread' });
    expect(
      (await AgentActivityLog.getLatestByTool(THREAD_ID, AGENT_ID, 'thread_summary'))?.toolOutput
    ).toEqual({ marker: 'digest' });
  });
});
