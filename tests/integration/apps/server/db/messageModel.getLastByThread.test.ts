/**
 * Message thread reads against the real database use the deterministic
 * `(created_at, id)` keyset for both oldest-first lists and the maximum row,
 * matching the keyset `listAfter` pages on. Two head rows can share a
 * `created_at` (same-millisecond writes in a wave); if getLastByThread returned
 * the lower-id sibling, the voice catch-up seed (turnLoop) would pass that
 * cursor to `listAfter` and fold the higher-id sibling, already in context,
 * back in as a duplicate "catch-up" block.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Messages, Threads, Users } from '@snaglet/db';

const PREFIX = 'msg-getlast-test';
const THREAD_ID = `thread-${PREFIX}`;
// Same wall-clock instant for both head rows — forces the id tiebreaker to decide.
const SHARED_TS = '2026-07-05T12:00:00.000Z';
const LOW_ID = `message-${PREFIX}-aaa`;
const HIGH_ID = `message-${PREFIX}-zzz`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1 OR id LIKE $2`, [
    THREAD_ID,
    `message-${PREFIX}-%`,
  ]);
}

describe('Messages thread reads — composite (created_at, id) order', () => {
  beforeAll(async () => {
    await cleanup();
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    const user = await Users.getOrCreateLocalUser();
    // Create the high id first so any "insertion order" fallback would (wrongly)
    // favor it too — the assertion only holds if the id tiebreaker is real.
    await Messages.create({
      id: HIGH_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: `content ${HIGH_ID}`,
      agentId: null,
      userId: user.id,
    });
    await Messages.create({
      id: LOW_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: `content ${LOW_ID}`,
      agentId: null,
      userId: user.id,
    });
    // Collapse both rows onto the same created_at so only the id tiebreaker
    // can order them.
    await getDb().query(`UPDATE public.messages SET created_at = $1 WHERE id = ANY($2)`, [
      SHARED_TS,
      [HIGH_ID, LOW_ID],
    ]);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('returns the higher-id sibling when two head rows share created_at', async () => {
    const last = await Messages.getLastByThread(THREAD_ID);
    expect(last).not.toBeNull();
    expect(last!.id).toBe(HIGH_ID);
    expect(new Date(last!.createdAt).toISOString()).toBe(SHARED_TS);
  });

  it('lists equal-timestamp siblings in ascending id order', async () => {
    const messages = await Messages.listByThreadId(THREAD_ID);
    expect(messages.map((message) => message.id)).toEqual([LOW_ID, HIGH_ID]);
  });

  it('strictly-after page from that seed folds nothing (no duplicated context)', async () => {
    const seed = await Messages.getLastByThread(THREAD_ID);
    expect(seed).not.toBeNull();
    // This is exactly the voice catch-up read: listAfter from the seeded cursor.
    const after = await Messages.listAfter(THREAD_ID, {
      afterCreatedAt: seed!.createdAt,
      afterId: seed!.id,
      limit: 50,
    });
    expect(after).toEqual([]);
  });
});
