/**
 * Agent de-noding + voice persistence against the real database.
 *
 * Agents are actors, not nodes. Their private memories and thread summaries
 * are deleted with the agent while unrelated workspace nodes survive.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb, Agents, Memories } from '@snaglet/db';

const PREFIX = 'denode-test';
const AGENT = `agent-${PREFIX}`;
const THREAD = `thread-${PREFIX}`;
const SUMMARY = `summary-${PREFIX}`;
const MEMORY = `memory-${PREFIX}`;

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.agents WHERE id = $1`, [AGENT]);
  await pool.query(`DELETE FROM public.nodes WHERE id IN ($1, $2, $3)`, [THREAD, SUMMARY, MEMORY]);
  await pool.query(`DELETE FROM public.members WHERE agent_id = $1`, [AGENT]);
}

describe('agent voice round-trips through agentSelect (real DB)', () => {
  const VOICE_AGENT = `agent-${PREFIX}-voice`;

  async function cleanupVoice() {
    await getDb().query(`DELETE FROM public.agents WHERE id = $1`, [VOICE_AGENT]);
  }

  beforeAll(cleanupVoice);
  afterAll(cleanupVoice);

  // agentSelect must include `a.voice`; without it every read
  // (findById/findByIds/list) drops the field and resolveAgentVoiceId falls
  // back to the default voice.
  it('create with voice → findById returns it', async () => {
    await Agents.create({
      id: VOICE_AGENT,
      name: `${PREFIX} voice agent`,
      voice: 'en_US-amy-medium',
    });
    const found = await Agents.findById(VOICE_AGENT);
    expect(found?.voice).toBe('en_US-amy-medium');
  });

  it('findByIds (list path) surfaces the configured voice', async () => {
    const rows = await Agents.findByIds([VOICE_AGENT]);
    expect(rows[0]?.voice).toBe('en_US-amy-medium');
  });

  it('update voice → findById returns the updated value', async () => {
    await Agents.update(VOICE_AGENT, { voice: 'en_GB-alan-medium' });
    const found = await Agents.findById(VOICE_AGENT);
    expect(found?.voice).toBe('en_GB-alan-medium');
  });

  it('null voice round-trips as null (falls back to the default at resolve time)', async () => {
    await Agents.update(VOICE_AGENT, { voice: null });
    const found = await Agents.findById(VOICE_AGENT);
    expect(found?.voice).toBeNull();
  });
});

describe('agent de-noding: creation, FK repoints, cascade delete (real DB)', () => {
  beforeAll(async () => {
    await cleanup();
    const pool = getDb();

    // Agent: an actor, not a node.
    await Agents.create({ id: AGENT, name: `${PREFIX} agent` });

    // A thread the summary/memory hang off (a real node — must survive the agent delete).
    await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread')`, [THREAD]);
    await pool.query(`INSERT INTO public.threads (id, title) VALUES ($1, 'T')`, [THREAD]);

    // Owned rows referencing agents(id): member (Agents.create makes it with
    // the agent), memory, thread_summary.
    await Memories.create({ id: MEMORY, agentId: AGENT, key: 'k', content: 'a memory' });
    await pool.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'thread_summary')`, [
      SUMMARY,
    ]);
    await pool.query(
      `INSERT INTO public.thread_summaries (id, thread_id, agent_id, summary_text)
       VALUES ($1, $2, $3, 'a summary')`,
      [SUMMARY, THREAD, AGENT]
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  async function count(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await getDb().query<{ n: string }>(sql, params);
    return Number(rows[0].n);
  }

  it('creating an agent mints no node row (agents are actors)', async () => {
    expect(await count(`SELECT COUNT(*) AS n FROM public.nodes WHERE id = $1`, [AGENT])).toBe(0);
    // ...but the agent is loadable from the agents table (no nodes JOIN).
    const agent = await Agents.findById(AGENT);
    expect(agent?.name).toBe(`${PREFIX} agent`);
    expect(agent?.archived).toBe(false);
    expect(agent?.updatedAt).toBeTruthy();
  });

  it('owned rows reference the agent via the repointed FKs', async () => {
    expect(
      await count(`SELECT COUNT(*) AS n FROM public.members WHERE agent_id = $1`, [AGENT])
    ).toBe(1);
    expect(
      await count(`SELECT COUNT(*) AS n FROM public.memories WHERE agent_id = $1`, [AGENT])
    ).toBe(1);
    expect(
      await count(`SELECT COUNT(*) AS n FROM public.thread_summaries WHERE agent_id = $1`, [AGENT])
    ).toBe(1);
  });

  it('deleting the agent cascades its owned rows but leaves unrelated nodes intact', async () => {
    const deleted = await Agents.delete(AGENT);
    expect(deleted).toBe(true);

    expect(await count(`SELECT COUNT(*) AS n FROM public.agents WHERE id = $1`, [AGENT])).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS n FROM public.members WHERE agent_id = $1`, [AGENT])
    ).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS n FROM public.memories WHERE agent_id = $1`, [AGENT])
    ).toBe(0);
    expect(
      await count(`SELECT COUNT(*) AS n FROM public.thread_summaries WHERE agent_id = $1`, [AGENT])
    ).toBe(0);

    // The thread node is unrelated to the agent and must be untouched.
    expect(await count(`SELECT COUNT(*) AS n FROM public.nodes WHERE id = $1`, [THREAD])).toBe(1);
  });
});
