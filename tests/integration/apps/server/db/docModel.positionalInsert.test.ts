/**
 * DocModel.create positional insert against the real database — an
 * explicit sortOrder bumps same-container doc siblings at/past the slot
 * (the tree's drop-file-between-rows import); omitting it appends at
 * MAX+1. Mirrors imageModel.positionalInsert.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Docs } from '@snaglet/db';

const PREFIX = 'docpos-test';
const CONTAINER_ID = `${PREFIX}-container`;

async function createDoc(id: string, containerId: string | null, sortOrder?: number) {
  await Docs.create({ id, title: id, content: 'body', containerId, sortOrder });
}

async function placements(containerId: string | null): Promise<Array<[string, number]>> {
  const { rows } = await getDb().query<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM public.nodes
      WHERE type = 'doc' AND id LIKE 'doc-${PREFIX}-%'
        AND container_id IS NOT DISTINCT FROM $1
      ORDER BY sort_order, id`,
    [containerId]
  );
  return rows.map((r) => [r.id, r.sort_order]);
}

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.docs WHERE id LIKE 'doc-${PREFIX}-%'`);
  await pool.query(`DELETE FROM public.nodes WHERE id LIKE 'doc-${PREFIX}-%' OR id = $1`, [
    CONTAINER_ID,
  ]);
}

describe('DocModel.create — positional insert', () => {
  beforeAll(async () => {
    await cleanup();
    await getDb().query(
      `INSERT INTO public.nodes (id, type) VALUES ($1, 'container') ON CONFLICT (id) DO NOTHING`,
      [CONTAINER_ID]
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  it('appends without sortOrder, inserts + bumps siblings with one', async () => {
    await createDoc(`doc-${PREFIX}-a`, CONTAINER_ID);
    await createDoc(`doc-${PREFIX}-b`, CONTAINER_ID);
    expect(await placements(CONTAINER_ID)).toEqual([
      [`doc-${PREFIX}-a`, 1],
      [`doc-${PREFIX}-b`, 2],
    ]);

    // Drop "between" a and b: explicit slot 2 takes b's place, b bumps to 3.
    await createDoc(`doc-${PREFIX}-mid`, CONTAINER_ID, 2);
    expect(await placements(CONTAINER_ID)).toEqual([
      [`doc-${PREFIX}-a`, 1],
      [`doc-${PREFIX}-mid`, 2],
      [`doc-${PREFIX}-b`, 3],
    ]);
  });
});
