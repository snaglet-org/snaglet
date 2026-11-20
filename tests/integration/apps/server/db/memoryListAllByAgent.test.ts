/**
 * `Memories.listAllByAgent` against the real database. It backs "export
 * everything this agent knows", so the returned set must be exactly the
 * memories that existed when the export began: no gaps, no repeats. Looping the
 * paged `listByAgent` (LIMIT/OFFSET over `updated_at DESC`) cannot give that:
 * memories written in one turn share a timestamp, so page boundaries over the
 * unstable sort skip and duplicate rows, and a row touched between pages moves
 * to the front and pushes another past the boundary unseen. Both only show up
 * against a real engine.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { getDb, getDbClient } from '@snaglet/db';
import type { DbClient } from '@snaglet/db/adapters/types';
import { Agents } from '@snaglet/db/tables/agents';
import { Memories } from '@snaglet/db/tables/memories';

const PREFIX = 'mem-listall-it';
const AGENT_ID = `agent-${PREFIX}`;
const OTHER_AGENT_ID = `agent-${PREFIX}-other`;

/** Page size used throughout so the boundary cases are small and explicit. */
const PAGE = 10;

async function seedMemory(id: string, content: string, agentId = AGENT_ID): Promise<void> {
  await Memories.create({ id, agentId, key: id, content });
}

/** Force an exact `updated_at` so ties and orderings are deterministic. */
async function setUpdatedAt(id: string, iso: string): Promise<void> {
  await getDb().query('UPDATE public.nodes SET updated_at = $2 WHERE id = $1', [id, iso]);
}

async function cleanup(): Promise<void> {
  await getDb().query(`DELETE FROM public.memories WHERE agent_id IN ($1, $2)`, [
    AGENT_ID,
    OTHER_AGENT_ID,
  ]);
  await getDb().query(`DELETE FROM public.nodes WHERE id LIKE $1`, [`memory-${PREFIX}%`]);
}

beforeAll(async () => {
  // Agents are actors, not nodes, so they are
  // created directly — there is no nodes row to ensure first. Memories are
  // nodes, and Memories.create ensures its own spine row.
  for (const id of [AGENT_ID, OTHER_AGENT_ID]) {
    await Agents.create({ id, name: id }).catch((err: unknown) => {
      console.debug('agent seed skipped (likely exists):', err);
    });
  }
});

/** A promise plus its resolver, for handing control between the read and the
 *  concurrent writer. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Run `mutate` on a separately acquired connection and commit it, while the
 * paged read holds its own connection open.
 *
 * `getDbClient()` returns the shared adapter whose `query()` checks a
 * connection out of the pool (max 10) per call, so this genuinely runs on a
 * different backend than the open REPEATABLE READ transaction — which is the
 * only way the snapshot claim means anything.
 */
async function commitOnSeparateConnection(mutate: (tx: DbClient) => Promise<void>): Promise<void> {
  const client = await getDbClient();
  await client.transaction(async (tx) => {
    await mutate(tx);
  });
}

