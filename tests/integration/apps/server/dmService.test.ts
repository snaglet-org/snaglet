/**
 * DmService against a real database: one DM thread per pair of members (also
 * under a race), sends that persist and broadcast but never wake anyone, the
 * dm_enabled and body limits, and the unread cursor.
 *
 * Only socket fan-out and the dispatch wave are stubbed. The dispatch stub is
 * how the no-wake guarantee is asserted.
 */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const broadcastToChannel = jest.fn();
jest.mock('@server/services/WebSocketService', () => ({
  wsService: {
    sendToClient: jest.fn(),
    broadcastToChannel: (...a: unknown[]) => broadcastToChannel(...a),
    registerHandler: jest.fn(),
  },
  addChannelObserver: jest.fn(),
}));
const dispatchToThread = jest.fn(async () => ({
  ok: true as const,
  wakeCount: 0,
  capHit: false,
  reason: 'completed' as const,
}));
jest.mock('@server/services/SocketService/dispatch/dispatchToThread', () => ({
  dispatchToThread: (...a: unknown[]) => dispatchToThread(...(a as [])),
  dispatchToThreadInternal: jest.fn(),
  redispatchPersistedMessage: jest.fn(async () => undefined),
}));

import { getDb } from '@snaglet/db';
import { transaction } from '@snaglet/db/db';
import { Agents } from '@snaglet/db/tables/agents';
import { Members } from '@snaglet/db/tables/members';
import { Messages } from '@snaglet/db/tables/messages';
import { ThreadParticipants } from '@snaglet/db/tables/thread_participants';
import { Threads } from '@snaglet/db/tables/threads';
import { Users } from '@snaglet/db/tables/users';
import { hooks, type HookEventMap } from '@server/services/HookService';
import { postAgentMessageToThread } from '@server/services/ThreadDeliveryPolicyService';
import { DmService, type DmParty } from '@server/services/dm/DmService';
import { dmPairKey } from '@server/services/dm/dmPairKey';

const AGENT_A = 'test-agent-a';
const AGENT_B = 'test-agent-b';
const AGENT_C = 'test-agent-c';
const CHAT_THREAD = 'thread-dm-service-chat';
const A: DmParty = { kind: 'agent', agentId: AGENT_A };
const B: DmParty = { kind: 'agent', agentId: AGENT_B };
const C: DmParty = { kind: 'agent', agentId: AGENT_C };
let USER: DmParty;
let userId: string;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

const dmThreadCount = () =>
  count(`SELECT count(*)::int AS n FROM public.threads WHERE kind = 'dm'`);
const dmMessageCount = () =>
  count(
    `SELECT count(*)::int AS n FROM public.messages m
       JOIN public.threads t ON t.id = m.thread_id
      WHERE t.kind = 'dm'`
  );
/** Thread spine rows with no threads row: what a rolled-back create must not leave. */
const orphanThreadNodes = () =>
  count(
    `SELECT count(*)::int AS n FROM public.nodes n
      WHERE n.type = 'thread'
        AND NOT EXISTS (SELECT 1 FROM public.threads t WHERE t.id = n.id)`
  );

async function memberOf(party: DmParty): Promise<string> {
  const member =
    party.kind === 'agent'
      ? await Members.findByAgent(party.agentId)
      : await Members.findByUser(party.userId);
  if (!member) throw new Error(`no member for ${JSON.stringify(party)}`);
  return member.id;
}

async function setDmEnabled(agentId: string, enabled: boolean): Promise<void> {
  await getDb().query(`UPDATE public.agents SET dm_enabled = $2 WHERE id = $1`, [agentId, enabled]);
}

async function pinCreatedAt(messageId: string, at: string): Promise<void> {
  await getDb().query(`UPDATE public.messages SET created_at = $2 WHERE id = $1`, [messageId, at]);
}

async function clearDms(): Promise<void> {
  const db = getDb();
  // Deleting the thread spine rows cascades to messages and participants.
  await db.query(
    `DELETE FROM public.nodes WHERE id IN (SELECT id FROM public.threads WHERE kind = 'dm')`
  );
  await db.query(`DELETE FROM public.nodes WHERE id = $1`, [CHAT_THREAD]);
  await db.query(`DELETE FROM public.notifications WHERE type = 'thread_activity'`);
  await db.query(`UPDATE public.agents SET dm_enabled = true WHERE id = ANY($1::text[])`, [
    [AGENT_A, AGENT_B, AGENT_C],
  ]);
}

