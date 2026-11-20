/**
 * agent_activity filters against the real activity log.
 *
 * Filters run in SQL before LIMIT, so a matching row past the first `limit`
 * entries is still found; the `tool` filter matches canonical and legacy
 * stored names; self_history honors run_id; an empty filtered result carries
 * a one-line hint.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { getDb, Threads } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { Runs } from '@snaglet/db/tables/runs';
import agentActivity from '@server/services/ToolService/handlers/agents/agentActivity';

const PREFIX = 'act-filter-it';
const AGENT_ID = `agent-${PREFIX}`;
const THREAD_ID = `thread-${PREFIX}`;
const RUN_A = `run-${PREFIX}-a`;
const RUN_B = `run-${PREFIX}-b`;
const BASE_TIME = Date.parse('2026-05-01T00:00:00.000Z');

let seq = 0;

async function log(runId: string, tool: string | null, actionType: 'tool_call' | 'thinking') {
  const row = await AgentActivityLog.logActivity({
    agentId: AGENT_ID,
    runId,
    actionType,
    triggerType: 'manual',
    ...(tool ? { tool, toolInput: { n: seq }, toolOutput: { ok: true } } : {}),
    ...(actionType === 'thinking' ? { content: `thought ${seq}` } : {}),
  });
  await getDb().query(`UPDATE public.agent_activity_log SET created_at = $2 WHERE id = $1`, [
    row.id,
    new Date(BASE_TIME + seq * 1000).toISOString(),
  ]);
  seq += 1;
}

const ctx = { agentId: AGENT_ID, threadId: THREAD_ID } as never;

async function call(params: Record<string, unknown>) {
  return JSON.parse((await agentActivity(params, {} as never, ctx)) as string);
}

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.agent_activity_log WHERE agent_id = $1`, [AGENT_ID]);
  await pool.query(`DELETE FROM public.runs WHERE id LIKE $1`, [`run-${PREFIX}-%`]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT_ID]);
}

describe('agent_activity row filters (real DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
    await Threads.create({ id: THREAD_ID, title: PREFIX });
    for (const [id, offset] of [
      [RUN_A, 0],
      [RUN_B, 100],
    ] as const) {
      await Runs.create({
        id,
        threadId: THREAD_ID,
        agentId: AGENT_ID,
        providerId: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        status: 'completed',
        startedAt: new Date(BASE_TIME + offset * 1000).toISOString(),
      });
    }
    // Run A: 40 unrelated calls, then one legacy-named thread_send at the very end.
    for (let i = 0; i < 40; i += 1) await log(RUN_A, 'shell', 'tool_call');
    await log(RUN_A, 'thread_send', 'tool_call');
    // Run B (more recent): a legacy exec_command row, a canonical shell row, a thought.
    seq = 100;
    await log(RUN_B, 'exec_command', 'tool_call');
    await log(RUN_B, 'shell', 'tool_call');
    await log(RUN_B, null, 'thinking');
  });
  afterAll(cleanup);

  it('self_history + run_id + tool finds a row past the default limit', async () => {
    const out = await call({ view: 'self_history', run_id: RUN_A, tool: 'thread_send' });
    expect(out.total_entries).toBe(1);
    expect(out.entries[0]).toMatchObject({ run_id: RUN_A, tool: 'thread_send' });
    expect(out.hint).toBeUndefined();
  });

  it('self_history uses run_id instead of the latest run', async () => {
    const out = await call({ view: 'self_history', run_id: RUN_A, limit: 100 });
    expect(out.total_entries).toBe(41);
    expect(new Set(out.entries.map((e: { run_id: string }) => e.run_id))).toEqual(new Set([RUN_A]));
  });

  it('tool filter matches the canonical id and legacy stored names both ways', async () => {
    const byCanonical = await call({ view: 'self_history', run_id: RUN_B, tool: 'shell' });
    expect(byCanonical.entries.map((e: { tool: string }) => e.tool).sort()).toEqual([
      'exec_command',
      'shell',
    ]);
    const byLegacy = await call({ view: 'self_history', run_id: RUN_B, tool: 'exec_command' });
    expect(byLegacy.total_entries).toBe(2);
  });

  it('last_n_runs picks the runs that match, not just the newest', async () => {
    const out = await call({ view: 'self_history', last_n_runs: 1, tool: 'thread_send' });
    expect(out.total_entries).toBe(1);
    expect(out.entries[0].run_id).toBe(RUN_A);
  });

  it('action_type filters in SQL on self_recent', async () => {
    const out = await call({ view: 'self_recent', run_id: RUN_B, action_type: 'thinking' });
    expect(out.count).toBe(1);
    expect(out.entries[0].action).toBe('thinking');
  });

  it('an empty filtered result returns a one-line hint', async () => {
    const out = await call({ view: 'self_history', run_id: RUN_A, action_type: 'thread_send' });
    expect(out.total_entries).toBe(0);
    expect(out.hint).toBe(
      'No entries matched. action_type is tool_call|thinking; filter by tool name with tool.'
    );
    const recent = await call({ view: 'self_recent', run_id: RUN_A, tool: 'nope' });
    expect(recent.count).toBe(0);
    expect(recent.hint).toMatch(/^No entries matched\./);
  });

  it('no hint when no filter was given', async () => {
    const out = await call({ view: 'self_history', run_id: `run-${PREFIX}-missing` });
    expect(out.total_entries).toBe(0);
    expect(out.hint).toBeUndefined();
  });
});
