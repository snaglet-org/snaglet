/**
 * Messages.create against the real database: a user message with
 * `metadata: null` (the common case, no persisted injection) still persists.
 * `public.messages.metadata` is `jsonb NOT NULL DEFAULT '{}'` and the chat-send
 * handler passes null when there is no injection, so MessageModel.foldMetadata
 * normalizes null to {}; otherwise the INSERT would throw and the agent would
 * never run.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Messages, Threads, Users } from '@snaglet/db';

const PREFIX = 'msgmeta-test';
const THREAD_ID = `thread-${PREFIX}`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM public.messages WHERE thread_id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.threads WHERE id = $1`, [THREAD_ID]);
  await pool.query(`DELETE FROM public.nodes WHERE id = $1 OR id LIKE $2`, [
    THREAD_ID,
    `message-${PREFIX}-%`,
  ]);
}

describe('Messages.create — metadata not-null invariant', () => {
  let userId: string;

  beforeAll(async () => {
    await cleanup();
    await Threads.create({ id: THREAD_ID, title: `${PREFIX} thread` });
    const user = await Users.getOrCreateLocalUser();
    userId = user.id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it('persists a message with metadata: null as {} (no constraint violation)', async () => {
    const id = `message-${PREFIX}-a`;
    await expect(
      Messages.create({
        id,
        threadId: THREAD_ID,
        role: 'user',
        content: 'hello',
        agentId: null,
        userId,
        metadata: null,
      })
    ).resolves.toBeDefined();

    const { rows } = await getDb().query<{ metadata: unknown }>(
      `SELECT metadata FROM public.messages WHERE id = $1`,
      [id]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({});
  });

  it('preserves real metadata when provided', async () => {
    const id = `message-${PREFIX}-b`;
    await Messages.create({
      id,
      threadId: THREAD_ID,
      role: 'user',
      content: 'hi',
      agentId: null,
      userId,
      metadata: { persistedInjection: 'ctx' },
    });

    const { rows } = await getDb().query<{ metadata: { persistedInjection?: string } }>(
      `SELECT metadata FROM public.messages WHERE id = $1`,
      [id]
    );
    expect(rows[0].metadata).toEqual({ persistedInjection: 'ctx' });
  });
});
