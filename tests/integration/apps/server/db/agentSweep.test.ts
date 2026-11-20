/**
 * Permanent agent delete (the ghost pattern) against the real database.
 * Deleting an agent destroys its private memories and thread summaries (via
 * their node spine, so no orphan nodes), repoints every kept reference to the
 * permanent `ghost` system agent (messages with an originalAgentName stamp,
 * runs, activity log, settings, member-keyed attribution), and deletes the
 * agent and member rows. A catalog scan then asserts no foreign key to
 * agents(id) or members(id) still references the deleted ids, so a new
 * referencing table cannot leave a dangling reference.
 */

import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { getDb, Agents, Members } from '@snaglet/db';
import { GHOST_AGENT_ID, GHOST_MEMBER_ID } from '@snaglet/shared/constants';
import { errorHandler } from '@server/middleware';
import archiveRouter from '@server/routes/archive';
import { getPanelToken } from '@server/middleware/panelAuth';

const PREFIX = 'ghost-purge-it';
const AGENT = `${PREFIX}-bill`;
const PEER = `${PREFIX}-peer`;
const THREAD = `${PREFIX}-thread`;
const MEMORY = `${PREFIX}-memory`;
const SUMMARY = `${PREFIX}-summary`;
const MESSAGE = `${PREFIX}-message`;
const CONTAINER = `${PREFIX}-container`;
const DOC = `${PREFIX}-doc`;
const RUN = `${PREFIX}-run`;
const ACTIVITY = `${PREFIX}-activity`;
const SOCKET = `${PREFIX}-socket`;
const SOCKET_PEER = `${PREFIX}-socket-peer`;
const PLACEMENT = `${PREFIX}-placement`;
const TP = `${PREFIX}-tp`;
// settings.category must match ^[a-z][a-z0-9_]*$ (no hyphens).
const SETTING_CAT = 'ghost_purge_it';
const ALL_AGENT_IDS = [AGENT, PEER];
const ALL_NODE_IDS = [THREAD, MEMORY, SUMMARY, MESSAGE, CONTAINER, DOC];

const AGENT_NAME = 'Bill';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/archive', archiveRouter);
  app.use(errorHandler);
  return app;
}

async function cleanup() {
  const pool = getDb();
  // Order: leaf rows keyed by explicit id (survive a repoint-to-ghost from a
  // prior run), then the node spine (cascades containers/docs/threads/memories/
  // summaries/messages), then the agents + their member rows. Ghost is never
  // touched here.
  await pool.query(`DELETE FROM public.runs WHERE id = $1 OR agent_id = ANY($2)`, [
    RUN,
    ALL_AGENT_IDS,
  ]);
  await pool.query(`DELETE FROM public.agent_activity_log WHERE id = $1 OR agent_id = ANY($2)`, [
    ACTIVITY,
    ALL_AGENT_IDS,
  ]);
  await pool.query(`DELETE FROM public.socket_sessions WHERE id = ANY($1) OR agent_id = ANY($2)`, [
    [SOCKET, SOCKET_PEER],
    ALL_AGENT_IDS,
  ]);
  await pool.query(`DELETE FROM public.placement_events WHERE id = $1`, [PLACEMENT]);
  await pool.query(`DELETE FROM public.thread_participants WHERE id = $1`, [TP]);
  await pool.query(`DELETE FROM public.settings WHERE category = $1`, [SETTING_CAT]);
  await pool.query(`DELETE FROM public.nodes WHERE id = ANY($1)`, [ALL_NODE_IDS]);
  await pool.query(`DELETE FROM public.members WHERE agent_id = ANY($1)`, [ALL_AGENT_IDS]);
  await pool.query(`DELETE FROM public.agents WHERE id = ANY($1)`, [ALL_AGENT_IDS]);
}

/**
 * Seed "Bill" (archived) owning the full reference surface a delete must handle:
 *   - agents(id) refs: message (+metadata), run, activity log, settings, socket_session, and a peer's session listing Bill.
 *   - members(id) refs: a container + doc he created, a placement he moved, and
 *     a thread participation.
 *   - private trash: a memory and a thread summary.
 * Returns Bill's member id.
 */