beforeAll(async () => {
  for (const [id, name] of [
    [AGENT_A, 'Test Agent A'],
    [AGENT_B, 'Test Agent B'],
    [AGENT_C, 'Test Agent C'],
  ] as const) {
    if (!(await Agents.findById(id))) await Agents.create({ id, name });
  }
  const user =
    (await Users.findByName('Test User')) ??
    (await Users.createLocalUser({ name: 'Test User', email: 'user@example.com' }));
  userId = user.id;
  USER = { kind: 'user', userId };
});

// No afterAll cleanup: this file's database is a throwaway clone that the
// shared teardown drops.
beforeEach(async () => {
  await clearDms();
  jest.clearAllMocks();
});

describe('DmService.findOrCreate', () => {
  it('findOrCreate twice returns one thread', async () => {
    const first = await DmService.findOrCreate(A, USER);
    const second = await DmService.findOrCreate(USER, A);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      kind: 'dm',
      title: 'Test Agent A ↔ Test User',
      projectId: null,
      dispatchMode: 'mentioned',
      dmPairKey: dmPairKey(await memberOf(A), await memberOf(USER)),
    });
    const participants = await ThreadParticipants.listByThread(first.id);
    expect(participants.map((p) => p.memberId).sort()).toEqual(
      [await memberOf(A), await memberOf(USER)].sort()
    );
    // One agent participant: dispatch treats a user to agent DM as a solo thread.
    expect(participants.filter((p) => p.kind === 'agent')).toHaveLength(1);
    expect(await dmThreadCount()).toBe(1);
  });

  it('parallel findOrCreate for one pair yields one thread', async () => {
    const orphansBefore = await orphanThreadNodes();
    const threads = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        i % 2 === 0 ? DmService.findOrCreate(A, B) : DmService.findOrCreate(B, A)
      )
    );

    expect(new Set(threads.map((t) => t.id)).size).toBe(1);
    expect(await dmThreadCount()).toBe(1);
    expect(await ThreadParticipants.listByThread(threads[0]!.id)).toHaveLength(2);
    expect(await orphanThreadNodes()).toBe(orphansBefore);
  });

  it('a create that loses the race returns the winner and leaves no orphan node', async () => {
    const key = dmPairKey(await memberOf(A), await memberOf(B));
    const orphansBefore = await orphanThreadNodes();
    let racer: Promise<{ id: string }> | null = null;

    // The winner's insert is held open in this transaction while the racer
    // runs: the racer must block on the unique pair key, then take this row.
    const winner = await transaction(async (tx) => {
      const thread = await Threads.create(
        { id: 'thread-dm-service-winner', kind: 'dm', dmPairKey: key, title: 'winner' },
        tx
      );
      racer = DmService.findOrCreate(A, B);
      const deadline = Date.now() + 10_000;
      while (
        (await count(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`
        )) === 0
      ) {
        if (Date.now() > deadline) throw new Error('the racer never blocked on the pair key');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return thread;
    });

    expect((await racer!).id).toBe(winner.id);
    expect(await dmThreadCount()).toBe(1);
    expect(await orphanThreadNodes()).toBe(orphansBefore);
  });

  it('rejects two identical parties', async () => {
    await expect(DmService.findOrCreate(A, A)).rejects.toMatchObject({ statusCode: 400 });
    await expect(DmService.findOrCreate(USER, USER)).rejects.toMatchObject({ statusCode: 400 });
    expect(await dmThreadCount()).toBe(0);
  });

  it('refuses an unknown agent and a dm_enabled=false agent', async () => {
    await expect(
      DmService.findOrCreate(USER, { kind: 'agent', agentId: 'agent-missing' })
    ).rejects.toMatchObject({ statusCode: 404 });
    await setDmEnabled(AGENT_C, false);
    await expect(DmService.findOrCreate(USER, C)).rejects.toMatchObject({ statusCode: 409 });
    expect(await dmThreadCount()).toBe(0);
  });

  it('a new DM thread takes no slot in the flat thread list', async () => {
    await Threads.create({ id: CHAT_THREAD, title: 'Test thread' });
    const before = (await Threads.findById(CHAT_THREAD))!.sortOrder;
    await DmService.findOrCreate(A, B);
    expect((await Threads.findById(CHAT_THREAD))!.sortOrder).toBe(before);
  });
});

describe('DmService.send', () => {
  it('send inserts a message with the sender as author', async () => {
    const seen: Array<HookEventMap['message:create']> = [];
    const listener = (payload: HookEventMap['message:create']) => seen.push(payload);
    hooks.on('message:create', listener);
    try {
      const { messageId, threadId } = await DmService.send({
        from: A,
        to: B,
        content: '  hello there  ',
      });

      expect(await Messages.findById(messageId)).toMatchObject({
        threadId,
        role: 'assistant',
        agentId: AGENT_A,
        userId: null,
        content: 'hello there',
        messageType: 'message',
      });
      expect(await Threads.findById(threadId)).toMatchObject({
        kind: 'dm',
        title: 'Test Agent A ↔ Test Agent B',
      });
      expect(broadcastToChannel).toHaveBeenCalledWith(
        threadId,
        expect.objectContaining({
          type: 'socket:chat:message_created',
          payload: expect.objectContaining({
            id: messageId,
            threadId,
            role: 'assistant',
            agent_id: AGENT_A,
            content: 'hello there',
            message_type: 'message',
          }),
        })
      );
      expect(seen).toEqual([
        expect.objectContaining({
          id: messageId,
          threadId,
          role: 'agent',
          agentId: AGENT_A,
          text: 'hello there',
        }),
      ]);
    } finally {
      hooks.off('message:create', listener);
    }
  });

  it('send to a dm_enabled=false agent throws and inserts nothing', async () => {
    await setDmEnabled(AGENT_C, false);
    await expect(DmService.send({ from: A, to: C, content: 'hi' })).rejects.toThrow(
      /DMs are turned off for Test Agent C/
    );
    expect(await dmThreadCount()).toBe(0);
    expect(await dmMessageCount()).toBe(0);

    // An existing thread does not get past the check either, in either direction.
    await DmService.send({ from: A, to: B, content: 'before' });
    await setDmEnabled(AGENT_B, false);
    await expect(DmService.send({ from: A, to: B, content: 'to' })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(DmService.send({ from: B, to: A, content: 'from' })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(DmService.listUnread(AGENT_B)).rejects.toMatchObject({ statusCode: 409 });
    expect(await dmThreadCount()).toBe(1);
    expect(await dmMessageCount()).toBe(1);
  });

  it('send to self throws', async () => {
    await expect(DmService.send({ from: A, to: A, content: 'note to self' })).rejects.toThrow(
      /yourself/
    );
    expect(await dmThreadCount()).toBe(0);
    expect(await dmMessageCount()).toBe(0);
  });

  it('send rejects empty and 4001-char bodies', async () => {
    for (const content of ['', '  \n\t  ', 'a'.repeat(4001)]) {
      await expect(DmService.send({ from: A, to: B, content })).rejects.toMatchObject({
        statusCode: 400,
      });
    }
    expect(await dmThreadCount()).toBe(0);

    const atLimit = await DmService.send({ from: A, to: B, content: ` ${'a'.repeat(4000)} ` });
    expect((await Messages.findById(atLimit.messageId))?.content).toHaveLength(4000);
  });

  it('send refuses a user sender: the user DMs through the chat path', async () => {
    await expect(DmService.send({ from: USER, to: A, content: 'hi' })).rejects.toThrow(/chat/);
    expect(await dmThreadCount()).toBe(0);
  });

  it('send to the user raises a thread_activity notification', async () => {
    const sent = await DmService.send({ from: A, to: USER, content: 'Build finished' });
    const { rows } = await getDb().query(
      `SELECT type, title, body, thread_id, agent_id FROM public.notifications
        WHERE thread_id = $1`,
      [sent.threadId]
    );
    expect(rows).toEqual([
      {
        type: 'thread_activity',
        title: 'Test Agent A sent you a DM',
        body: 'Build finished',
        thread_id: sent.threadId,
        agent_id: AGENT_A,
      },
    ]);

    const peer = await DmService.send({ from: A, to: B, content: 'peer note' });
    expect(
      await count(`SELECT count(*)::int AS n FROM public.notifications WHERE thread_id = $1`, [
        peer.threadId,
      ])
    ).toBe(0);
  });

  it('send never calls dispatchToThread', async () => {
    await DmService.send({ from: A, to: B, content: 'peer note' });
    await DmService.send({ from: A, to: USER, content: 'user note' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatchToThread).not.toHaveBeenCalled();

    // Control: the stub is the one a waking send goes through.
    await Threads.create({ id: CHAT_THREAD, title: 'Test thread' });
    await postAgentMessageToThread({ threadId: CHAT_THREAD, agentId: AGENT_A, content: 'wake' });
    expect(dispatchToThread).toHaveBeenCalledTimes(1);
  });
});

describe('DmService unread and markRead', () => {
  it('unread excludes own messages and respects the cursor (NULL cursor counts all)', async () => {
    const first = await DmService.send({ from: A, to: B, content: 'first' });
    const second = await DmService.send({ from: A, to: B, content: 'second' });
    const reply = await DmService.send({ from: B, to: A, content: 'reply' });
    await pinCreatedAt(first.messageId, '2026-01-01T00:00:00Z');
    await pinCreatedAt(second.messageId, '2026-01-01T00:02:00Z');
    await pinCreatedAt(reply.messageId, '2026-01-01T00:03:00Z');
    const memberA = await memberOf(A);
    const memberB = await memberOf(B);

    // NULL cursors: everything from the other side, nothing of one's own.
    expect(await DmService.unreadSummary(memberB)).toEqual([
      { fromName: 'Test Agent A', fromKind: 'agent', count: 2 },
    ]);
    expect(await DmService.unreadSummary(memberA)).toEqual([
      { fromName: 'Test Agent B', fromKind: 'agent', count: 1 },
    ]);
    const unreadB = await DmService.listUnread(AGENT_B);
    expect(unreadB.map((u) => [u.fromName, u.content])).toEqual([
      ['Test Agent A', 'first'],
      ['Test Agent A', 'second'],
    ]);
    expect(unreadB[0]).toMatchObject({ threadId: first.threadId, messageId: first.messageId });
    expect((await DmService.listUnread(AGENT_A)).map((u) => u.content)).toEqual(['reply']);

    // A cursor between the two: only the later one is unread.
    await ThreadParticipants.markRead(first.threadId, memberB, new Date('2026-01-01T00:01:00Z'));
    expect((await DmService.listUnread(AGENT_B)).map((u) => u.content)).toEqual(['second']);
    expect(await DmService.unreadSummary(memberB)).toEqual([
      { fromName: 'Test Agent A', fromKind: 'agent', count: 1 },
    ]);
  });

  it('the user and the agent each see the other side as unread', async () => {
    const sent = await DmService.send({ from: A, to: USER, content: 'for you' });
    // The user's reply takes the chat path; here it is written directly.
    await Messages.create({ threadId: sent.threadId, role: 'user', userId, content: 'thanks' });
    // Author-less narration is not mail.
    await Messages.createEvent({
      threadId: sent.threadId,
      content: 'Thread started',
      eventKind: 'thread_started',
    });

    expect(await DmService.unreadSummary(await memberOf(USER))).toEqual([
      { fromName: 'Test Agent A', fromKind: 'agent', count: 1 },
    ]);
    expect((await DmService.listUnread(AGENT_A)).map((u) => [u.fromName, u.content])).toEqual([
      ['Test User', 'thanks'],
    ]);
  });

  it('the unread predicate: a NULL cursor counts everything, the cursor is strict, own messages never count', async () => {
    const one = await DmService.send({ from: A, to: B, content: 'one' });
    await DmService.send({ from: A, to: B, content: 'two' });
    await DmService.send({ from: B, to: A, content: 'mine' });
    const memberB = await memberOf(B);

    // NULL cursor: both of A's messages, none of B's own.
    expect((await DmService.listUnread(AGENT_B)).map((u) => u.content)).toEqual(['one', 'two']);

    // A cursor exactly at the first message's created_at: strictly greater, so it is read.
    await DmService.markReadThrough(one.threadId, memberB, one.messageId);
    expect((await DmService.listUnread(AGENT_B)).map((u) => u.content)).toEqual(['two']);
    expect(
      (await DmService.listMail(AGENT_B, { all: true })).messages.map((m) => m.unread)
    ).toEqual([false, true]);
    expect(await DmService.unreadSummary(memberB)).toEqual([
      { fromName: 'Test Agent A', fromKind: 'agent', count: 1 },
    ]);
  });

  it('markRead zeroes the unread count', async () => {
    const sent = await DmService.send({ from: A, to: B, content: 'one' });
    await DmService.send({ from: A, to: B, content: 'two' });
    const memberB = await memberOf(B);
    expect((await DmService.unreadSummary(memberB))[0]?.count).toBe(2);

    await DmService.markRead(sent.threadId, memberB);

    expect(await DmService.unreadSummary(memberB)).toEqual([]);
    expect(await DmService.listUnread(AGENT_B)).toEqual([]);
  });

  it('markReadIfDm marks a DM thread read but leaves an ordinary thread alone', async () => {
    const sent = await DmService.send({ from: A, to: B, content: 'one' });
    const memberB = await memberOf(B);
    expect((await DmService.unreadSummary(memberB))[0]?.count).toBe(1);

    await DmService.markReadIfDm(sent.threadId, memberB);
    expect(await DmService.unreadSummary(memberB)).toEqual([]);

    // An ordinary thread the member sits in keeps its cursor.
    await Threads.create({ id: CHAT_THREAD, title: 'Test thread' });
    await ThreadParticipants.addParticipant({ threadId: CHAT_THREAD, agentId: AGENT_B });
    await ThreadParticipants.markRead(CHAT_THREAD, memberB, new Date('2026-01-01T00:00:00Z'));
    const cursor = async () =>
      (await ThreadParticipants.listByThread(CHAT_THREAD)).find((p) => p.memberId === memberB)
        ?.lastReadAt;
    const before = new Date((await cursor())!).toISOString();
    await DmService.markReadIfDm(CHAT_THREAD, memberB);
    expect(new Date((await cursor())!).toISOString()).toBe(before);
  });

  it('markRead never moves the cursor backwards', async () => {
    const sent = await DmService.send({ from: A, to: B, content: 'one' });
    const memberB = await memberOf(B);
    const later = new Date('2030-01-01T00:00:00Z');
    await ThreadParticipants.markRead(sent.threadId, memberB, later);
    await ThreadParticipants.markRead(sent.threadId, memberB, new Date('2026-01-01T00:00:00Z'));
    await DmService.markRead(sent.threadId, memberB);

    const cursor = (await ThreadParticipants.listByThread(sent.threadId)).find(
      (p) => p.memberId === memberB
    )?.lastReadAt;
    expect(new Date(cursor!).toISOString()).toBe(later.toISOString());
  });
});

describe('DmService.listMail and readThread', () => {
  it('lists unread oldest first, capped, and counts what remains', async () => {
    for (const text of ['one', 'two', 'three'])
      await DmService.send({ from: A, to: B, content: text });

    const page = await DmService.listMail(AGENT_B, { limit: 2 });
    expect(page.messages.map((m) => m.content)).toEqual(['one', 'two']);
    expect(page.remainingUnread).toBe(1);
  });

  it('all returns read messages too, flagged', async () => {
    const { threadId } = await DmService.send({ from: A, to: B, content: 'old' });
    await DmService.markRead(threadId, await memberOf(B));
    await DmService.send({ from: A, to: B, content: 'new' });

    const unreadOnly = await DmService.listMail(AGENT_B);
    expect(unreadOnly.messages.map((m) => m.content)).toEqual(['new']);
    const everything = await DmService.listMail(AGENT_B, { all: true });
    expect(everything.messages.map((m) => [m.content, m.unread])).toEqual([
      ['old', false],
      ['new', true],
    ]);
    expect(everything.remainingUnread).toBe(0);
  });

  it('readThread marks read only through the newest message returned', async () => {
    let threadId = '';
    for (const text of ['one', 'two', 'three']) {
      ({ threadId } = await DmService.send({ from: A, to: B, content: text }));
    }
    const first = await DmService.readThread(AGENT_B, threadId, 2);
    expect(first.messages.map((m) => m.content)).toEqual(['one', 'two']);
    expect(first.remainingUnread).toBe(1);

    const second = await DmService.readThread(AGENT_B, threadId, 2);
    expect(second.messages.map((m) => m.content)).toEqual(['three']);
    expect(second.remainingUnread).toBe(0);
    expect((await DmService.listMail(AGENT_B)).messages).toEqual([]);
  });

  it('readThread refuses a thread the agent is not in', async () => {
    const { threadId } = await DmService.send({ from: A, to: B, content: 'private' });
    await expect(DmService.readThread(AGENT_C, threadId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('markReadThrough keeps the sender own cursor at the sent message', async () => {
    await DmService.send({ from: B, to: A, content: 'question' });
    const sent = await DmService.send({ from: A, to: B, content: 'answer' });
    await DmService.markReadThrough(sent.threadId, await memberOf(A), sent.messageId);
    expect((await DmService.listMail(AGENT_A)).messages).toEqual([]);
  });

  it('markReadThrough ignores a message from another thread', async () => {
    const one = await DmService.send({ from: A, to: B, content: 'in A-B' });
    const other = await DmService.send({ from: C, to: B, content: 'in C-B' });
    await DmService.markReadThrough(one.threadId, await memberOf(B), other.messageId);
    expect((await DmService.listMail(AGENT_B)).messages.map((m) => m.content)).toContain('in A-B');
  });
});

describe('DmService.listThreadsForMember', () => {
  it('lists an agent its DM threads with the other party and unread, hidden from shared lists', async () => {
    const withUser = await DmService.send({ from: A, to: USER, content: 'for you' });
    const withB = await DmService.send({ from: B, to: A, content: 'hello A' });
    await DmService.send({ from: B, to: C, content: 'not A' });

    const listed = await DmService.listThreadsForMember(await memberOf(A));
    expect(listed.map((t) => t.id).sort()).toEqual([withUser.threadId, withB.threadId].sort());
    expect(listed.find((t) => t.id === withB.threadId)).toMatchObject({
      withName: 'Test Agent B',
      withKind: 'agent',
      withAgentId: AGENT_B,
      unread: 1,
    });
    expect(listed.find((t) => t.id === withUser.threadId)).toMatchObject({
      withName: 'Test User',
      withKind: 'user',
      unread: 0,
    });
    expect(listed.find((t) => t.id === withUser.threadId)).not.toHaveProperty('withAgentId');
    // The shared thread list never returns a DM thread.
    const shared = await Threads.listAllOrdered();
    expect(shared.map((t) => t.id)).not.toContain(withB.threadId);
  });

  it('thread-list unread equals the unreadSummary and listMail counts', async () => {
    await DmService.send({ from: B, to: A, content: 'one' });
    const two = await DmService.send({ from: B, to: A, content: 'two' });
    await DmService.send({ from: A, to: B, content: 'own reply' });
    await Messages.createEvent({
      threadId: two.threadId,
      content: 'Thread started',
      eventKind: 'thread_started',
    });
    const memberA = await memberOf(A);
    const summed = (await DmService.unreadSummary(memberA)).reduce((n, s) => n + s.count, 0);
    const mail = await DmService.listMail(AGENT_A);
    const listed = await DmService.listThreadsForMember(memberA);

    expect(listed.reduce((n, t) => n + t.unread, 0)).toBe(summed);
    expect(listed.reduce((n, t) => n + t.unread, 0)).toBe(mail.messages.length);
    expect(summed).toBe(2);
  });

  it("lists the user's threads, with unread cleared by markRead", async () => {
    const sent = await DmService.send({ from: A, to: USER, content: 'ping' });
    const userMember = await memberOf(USER);
    expect(await DmService.listThreadsForMember(userMember)).toMatchObject([
      { id: sent.threadId, withName: 'Test Agent A', withKind: 'agent', unread: 1 },
    ]);
    await DmService.markRead(sent.threadId, userMember);
    expect((await DmService.listThreadsForMember(userMember))[0].unread).toBe(0);
  });
});

describe('deleting an agent deletes its DM threads', () => {
  it('removes its DM threads with messages and participants, keeps other pairs', async () => {
    const { agentService } = await import('@server/services/AgentService');
    const a = await DmService.send({ from: A, to: USER, content: 'one' });
    const b = await DmService.send({ from: A, to: B, content: 'two' });
    const other = await DmService.send({ from: B, to: C, content: 'unrelated' });

    await agentService.purge(AGENT_A);

    const left = await getDb().query<{ id: string }>(
      `SELECT id FROM public.threads WHERE id = ANY($1::text[])`,
      [[a.threadId, b.threadId, other.threadId]]
    );
    expect(left.rows.map((r) => r.id)).toEqual([other.threadId]);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM public.messages WHERE thread_id = ANY($1::text[])`,
        [[a.threadId, b.threadId]]
      )
    ).toBe(0);
    expect(await orphanThreadNodes()).toBe(0);
    // Recreate for later tests in the file (none follow, but keep the fixture whole).
    await Agents.create({ id: AGENT_A, name: 'Test Agent A' });
  });
});
