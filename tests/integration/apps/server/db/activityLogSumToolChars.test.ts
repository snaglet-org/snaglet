/**
 * AgentActivityLog.sumToolChars against the real database: the digest trigger sizes tool work with
 * one aggregate, so it must count only this thread and agent, only tool calls after the boundary,
 * cap each row, and leave summary bookkeeping rows out.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Threads } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Runs } from '@snaglet/db/tables/runs';

const PREFIX = 'sum-tool-chars-it';
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

const call = (runId: string, agentId: string, tool: string, input: string, output: string) =>
  AgentActivityLog.logActivity({
    agentId,
    runId,
    actionType: 'tool_call',
    triggerType: 'manual',
    tool,
    toolInput: { text: input },
    toolOutput: output as never,
  });

describe('AgentActivityLog.sumToolChars', () => {
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

  it('counts this thread and agent, caps each row, skips summary rows, honors the boundary', async () => {
    await call(RUN_ID, AGENT_ID, 'file', 'a'.repeat(100), 'b'.repeat(900)); // ~1,000 plus JSON
    await call(RUN_ID, AGENT_ID, 'file', 'c', 'd'.repeat(50_000)); // capped
    await call(RUN_ID, AGENT_ID, 'thread_summary', 'x', 'y'.repeat(20_000)); // bookkeeping
    await call(RUN_ID, AGENT_ID, 'compaction_summary', 'x', 'y'.repeat(20_000)); // bookkeeping
    await call(OTHER_RUN_ID, AGENT_ID, 'file', 'z', 'z'.repeat(5_000)); // other thread

    const all = await AgentActivityLog.sumToolChars(THREAD_ID, AGENT_ID, null, 12_000);
    expect(all).toBeGreaterThan(12_000);
    expect(all).toBeLessThan(12_000 + 2_000);

    expect(await AgentActivityLog.sumToolChars(THREAD_ID, OTHER_AGENT_ID, null)).toBe(0);
    expect(await AgentActivityLog.sumToolChars(OTHER_THREAD_ID, AGENT_ID, null)).toBeGreaterThan(
      5_000
    );

    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await AgentActivityLog.sumToolChars(THREAD_ID, AGENT_ID, future)).toBe(0);
  });
});
