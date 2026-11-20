/**
 * A persisted compaction against the real database: the record is saved as a thread summary (a
 * thread_summaries row whose `compaction` column is set), and the next replay (buildReplayPayload)
 * leaves out exactly the units it folded and starts with its summary. Covers the lookup the unit
 * tests stub: the newest fold wins, a digest written after it does not hide it, another agent's
 * replay is untouched, a fold saved as an activity row is still applied, and the record
 * never shows up as a tool call.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.mock('@server/services/WebSocketService', () => ({
  wsService: { broadcastToChannel: jest.fn() },
}));

import { getDb, Messages, Threads, Users } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Runs } from '@snaglet/db/tables/runs';
import { AgentActivityLog } from '@snaglet/db/tables/agent_activity_log';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';
import { buildReplayPayload } from '@server/services/SocketService/handlers/chatPhases/replayLoader';
import { saveCompaction } from '@server/services/summary/compactionRecord';

const PREFIX = 'compaction-replay-it';
const THREAD_ID = `thread-${PREFIX}`;
const AGENT_ID = `agent-${PREFIX}`;
const OTHER_AGENT_ID = `agent-${PREFIX}-other`;
const RUN_ID = `run-${PREFIX}`;
const MESSAGE_IDS = [1, 2, 3, 4].map((n) => `message-${PREFIX}-${n}`);

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(
    `DELETE FROM public.nodes WHERE id IN (SELECT id FROM public.thread_summaries WHERE thread_id = $1)`,
    [THREAD_ID]
  );
  await pool.query(`DELETE FROM public.agent_activity_log WHERE agent_id = ANY($1)`, [
    [AGENT_ID, OTHER_AGENT_ID],
  ]);
  await pool.query(`DELETE FROM public.runs WHERE id = $1`, [RUN_ID]);
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1 OR id LIKE $2`, [
    THREAD_ID,
    `message-${PREFIX}-%`,
  ]);
  await pool.query(`DELETE FROM public.agents WHERE id = ANY($1)`, [[AGENT_ID, OTHER_AGENT_ID]]);
}

const text = (m: { content: unknown }) => JSON.stringify(m.content);

describe('compaction record applied by the real replay', () => {
  beforeAll(async () => {
    await cleanup();
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    await Agents.create({ id: AGENT_ID, name: `${PREFIX}-agent` });
    await Agents.create({ id: OTHER_AGENT_ID, name: `${PREFIX}-other-agent` });
    const user = await Users.getOrCreateLocalUser();
    await Runs.create({
      id: RUN_ID,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      providerId: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      status: 'completed',
    });
    for (const [i, id] of MESSAGE_IDS.entries()) {
      await Messages.create({
        id,
        threadId: THREAD_ID,
        role: 'user',
        content: `plain user line ${i + 1}`,
        agentId: null,
        userId: user.id,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  afterAll(cleanup);

  it('folds exactly the units up to the cut and starts with the summary', async () => {
    const before = await buildReplayPayload(THREAD_ID, AGENT_ID);
    expect(before.compaction).toBeNull();
    expect(before.units.map((u) => u.key.sortId)).toEqual(MESSAGE_IDS);

    const saved = await saveCompaction({
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      modelUsed: 'anthropic/test',
      record: {
        through: before.units[1]!.key,
        summary: 'First fold: lines one and two.',
        carryForward: '[current roster: x]',
        foldedUnits: 2,
      },
    });

    // It is a thread summary: current, versioned, with the fold in its column.
    expect(saved).toMatchObject({
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      summaryText: 'First fold: lines one and two.',
      isCurrent: true,
      version: 1,
      messagesCovered: 2,
      modelUsed: 'anthropic/test',
    });
    expect(saved.compaction).toMatchObject({
      folded_units: 2,
      carry_forward: '[current roster: x]',
    });
    expect((await ThreadSummaries.getByThreadAndAgent(THREAD_ID, AGENT_ID))?.id).toBe(saved.id);

    const after = await buildReplayPayload(THREAD_ID, AGENT_ID);
    expect(after.compaction?.summary).toBe('First fold: lines one and two.');
    expect(text(after.messages[0]!)).toContain('First fold: lines one and two.');
    expect(text(after.messages[0]!)).toContain('[current roster: x]');
    const rest = after.messages.slice(1).map(text).join('\n');
    expect(rest).toContain('plain user line 3');
    expect(rest).toContain('plain user line 4');
    expect(rest).not.toContain('plain user line 1');
    expect(rest).not.toContain('plain user line 2');
    expect(after.units.map((u) => u.key.sortId)).toEqual(MESSAGE_IDS.slice(2));
    expect(after.units.map((u) => u.end)).toEqual([2, 3]);
  });

  it('the newest record wins, and its summary carries the earlier text', async () => {
    const current = await buildReplayPayload(THREAD_ID, AGENT_ID);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await saveCompaction({
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      modelUsed: 'anthropic/test',
      record: {
        through: current.units[0]!.key,
        summary: 'First fold: lines one and two.\n\nSecond fold: line three.',
        foldedUnits: 3,
      },
    });
    expect(second.version).toBe(2);
    const after = await buildReplayPayload(THREAD_ID, AGENT_ID);
    const first = text(after.messages[0]!);
    expect(first).toContain('First fold: lines one and two.');
    expect(first).toContain('Second fold: line three.');
    expect(after.messages.slice(1).map(text).join('\n')).toContain('plain user line 4');
    expect(after.messages.slice(1).map(text).join('\n')).not.toContain('plain user line 3');
  });

  it('a digest written after the fold does not hide it from replay', async () => {
    const digest = await ThreadSummaries.insertNewVersion({
      id: `thread_summary-${PREFIX}-digest`,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      summaryText: 'A digest that covers everything.',
      messagesCovered: 4,
    });
    expect(digest.isCurrent).toBe(true);
    expect(digest.compaction).toBeNull();

    const latest = await ThreadSummaries.getLatestCompaction(THREAD_ID, AGENT_ID);
    expect(latest?.summaryText).toContain('Second fold: line three.');
    const after = await buildReplayPayload(THREAD_ID, AGENT_ID);
    const first = text(after.messages[0]!);
    expect(first).toContain('Second fold: line three.');
    expect(first).not.toContain('A digest that covers everything.');
  });

  it('applies a fold saved as an activity row', async () => {
    const LEGACY_AGENT = `agent-${PREFIX}-legacy`;
    await Agents.create({ id: LEGACY_AGENT, name: `${PREFIX}-legacy-agent` });
    try {
      const before = await buildReplayPayload(THREAD_ID, LEGACY_AGENT);
      await AgentActivityLog.logActivity({
        agentId: LEGACY_AGENT,
        runId: RUN_ID,
        actionType: 'tool_call',
        triggerType: 'cron',
        tool: 'compaction_summary',
        toolOutput: {
          through: before.units[0]!.key,
          summary: 'Legacy fold: line one.',
          folded_units: 1,
        },
      });
      const after = await buildReplayPayload(THREAD_ID, LEGACY_AGENT);
      expect(text(after.messages[0]!)).toContain('Legacy fold: line one.');
      expect(after.messages.slice(1).map(text).join('\n')).not.toContain('plain user line 1');
    } finally {
      await getDb().query(`DELETE FROM public.agent_activity_log WHERE agent_id = $1`, [
        LEGACY_AGENT,
      ]);
      await getDb().query(`DELETE FROM public.agents WHERE id = $1`, [LEGACY_AGENT]);
    }
  });

  it('leaves another agent’s replay whole, and never replays the record as a tool call', async () => {
    const other = await buildReplayPayload(THREAD_ID, OTHER_AGENT_ID);
    expect(other.compaction).toBeNull();
    expect(other.messages).toHaveLength(4);
    const own = await buildReplayPayload(THREAD_ID, AGENT_ID);
    expect(JSON.stringify(own.messages)).not.toContain('tool_use');
  });
});