describe('listAllByAgent completeness', () => {
  // Each case seeds its own fixed row count and asserts on it, so they must
  // not inherit rows from each other.
  beforeEach(cleanup);
  // Nested inside the describe on purpose: a file-level afterAll unwinds after
  // the shared database teardown has closed the pool, and this cleanup queries.
  afterAll(cleanup);

  it('returns every memory when there are more than one page', async () => {
    const ids = Array.from({ length: PAGE * 3 + 4 }, (_, i) => `memory-${PREFIX}-${i}`);
    for (const id of ids) await seedMemory(id, `content ${id}`);

    const all = await Memories.listAllByAgent(AGENT_ID, PAGE);

    expect(all).toHaveLength(ids.length);
    expect(new Set(all.map((m) => m.id)).size).toBe(ids.length);
    expect(new Set(all.map((m) => m.id))).toEqual(new Set(ids));
  });

  it('returns everything past the 50-row listByAgent default', async () => {
    // The default the admin panel relies on. A loop that inherited it would
    // stop here and the file would claim to hold everything.
    const ids = Array.from({ length: 137 }, (_, i) => `memory-${PREFIX}-d${i}`);
    for (const id of ids) await seedMemory(id, 'x');

    await expect(Memories.listAllByAgent(AGENT_ID)).resolves.toHaveLength(137);
  });

  it('does not skip or duplicate when every row shares one timestamp', async () => {
    // The realistic shape: memories written during a single turn. Without the
    // `id` tie-break the sort is unstable and page boundaries slide.
    const ids = Array.from({ length: PAGE * 4 }, (_, i) => `memory-${PREFIX}-t${i}`);
    for (const id of ids) await seedMemory(id, 'same instant');
    for (const id of ids) await setUpdatedAt(id, '2026-01-01T00:00:00.000Z');

    const all = await Memories.listAllByAgent(AGENT_ID, PAGE);

    expect(all).toHaveLength(ids.length);
    expect(new Set(all.map((m) => m.id)).size).toBe(ids.length);
  });

  it('is a snapshot: a row inserted after page 1 is excluded, and shifts nothing', async () => {
    const ids = Array.from({ length: PAGE * 2 }, (_, i) => `memory-${PREFIX}-s${i}`);
    for (const id of ids) await seedMemory(id, 'original');

    // Deterministic interleave: the read pauses after page 1 (snapshot is
    // established by then), the insert commits on a different connection, and
    // only then does page 2 run.
    const pageOneRead = deferred();
    const mutationCommitted = deferred();
    const reading = Memories.listAllByAgent(AGENT_ID, PAGE, {
      async onPage(index) {
        if (index !== 0) return;
        pageOneRead.resolve();
        await mutationCommitted.promise;
      },
    });

    await pageOneRead.promise;
    await commitOnSeparateConnection(async (tx) => {
      await tx.query(`INSERT INTO public.nodes (id, type) VALUES ($1, 'memory')`, [
        `memory-${PREFIX}-late`,
      ]);
      await tx.query(
        `INSERT INTO public.memories (id, agent_id, memory_key, content) VALUES ($1, $2, $3, $4)`,
        [`memory-${PREFIX}-late`, AGENT_ID, 'late', 'arrived mid-export']
      );
    });
    mutationCommitted.resolve();

    const returned = (await reading).map((m) => m.id);

    // Exact set: every original, exactly once, and not the newcomer — it did
    // not exist when the export began, and the snapshot is what the file
    // claims to represent.
    expect(new Set(returned)).toEqual(new Set(ids));
    expect(returned).toHaveLength(ids.length);
    expect(returned).not.toContain(`memory-${PREFIX}-late`);
  });

  it('is a snapshot: a row whose updated_at changes after page 1 is still returned once', async () => {
    const ids = Array.from({ length: PAGE * 2 }, (_, i) => `memory-${PREFIX}-u${i}`);
    for (const id of ids) await seedMemory(id, 'original');
    // Spread the timestamps so there is a real ordering to disturb.
    for (const [i, id] of ids.entries()) {
      await setUpdatedAt(id, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
    }

    const pageOneRead = deferred();
    const mutationCommitted = deferred();
    const reading = Memories.listAllByAgent(AGENT_ID, PAGE, {
      async onPage(index) {
        if (index !== 0) return;
        pageOneRead.resolve();
        await mutationCommitted.promise;
      },
    });

    await pageOneRead.promise;
    // Touch the oldest row so it jumps to the front of the ordering. Under
    // offset paging this shifts everything behind it down one and the row at
    // the page-1 boundary is never returned.
    await commitOnSeparateConnection(async (tx) => {
      await tx.query('UPDATE public.nodes SET updated_at = $2 WHERE id = $1', [
        ids[0],
        '2026-06-01T00:00:00.000Z',
      ]);
    });
    mutationCommitted.resolve();

    const returned = (await reading).map((m) => m.id);

    expect(new Set(returned)).toEqual(new Set(ids));
    expect(returned).toHaveLength(ids.length);
  });

  it('never returns another agent’s memories', async () => {
    await seedMemory(`memory-${PREFIX}-mine`, 'mine');
    await seedMemory(`memory-${PREFIX}-theirs`, 'theirs', OTHER_AGENT_ID);

    const all = await Memories.listAllByAgent(AGENT_ID, PAGE);

    expect(all.map((m) => m.id)).toEqual([`memory-${PREFIX}-mine`]);
  });

  it('returns an empty list for an agent with no memories', async () => {
    await expect(Memories.listAllByAgent(AGENT_ID, PAGE)).resolves.toEqual([]);
  });
});
