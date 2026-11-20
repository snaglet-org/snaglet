import { beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Messages, Threads, Users } from '@snaglet/db';

const THREAD_ID = 'thread-find-pagination-test';
const IDS = ['message-find-a', 'message-find-b', 'message-find-c'];

describe('chat find history pagination', () => {
  beforeAll(async () => {
    await Threads.create({ id: THREAD_ID, title: 'Find pagination test' });
    const user = await Users.getOrCreateLocalUser();
    for (const id of IDS)
      await Messages.create({
        id,
        threadId: THREAD_ID,
        role: 'user',
        content: 'Search target',
        userId: user.id,
        agentId: null,
      });
    await getDb().query('UPDATE public.messages SET created_at = $1 WHERE thread_id = $2', [
      '2026-01-01T12:00:00.000999Z',
      THREAD_ID,
    ]);
  });

  it('reads every same-timestamp sibling exactly once across backwards page boundaries', async () => {
    const visited: string[] = [];
    let beforeId: string | undefined;
    for (let page = 0; page < 5; page++) {
      const rows = await Messages.listForThreadRead(THREAD_ID, { limit: 1, beforeId });
      if (!rows.length) break;
      visited.push(rows[0].id);
      const more = await Messages.hasOlderThan(THREAD_ID, {
        id: rows[0].id,
        createdAt: rows[0].createdAt,
      });
      if (!more) break;
      beforeId = rows[0].id;
    }
    expect(visited).toEqual([...IDS].reverse());
  });

  it('retains microsecond precision for forward pagination and around windows', async () => {
    const anchor = await Messages.findById(IDS[1]);
    expect(anchor).not.toBeNull();
    // A deliberate millisecond-truncated wire timestamp must not fold the
    // anchor itself back into a strictly-after page.
    const timestamp = new Date(anchor!.createdAt).toISOString();
    const after = await Messages.listAfter(THREAD_ID, {
      afterId: IDS[1],
      afterCreatedAt: timestamp,
      limit: 10,
    });
    expect(after.map((message) => message.id)).toEqual([IDS[2]]);
    const context = await Messages.getContextWindow(IDS[1], { before: 1, after: 1 });
    expect(context?.messages.map((message) => message.id)).toEqual(IDS);
  });

  it('keeps the legacy timestamp-only read contract', async () => {
    const rows = await Messages.listForThreadRead(THREAD_ID, {
      limit: 10,
      before: '2026-01-02T00:00:00Z',
    });
    expect(rows.map((message) => message.id)).toEqual(IDS);
  });
});
