/**
 * Integration test: the perception cap is a safety ceiling, not the binding
 * limit, and buildPerception latency stays flat as row counts grow from 40
 * toward the 500 ceiling.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, closeDatabase } from '@snaglet/db';
import { Threads } from '@snaglet/db/tables/threads';
import { perceptionService } from '@server/services/PerceptionService';
import { agentSettings } from '@server/services/settings/categories/agent';

const TEST_THREAD_ID = 'thread-integration-perception-cap';
const MESSAGE_COUNT = 520;

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [TEST_THREAD_ID]);
  // Message ids ride the node spine — drop their nodes rows too.
  await pool.query(`DELETE FROM public.nodes WHERE id LIKE 'ptest-msg-%'`);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1`, [TEST_THREAD_ID]);
}

describe('buildPerception — cap as safety ceiling (real DB)', () => {
  beforeAll(async () => {
    await cleanup();
    await Threads.create({ id: TEST_THREAD_ID, title: 'perception cap perf fixture' });
    const pool = getDb();
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM public.users LIMIT 1`);
    const userId = rows[0]?.id;
    if (userId === undefined) throw new Error('no user row available for fixture authorship');
    // 520 short user messages — past the 500 ceiling. messages.id FKs to
    // the node spine, so create the nodes rows first.
    await pool.query(
      `INSERT INTO public.nodes (id, type)
       SELECT 'ptest-msg-' || g, 'message' FROM generate_series(1, $1::int) g`,
      [MESSAGE_COUNT]
    );
    await pool.query(
      `INSERT INTO public.messages (id, thread_id, role, user_id, content)
       SELECT 'ptest-msg-' || g, $1, 'user', $2,
              'perception perf filler message number ' || g
         FROM generate_series(1, $3::int) g`,
      [TEST_THREAD_ID, userId, MESSAGE_COUNT]
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await closeDatabase();
  });

  it('registry default is the 500 safety ceiling', () => {
    expect(agentSettings.perceptionMaxMessages.default).toBe(500);
  });

  it('fetches up to the explicit limit', async () => {
    const messages = await perceptionService.buildPerception({
      threadId: TEST_THREAD_ID,
      agentId: 'agent-nonexistent',
      isGroup: false,
      agentNameMap: new Map(),
      messageLimit: 500,
    });
    // Solo path merges nothing and filters only empties — all 500 survive
    // (520 inserted, limit 500).
    expect(messages.length).toBe(500);
  });

  it('latency stays flat from 40 → 200 → 500 rows', async () => {
    const timeAt = async (limit: number): Promise<number> => {
      const t0 = Date.now();
      const messages = await perceptionService.buildPerception({
        threadId: TEST_THREAD_ID,
        agentId: 'agent-nonexistent',
        isGroup: true, // worst case: classification + XML wrapping per message
        agentNameMap: new Map(),
        messageLimit: limit,
      });
      const ms = Date.now() - t0;
      expect(messages.length).toBeGreaterThan(0);
      console.log(`[perception-perf] limit=${limit} duration_ms=${ms}`);
      return ms;
    };

    // Warm the connection/settings cache so the 40-row run isn't billed
    // for one-time setup.
    await timeAt(10);

    const at40 = await timeAt(40);
    const at200 = await timeAt(200);
    const at500 = await timeAt(500);

    // Generous CI-safe ceilings (the target is p95 < 50ms in steady state):
    // these bounds catch order-of-magnitude slowdowns, not jitter.
    expect(at40).toBeLessThan(500);
    expect(at200).toBeLessThan(750);
    expect(at500).toBeLessThan(1000);
  }, 30_000);
});
