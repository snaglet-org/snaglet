/**
 * Image move/reorder (ImageModel.moveTo) against the real database — images
 * are placed on the nodes spine (container_id + sort_order) like docs, so a
 * move changes container, appends to the destination bucket, and the
 * bump-then-set CTE shifts siblings to make room for a positional drop.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { getDb } from '@snaglet/db';
import { Images } from '@snaglet/db/tables/images';

const PREFIX = 'imgmove-test';
const CONTAINER_ID = `${PREFIX}-container`;
const IDS = {
  a: `image-${PREFIX}-a`,
  b: `image-${PREFIX}-b`,
};

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function createImage(id: string, containerId: string | null) {
  await Images.createImage({
    id,
    name: `${id}.png`,
    mimeType: 'image/png',
    data: PNG_1PX,
    sizeBytes: PNG_1PX.byteLength,
    tags: ['tool-capture'],
    containerId,
  });
}

async function placement(id: string): Promise<{ containerId: string | null; sortOrder: number }> {
  const row = await Images.findMetaById(id);
  if (!row) throw new Error(`image ${id} not found`);
  return { containerId: row.containerId, sortOrder: row.sortOrder };
}

async function cleanup() {
  const pool = getDb();
  await pool.query(`DELETE FROM public.images WHERE id LIKE 'image-${PREFIX}-%'`);
  await pool.query(`DELETE FROM public.nodes WHERE id LIKE 'image-${PREFIX}-%' OR id = $1`, [
    CONTAINER_ID,
  ]);
}

describe('ImageModel.moveTo', () => {
  beforeAll(async () => {
    await cleanup();
    await getDb().query(
      `INSERT INTO public.nodes (id, type) VALUES ($1, 'container') ON CONFLICT (id) DO NOTHING`,
      [CONTAINER_ID]
    );
    // Both start at the workspace root (container_id NULL).
    await createImage(IDS.a, null);
    await createImage(IDS.b, null);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('moves an image into a container, appending to the bucket', async () => {
    await Images.moveTo(IDS.a, CONTAINER_ID);
    await Images.moveTo(IDS.b, CONTAINER_ID);

    const a = await placement(IDS.a);
    const b = await placement(IDS.b);
    expect(a.containerId).toBe(CONTAINER_ID);
    expect(b.containerId).toBe(CONTAINER_ID);
    // b was filed after a, so it appends to a later slot.
    expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
  });

  it('positional move bumps the sibling to make room', async () => {
    // Drop b at the top of the bucket: it takes slot 0, a is bumped past it.
    await Images.moveTo(IDS.b, CONTAINER_ID, 0);

    const a = await placement(IDS.a);
    const b = await placement(IDS.b);
    expect(b.sortOrder).toBe(0);
    expect(a.sortOrder).toBeGreaterThan(b.sortOrder);
    expect(a.containerId).toBe(CONTAINER_ID);
  });

  it('moves an image back to the workspace root', async () => {
    await Images.moveTo(IDS.a, null);

    const a = await placement(IDS.a);
    expect(a.containerId).toBeNull();
  });

  it('returns null when the image does not exist', async () => {
    expect(await Images.moveTo(`image-${PREFIX}-missing`, CONTAINER_ID)).toBeNull();
  });
});
