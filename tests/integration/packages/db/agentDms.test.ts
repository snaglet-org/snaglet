/** Real PostgreSQL coverage of the agent DM schema: thread kind, the DM
 * pair key, the participant read cursor and the agent dm_enabled flag. */

import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { visibleThreadRowSql } from '@snaglet/db/tables/threads/visibility';
import { Agents, ThreadParticipants, Threads, getDb } from '@snaglet/db';

const PREFIX = 'dm1';
const THREAD = `thread-${PREFIX}-main`;
const DM_THREAD = `thread-${PREFIX}-dm`;
const DM_THREAD_B = `thread-${PREFIX}-dmb`;
const AGENT = `agent-${PREFIX}-a`;

async function cleanup(): Promise<void> {
  const pool = getDb();
  await pool.query(`DELETE FROM thread_participants WHERE thread_id = ANY($1::text[])`, [
    [THREAD, DM_THREAD, DM_THREAD_B],
  ]);
  await pool.query(`DELETE FROM members WHERE agent_id = $1`, [AGENT]);
  await pool.query(`DELETE FROM agents WHERE id = $1`, [AGENT]);
  await pool.query(`DELETE FROM nodes WHERE id = ANY($1::text[])`, [
    [THREAD, DM_THREAD, DM_THREAD_B],
  ]);
}

describe('agent DMs schema', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('threads default to kind chat', async () => {
    const thread = await Threads.create({ id: THREAD, title: 'Test thread' });
    expect(thread.kind).toBe('chat');
    expect(thread.dmPairKey).toBeNull();
  });

  it('creates a dm thread with a pair key', async () => {
    const thread = await Threads.create({
      id: DM_THREAD,
      kind: 'dm',
      dmPairKey: 'member-a:member-b',
    });
    expect(thread.kind).toBe('dm');
    expect(thread.dmPairKey).toBe('member-a:member-b');
  });

  it('hides a dm thread from lists but still resolves it by id', async () => {
    await Threads.create({ id: THREAD, title: 'Test thread' });
    await Threads.create({ id: DM_THREAD, kind: 'dm', dmPairKey: 'member-a:member-b' });
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    expect(ids(await Threads.listAllOrdered())).toContain(THREAD);
    expect(ids(await Threads.listAllOrdered())).not.toContain(DM_THREAD);
    expect(ids(await Threads.findFlat())).not.toContain(DM_THREAD);
    expect(ids(await Threads.list())).not.toContain(DM_THREAD);
    expect((await Threads.findById(DM_THREAD))?.kind).toBe('dm');
  });

  it('visibleThreadRowSql keeps LEFT JOIN misses and hides dm threads', async () => {
    const pool = getDb();
    const DOC = `doc-${PREFIX}-orient`;
    await Threads.create({ id: THREAD, title: 'Test thread' });
    await Threads.create({ id: DM_THREAD, kind: 'dm', dmPairKey: 'member-a:member-b' });
    await pool.query(`INSERT INTO nodes (id, type) VALUES ($1, 'doc')`, [DOC]);
    try {
      const { rows } = await pool.query(
        `SELECT n.id FROM public.nodes n
           LEFT JOIN public.threads t ON t.id = n.id
          WHERE n.id = ANY($1::text[]) AND ${visibleThreadRowSql('t')}`,
        [[DOC, THREAD, DM_THREAD]]
      );
      expect(rows.map((r: { id: string }) => r.id).sort()).toEqual([DOC, THREAD].sort());
    } finally {
      await pool.query(`DELETE FROM nodes WHERE id = $1`, [DOC]);
    }
  });

  it('dm thread requires a pair key', async () => {
    await expect(Threads.create({ id: DM_THREAD, kind: 'dm' })).rejects.toThrow();
    // The database refuses it too, not only the model.
    await getDb().query(`INSERT INTO nodes (id, type) VALUES ($1, 'thread')`, [DM_THREAD]);
    await expect(
      getDb().query(`INSERT INTO threads (id, kind) VALUES ($1, 'dm')`, [DM_THREAD])
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      getDb().query(`INSERT INTO threads (id, kind, dm_pair_key) VALUES ($1, 'chat', 'x:y')`, [
        DM_THREAD,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('pair key is unique', async () => {
    await Threads.create({ id: DM_THREAD, kind: 'dm', dmPairKey: 'member-a:member-b' });
    await expect(
      Threads.create({ id: DM_THREAD_B, kind: 'dm', dmPairKey: 'member-a:member-b' })
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('markRead sets last_read_at', async () => {
    await Threads.create({ id: THREAD, title: 'Test thread' });
    await Agents.create({
      id: AGENT,
      name: AGENT,
      providerId: null,
      modelId: null,
      credentialId: null,
    });
    const participant = await ThreadParticipants.addParticipant({
      threadId: THREAD,
      agentId: AGENT,
    });
    expect(participant.lastReadAt).toBeNull();

    const at = new Date('2026-01-02T03:04:05.000Z');
    await ThreadParticipants.markRead(THREAD, participant.memberId, at);
    const read = (await ThreadParticipants.listByThread(THREAD))[0];
    expect(new Date(read!.lastReadAt!).toISOString()).toBe(at.toISOString());

    await ThreadParticipants.markRead(THREAD, participant.memberId);
    const later = (await ThreadParticipants.listByThread(THREAD))[0];
    expect(new Date(later!.lastReadAt!).getTime()).toBeGreaterThan(at.getTime());
  });

  it('markRead never moves the cursor backwards', async () => {
    await Threads.create({ id: THREAD, title: 'Test thread' });
    await Agents.create({ id: AGENT, name: AGENT });
    const participant = await ThreadParticipants.addParticipant({
      threadId: THREAD,
      agentId: AGENT,
    });
    const future = new Date('2099-01-01T00:00:00.000Z');
    await ThreadParticipants.markRead(THREAD, participant.memberId, future);
    await ThreadParticipants.markRead(
      THREAD,
      participant.memberId,
      new Date('2026-01-02T03:04:05.000Z')
    );
    await ThreadParticipants.markRead(THREAD, participant.memberId);

    const read = (await ThreadParticipants.listByThread(THREAD))[0];
    expect(new Date(read!.lastReadAt!).toISOString()).toBe(future.toISOString());
  });

  it('agents default dm_enabled true', async () => {
    const agent = await Agents.create({
      id: AGENT,
      name: AGENT,
      providerId: null,
      modelId: null,
      credentialId: null,
    });
    expect(agent.dmEnabled).toBe(true);
  });
});
