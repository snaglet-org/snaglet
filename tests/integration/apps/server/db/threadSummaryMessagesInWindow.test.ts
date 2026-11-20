/**
 * `messagesInWindow` (the read-time delta a summary card shows) against the
 * real database. `messages_covered` is stored cumulatively across versions (the
 * trim service depends on that), so the model derives `messages_in_window` as
 * GREATEST(messages_covered - MAX(prior.messages_covered), 0) over earlier
 * versions in the same (thread, agent) scope. Pinned: ladders show the
 * per-compaction delta; the first version's delta is its own count; a
 * predecessor repaired to 0 is bridged by the MAX; a repaired current row
 * clamps at 0; agent scopes (and the shared agent_id IS NULL scope) are
 * independent.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { getDb, Threads } from '@snaglet/db';
import { Agents } from '@snaglet/db/tables/agents';
import { ThreadSummaries } from '@snaglet/db/tables/thread_summaries';

const PREFIX = 'miw-it';
const AGENT_A = `agent-${PREFIX}-a`;
const AGENT_B = `agent-${PREFIX}-b`;

let seq = 0;

async function seedThread(suffix: string): Promise<string> {
  const threadId = `thread-${PREFIX}-${suffix}`;
  await Threads.create({ id: threadId, title: `${PREFIX} ${suffix}` });
  return threadId;
}

async function seedVersion(
  threadId: string,
  agentId: string | null,
  messagesCovered: number
): Promise<string> {
  seq += 1;
  const id = `thread_summary-${PREFIX}-${String(seq).padStart(4, '0')}`;
  await ThreadSummaries.insertNewVersion({
    id,
    threadId,
    agentId,
    summaryText: `summary ${seq}`,
    messagesCovered,
  });
  return id;
}

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.thread_summaries WHERE thread_id LIKE $1`, [
    `thread-${PREFIX}-%`,
  ]);
  await pool.query(`DELETE FROM public.threads WHERE id LIKE $1`, [`thread-${PREFIX}-%`]);
  await pool.query(`DELETE FROM public.nodes WHERE id LIKE $1 OR id LIKE $2`, [
    `thread-${PREFIX}-%`,
    `thread_summary-${PREFIX}-%`,
  ]);
  await pool.query(`DELETE FROM public.agents WHERE id IN ($1, $2)`, [AGENT_A, AGENT_B]);
}

describe('ThreadSummaries.messagesInWindow (derived per-compaction delta)', () => {
  beforeAll(async () => {
    await cleanup();
    await Agents.create({ id: AGENT_A, name: `${PREFIX}-a` });
    await Agents.create({ id: AGENT_B, name: `${PREFIX}-b` });
  });
  afterAll(cleanup);

  it('shows the delta per version on a cumulative ladder, and the raw cumulative field is untouched', async () => {
    const threadId = await seedThread('ladder');
    await seedVersion(threadId, AGENT_A, 830); // v1
    await seedVersion(threadId, AGENT_A, 845); // v2
    await seedVersion(threadId, AGENT_A, 857); // v3

    const rows = await ThreadSummaries.getHistoryByThreadAndAgent(threadId, AGENT_A);
    // Newest first.
    expect(rows.map((r) => r.version)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.messagesInWindow)).toEqual([12, 15, 830]);
    // The stored cumulative value is still what trim relies on.
    expect(rows.map((r) => r.messagesCovered)).toEqual([857, 845, 830]);
  });

  it("first version's delta equals its own covered count", async () => {
    const threadId = await seedThread('first');
    const id = await seedVersion(threadId, AGENT_A, 42);

    const row = await ThreadSummaries.findByIdWithNode(id);
    expect(row).not.toBeNull();
    expect(row!.version).toBe(1);
    expect(row!.messagesInWindow).toBe(42);
  });

  it('bridges a predecessor repaired to 0 instead of producing an absurd delta', async () => {
    const threadId = await seedThread('repair');
    await seedVersion(threadId, AGENT_A, 100); // v1
    const v2 = await seedVersion(threadId, AGENT_A, 120); // v2 — will be repaired to 0
    await seedVersion(threadId, AGENT_A, 150); // v3

    // Simulate trim repair resetting v2's coverage claim.
    await getDb().query(
      `UPDATE public.thread_summaries SET messages_covered = 0, last_message_id = NULL WHERE id = $1`,
      [v2]
    );

    const rows = await ThreadSummaries.getHistoryByThreadAndAgent(threadId, AGENT_A);
    const byVersion = new Map(rows.map((r) => [r.version, r]));
    // v3 diffs against MAX(v1=100, v2=0) = 100, not against v2's repaired 0.
    expect(byVersion.get(3)!.messagesInWindow).toBe(50);
    // The repaired row itself claims nothing and clamps at 0 (0 - 100 < 0).
    expect(byVersion.get(2)!.messagesInWindow).toBe(0);
    expect(byVersion.get(1)!.messagesInWindow).toBe(100);
  });

  it('clamps a repaired current row at 0 rather than going negative', async () => {
    const threadId = await seedThread('neg');
    await seedVersion(threadId, AGENT_A, 200); // v1
    const v2 = await seedVersion(threadId, AGENT_A, 240); // v2 current

    await getDb().query(`UPDATE public.thread_summaries SET messages_covered = 0 WHERE id = $1`, [
      v2,
    ]);

    const rows = await ThreadSummaries.getHistoryByThreadAndAgent(threadId, AGENT_A);
    const current = rows.find((r) => r.version === 2)!;
    expect(current.messagesInWindow).toBe(0);
  });

  it('keeps per-agent and shared scopes independent', async () => {
    const threadId = await seedThread('scopes');
    await seedVersion(threadId, AGENT_A, 100); // A v1
    await seedVersion(threadId, AGENT_B, 7); // B v1
    await seedVersion(threadId, null, 30); // shared v1
    await seedVersion(threadId, AGENT_A, 110); // A v2
    await seedVersion(threadId, null, 45); // shared v2

    const aRows = await ThreadSummaries.getHistoryByThreadAndAgent(threadId, AGENT_A);
    expect(aRows.map((r) => [r.version, r.messagesInWindow])).toEqual([
      [2, 10],
      [1, 100],
    ]);

    const bRows = await ThreadSummaries.getHistoryByThreadAndAgent(threadId, AGENT_B);
    expect(bRows.map((r) => [r.version, r.messagesInWindow])).toEqual([[1, 7]]);

    // Shared (agent_id IS NULL) scope diffs only against itself.
    const shared = await ThreadSummaries.getByThread(threadId);
    expect(shared).not.toBeNull();
    expect(shared!.version).toBe(2);
    expect(shared!.messagesInWindow).toBe(15);
  });
});