async function seedBillWithEverything(): Promise<string> {
  const pool = getDb();
  await Agents.create({ id: AGENT, name: AGENT_NAME });
  await Agents.create({ id: PEER, name: `${PREFIX} peer` });
  await Agents.archive(AGENT);
  const billMember = await Members.ensureForAgent(AGENT);

  // Thread spine (parent for messages/summaries/participants).
  await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread')`, [THREAD]);
  await pool.query(`INSERT INTO public.threads (id, title) VALUES ($1, 'Bill Thread')`, [THREAD]);

  // private trash
  await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'memory')`, [MEMORY]);
  await pool.query(
    `INSERT INTO public.memories (id, agent_id, memory_key, content, source_thread_id)
     VALUES ($1, $2, 'fav_food', 'peach', $3)`,
    [MEMORY, AGENT, THREAD]
  );
  await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread_summary')`, [SUMMARY]);
  await pool.query(
    `INSERT INTO public.thread_summaries (id, thread_id, agent_id, summary_text, is_current)
     VALUES ($1, $2, $3, 'summary body', true)`,
    [SUMMARY, THREAD, AGENT]
  );

  // agents(id) kept refs
  await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'message')`, [MESSAGE]);
  await pool.query(
    `INSERT INTO public.messages (id, thread_id, agent_id, role, content)
     VALUES ($1, $2, $3, 'assistant', 'hello from Bill')`,
    [MESSAGE, THREAD, AGENT]
  );
  await pool.query(
    `INSERT INTO public.runs (id, thread_id, agent_id, provider_id, model, status, started_at)
     VALUES ($1, $2, $3, 'anthropic', 'claude', 'succeeded', now())`,
    [RUN, THREAD, AGENT]
  );
  await pool.query(
    `INSERT INTO public.agent_activity_log (id, agent_id, action_type, trigger_type)
     VALUES ($1, $2, 'message_reply', 'mention')`,
    [ACTIVITY, AGENT]
  );
  await pool.query(
    `INSERT INTO public.settings (category, key, value, updated_by_agent_id)
     VALUES ($1, 'k', '"v"'::jsonb, $2)`,
    [SETTING_CAT, AGENT]
  );
  await pool.query(
    `INSERT INTO public.socket_sessions (id, agent_id, thread_id, participant_agent_ids)
     VALUES ($1, $2, $3, ARRAY[$2]::text[])`,
    [SOCKET, AGENT, THREAD]
  );
  // A peer's live session that lists Bill as a participant (array, non-FK).
  await pool.query(
    `INSERT INTO public.socket_sessions (id, agent_id, thread_id, participant_agent_ids)
     VALUES ($1, $2, $3, ARRAY[$2, $4]::text[])`,
    [SOCKET_PEER, PEER, THREAD, AGENT]
  );

  // members(id) kept refs (workspace attribution)
  await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'container')`, [CONTAINER]);
  await pool.query(
    `INSERT INTO public.containers (id, name, created_by, last_edited_by) VALUES ($1, 'Bill Folder', $2, $2)`,
    [CONTAINER, billMember.id]
  );
  await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'doc')`, [DOC]);
  await pool.query(
    `INSERT INTO public.docs (id, title, created_by, last_edited_by) VALUES ($1, 'Bill Doc', $2, $2)`,
    [DOC, billMember.id]
  );
  await pool.query(
    `INSERT INTO public.placement_events (id, node_id, moved_by) VALUES ($1, $2, $3)`,
    [PLACEMENT, DOC, billMember.id]
  );
  await pool.query(
    `INSERT INTO public.thread_participants (id, thread_id, member_id) VALUES ($1, $2, $3)`,
    [TP, THREAD, billMember.id]
  );

  return billMember.id;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await getDb().query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Every FK column referencing public.<target>(id), from the live catalog. */
async function fkColumnsReferencing(
  target: 'agents' | 'members'
): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await getDb().query<{ child_table: string; child_column: string }>(
    `SELECT rel.relname AS child_table, att.attname AS child_column
       FROM pg_constraint con
       JOIN pg_class rel        ON rel.oid = con.conrelid
       JOIN pg_class confrel    ON confrel.oid = con.confrelid
       JOIN pg_namespace ns     ON ns.oid = rel.relnamespace
       JOIN unnest(con.conkey)  WITH ORDINALITY AS ck(attnum, ord) ON true
       JOIN pg_attribute att    ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
      WHERE con.contype = 'f' AND confrel.relname = $1 AND ns.nspname = 'public'`,
    [target]
  );
  return rows.map((r) => ({ table: r.child_table, column: r.child_column }));
}

describe('AgentModel.purge — ghost permanent delete (real DB)', () => {
  let billMemberId: string;

  // Registered inside the describe, not at file level: Jest runs inner
  // afterAlls before outer ones, so this cleanup runs before the shared
  // closeDatabase() from tests/support/pgPerFileTeardown.ts. A query after
  // that close makes getDbClient() throw.
  afterAll(cleanup);

  beforeEach(async () => {
    await cleanup();
    billMemberId = await seedBillWithEverything();
  });

  it('destroys memories and summaries without orphan nodes', async () => {
    const result = await Agents.purge(AGENT);

    expect(result).toMatchObject({
      originalName: AGENT_NAME,
      deletedMemories: 1,
      deletedSummaries: 1,
    });

    expect(await count(`SELECT count(*) n FROM public.memories WHERE id = $1`, [MEMORY])).toBe(0);
    expect(await count(`SELECT count(*) n FROM public.nodes WHERE id = $1`, [MEMORY])).toBe(0);
    expect(
      await count(`SELECT count(*) n FROM public.thread_summaries WHERE id = $1`, [SUMMARY])
    ).toBe(0);
    expect(await count(`SELECT count(*) n FROM public.nodes WHERE id = $1`, [SUMMARY])).toBe(0);
  });

  it('deletes the agent + member rows for real (no husk)', async () => {
    await Agents.purge(AGENT);

    expect(await Agents.findById(AGENT)).toBeNull();
    expect(await count(`SELECT count(*) n FROM public.agents WHERE id = $1`, [AGENT])).toBe(0);
    expect(await count(`SELECT count(*) n FROM public.members WHERE id = $1`, [billMemberId])).toBe(
      0
    );
  });

  it('repoints kept agents(id) refs to ghost and stamps the original name on messages', async () => {
    await Agents.purge(AGENT);

    // Message survives, now authored by ghost, with the original name preserved.
    const { rows: msg } = await getDb().query<{ agent_id: string; original: string | null }>(
      `SELECT agent_id, metadata ->> 'originalAgentName' AS original
         FROM public.messages WHERE id = $1`,
      [MESSAGE]
    );
    expect(msg[0]?.agent_id).toBe(GHOST_AGENT_ID);
    expect(msg[0]?.original).toBe(AGENT_NAME);

    // Run / activity log / settings / feedback all repointed to ghost.
    expect(
      await count(`SELECT count(*) n FROM public.runs WHERE id=$1 AND agent_id=$2`, [
        RUN,
        GHOST_AGENT_ID,
      ])
    ).toBe(1);
    expect(
      await count(`SELECT count(*) n FROM public.agent_activity_log WHERE id=$1 AND agent_id=$2`, [
        ACTIVITY,
        GHOST_AGENT_ID,
      ])
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*) n FROM public.settings WHERE category=$1 AND updated_by_agent_id=$2`,
        [SETTING_CAT, GHOST_AGENT_ID]
      )
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*) n FROM public.docs WHERE id=$1 AND created_by=$2 AND last_edited_by=$2`,
        [DOC, GHOST_MEMBER_ID]
      )
    ).toBe(1);
    expect(
      await count(`SELECT count(*) n FROM public.placement_events WHERE id=$1 AND moved_by=$2`, [
        PLACEMENT,
        GHOST_MEMBER_ID,
      ])
    ).toBe(1);
    // Bill's thread participation (live roster state) is deleted with his member.
    expect(await count(`SELECT count(*) n FROM public.thread_participants WHERE id=$1`, [TP])).toBe(
      0
    );
  });

  it('leaves zero references to the deleted agent id or member id across every FK', async () => {
    await Agents.purge(AGENT);

    const agentFks = await fkColumnsReferencing('agents');
    // Sanity: the scan actually found the known FK surface (guards a broken query).
    expect(agentFks.length).toBeGreaterThanOrEqual(5);
    for (const { table, column } of agentFks) {
      const n = await count(`SELECT count(*) n FROM public.${table} WHERE ${column} = $1`, [AGENT]);
      expect(`${table}.${column}=${n}`).toBe(`${table}.${column}=0`);
    }

    const memberFks = await fkColumnsReferencing('members');
    expect(memberFks.length).toBeGreaterThanOrEqual(5);
    for (const { table, column } of memberFks) {
      const n = await count(`SELECT count(*) n FROM public.${table} WHERE ${column} = $1`, [
        billMemberId,
      ]);
      expect(`${table}.${column}=${n}`).toBe(`${table}.${column}=0`);
    }
  });

  it('ghost survives, resolvable by id but excluded from every listing', async () => {
    await Agents.purge(AGENT);

    // Resolvable by id (attribution can name it).
    expect((await Agents.findById(GHOST_AGENT_ID))?.name).toBe('ghost');
    expect((await Agents.findByIds([GHOST_AGENT_ID]))[0]?.id).toBe(GHOST_AGENT_ID);

    // Excluded from every listing — even includeArchived — and from the drawer.
    expect((await Agents.list({ limit: 1000 })).map((a) => a.id)).not.toContain(GHOST_AGENT_ID);
    expect(
      (await Agents.list({ limit: 1000, includeArchived: true })).map((a) => a.id)
    ).not.toContain(GHOST_AGENT_ID);
    expect((await Agents.listArchived()).map((a) => a.id)).not.toContain(GHOST_AGENT_ID);
  });

  it('is idempotent — a second purge is a no-op (returns null)', async () => {
    const first = await Agents.purge(AGENT);
    expect(first).not.toBeNull();
    const second = await Agents.purge(AGENT);
    expect(second).toBeNull();
  });

  it('returns null for a non-existent agent', async () => {
    expect(await Agents.purge('agent-nope-xyz')).toBeNull();
  });
});

describe('archive route — agent delete round-trip (real DB)', () => {
  const app = makeApp();

  // Nested for the same reason as the describe above.
  afterAll(cleanup);

  beforeEach(async () => {
    await cleanup();
    await seedBillWithEverything();
  });

  it('DELETE /api/archive/:id deletes the agent and drops it from GET /api/archive', async () => {
    const res = await request(app).delete(`/api/archive/${AGENT}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(1);

    // Agent row is gone; its memory destroyed; its message repointed to ghost.
    expect(await Agents.findById(AGENT)).toBeNull();
    expect(await count(`SELECT count(*) n FROM public.memories WHERE id = $1`, [MEMORY])).toBe(0);
    expect(
      await count(`SELECT count(*) n FROM public.messages WHERE id=$1 AND agent_id=$2`, [
        MESSAGE,
        GHOST_AGENT_ID,
      ])
    ).toBe(1);

    const listed = await request(app).get('/api/archive');
    const roots = listed.body.data.roots as Array<{ id: string }>;
    expect(roots.map((n) => n.id)).not.toContain(AGENT);
    expect(roots.map((n) => n.id)).not.toContain(GHOST_AGENT_ID);
  });

  it('a second DELETE is an idempotent 404 (already deleted)', async () => {
    await request(app).delete(`/api/archive/${AGENT}`);
    const again = await request(app).delete(`/api/archive/${AGENT}`);
    expect(again.status).toBe(404);
  });

  it('POST /api/archive/sweep-all deletes every archived agent (never ghost)', async () => {
    const res = await request(app)
      .post('/api/archive/sweep-all')
      .set('X-Snaglet-Panel-Token', getPanelToken());
    expect(res.status).toBe(200);
    expect(res.body.data.result.deletedAgents).toBeGreaterThanOrEqual(1);

    expect(await Agents.findById(AGENT)).toBeNull();
    // Ghost is never swept.
    expect((await Agents.findById(GHOST_AGENT_ID))?.id).toBe(GHOST_AGENT_ID);
  });
});
