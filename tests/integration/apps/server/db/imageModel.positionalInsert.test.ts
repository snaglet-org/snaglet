/**
 * ImageModel.createImage positional insert against the real database —
 * an explicit sortOrder bumps same-container siblings at/past the slot
 * (the tree's drop-between-rows gesture); omitting it appends at MAX+1.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Images } from '@snaglet/db/tables/images';

const PREFIX = 'imgpos-test';
const CONTAINER_ID = `${PREFIX}-container`;
const OTHER_CONTAINER_ID = `${PREFIX}-container-b`;

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function createImage(id: string, containerId: string | null, sortOrder?: number) {
  await Images.createImage({
    id,
    name: `${id}.png`,
    mimeType: 'image/png',
    data: PNG_1PX,
    sizeBytes: PNG_1PX.byteLength,
    containerId,
    sortOrder,
  });
}

async function placements(containerId: string | null): Promise<Array<[string, number]>> {
  const { rows } = await getDb().query<{ id: string; sort_order: number }>(
    `SELECT id, sort_order FROM public.nodes
      WHERE type = 'image' AND id LIKE 'image-${PREFIX}-%'
        AND container_id IS NOT DISTINCT FROM $1
      ORDER BY sort_order, id`,
    [containerId]
  );
  return rows.map((r) => [r.id, r.sort_order]);
}

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.images WHERE id LIKE 'image-${PREFIX}-%'`);
  await pool.query(
    `DELETE FROM public.nodes WHERE id LIKE 'image-${PREFIX}-%' OR id = $1 OR id = $2`,
    [CONTAINER_ID, OTHER_CONTAINER_ID]
  );
}

describe('ImageModel.createImage — positional insert', () => {
  beforeAll(async () => {
    await cleanup();
    await getDb().query(
      `INSERT INTO public.nodes (id, type) VALUES ($1, 'container'), ($2, 'container')
       ON CONFLICT (id) DO NOTHING`,
      [CONTAINER_ID, OTHER_CONTAINER_ID]
    );
  });

  afterAll(async () => {
    await cleanup();
  });

  it('appends without sortOrder, inserts + bumps siblings with one', async () => {
    // Two appends establish slots 1 and 2.
    await createImage(`image-${PREFIX}-a`, CONTAINER_ID);
    await createImage(`image-${PREFIX}-b`, CONTAINER_ID);
    expect(await placements(CONTAINER_ID)).toEqual([
      [`image-${PREFIX}-a`, 1],
      [`image-${PREFIX}-b`, 2],
    ]);

    // Drop "between" a and b: explicit slot 2 takes b's place, b bumps to 3.
    await createImage(`image-${PREFIX}-mid`, CONTAINER_ID, 2);
    expect(await placements(CONTAINER_ID)).toEqual([
      [`image-${PREFIX}-a`, 1],
      [`image-${PREFIX}-mid`, 2],
      [`image-${PREFIX}-b`, 3],
    ]);
  });

  it('scopes the bump to the target container', async () => {
    await createImage(`image-${PREFIX}-other1`, OTHER_CONTAINER_ID);
    await createImage(`image-${PREFIX}-other2`, OTHER_CONTAINER_ID, 1); // insert at slot 1

    expect(await placements(OTHER_CONTAINER_ID)).toEqual([
      [`image-${PREFIX}-other2`, 1],
      [`image-${PREFIX}-other1`, 2],
    ]);

    // The first container's placements are untouched by the other bump.
    expect(await placements(CONTAINER_ID)).toEqual([
      [`image-${PREFIX}-a`, 1],
      [`image-${PREFIX}-mid`, 2],
      [`image-${PREFIX}-b`, 3],
    ]);
  });
});
