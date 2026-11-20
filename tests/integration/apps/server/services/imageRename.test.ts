/**
 * Image rename against the real database and a temporary blob store: the
 * name and the stored file change together, old `<id>.<ext>` keys keep
 * working, a failed DB write leaves the original file and key in place, and
 * the rename invalidates the image's vector so search never serves the old
 * name.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { link, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '@snaglet/db';
import { Embeddings } from '@snaglet/db/tables/embeddings';
import { Images } from '@snaglet/db/tables/images';
import { Nodes } from '@snaglet/db/tables/nodes';
import { searchPaletteOnlyKind } from '@server/services/search/paletteSearchQueries';

const IMAGE_ID = 'image-1111111111111-aaaaaaaaa';
const PROVIDER_ID = 'test-provider-a';
const MODEL_ID = 'test-model-a';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let blobDir: string;
const previousDir = process.env.SNAGLET_IMAGES_DIR;

async function storedKey(): Promise<string> {
  const { rows } = await getDb().query<{ url: string }>(
    `SELECT url FROM public.images WHERE id = $1`,
    [IMAGE_ID]
  );
  return rows[0]!.url;
}

async function createImage(name = 'Capture.png'): Promise<void> {
  await Images.createImage({
    id: IMAGE_ID,
    name,
    mimeType: 'image/png',
    data: PNG_1PX,
    sizeBytes: PNG_1PX.byteLength,
    tags: ['test-tag'],
  });
}

describe('ImageModel.rename', () => {
  beforeAll(async () => {
    const db = getDb();
    await db.query(
      `INSERT INTO public.providers (id, name, type) VALUES ($1, 'Image rename test', 'runtime')
       ON CONFLICT (id) DO NOTHING`,
      [PROVIDER_ID]
    );
    await db.query(
      `INSERT INTO public.models (id, provider_id, model_id, display_name, type, dimensions)
       VALUES ($1, $2, $3, 'Image rename test embedding', 'embedding', 768)
       ON CONFLICT (provider_id, model_id) DO NOTHING`,
      [MODEL_ID, PROVIDER_ID, 'test-embedding-model-a']
    );
  });

  beforeEach(async () => {
    blobDir = await mkdtemp(join(tmpdir(), 'snaglet-image-rename-'));
    process.env.SNAGLET_IMAGES_DIR = blobDir;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await getDb().query(`DELETE FROM public.nodes WHERE id = $1`, [IMAGE_ID]);
    if (previousDir === undefined) delete process.env.SNAGLET_IMAGES_DIR;
    else process.env.SNAGLET_IMAGES_DIR = previousDir;
    await rm(blobDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    const db = getDb();
    await db.query(`DELETE FROM public.models WHERE id = $1`, [MODEL_ID]);
    await db.query(`DELETE FROM public.providers WHERE id = $1`, [PROVIDER_ID]);
  });

  it('renames the image and its stored file, keeping an old id key readable first', async () => {
    await createImage();
    expect(await storedKey()).toBe(`${IMAGE_ID}.png`);
    expect((await Images.findImageById(IMAGE_ID))?.data).toEqual(PNG_1PX);

    const outcome = await Images.rename(IMAGE_ID, 'Sunset over bay');
    expect(outcome).toMatchObject({ status: 'renamed', image: { name: 'Sunset over bay' } });
    expect(await storedKey()).toBe(`Sunset over bay-${IMAGE_ID}.png`);
    expect(await readdir(blobDir)).toEqual([`Sunset over bay-${IMAGE_ID}.png`]);

    const read = await Images.findImageById(IMAGE_ID);
    expect(read?.data).toEqual(PNG_1PX);
    expect(read?.storageKey).toBe(`Sunset over bay-${IMAGE_ID}.png`);
  });

  it('renames again from a renamed key, including a case-only change', async () => {
    await createImage();
    await Images.rename(IMAGE_ID, 'sunset');
    await Images.rename(IMAGE_ID, 'Sunset');
    expect(await storedKey()).toBe(`Sunset-${IMAGE_ID}.png`);
    expect(await readdir(blobDir)).toEqual([`Sunset-${IMAGE_ID}.png`]);
    expect((await Images.findImageById(IMAGE_ID))?.data).toEqual(PNG_1PX);
  });

  it('keeps the original file and key when the DB write fails', async () => {
    await createImage();
    jest.spyOn(Nodes, 'touch').mockRejectedValueOnce(new Error('simulated write failure'));

    await expect(Images.rename(IMAGE_ID, 'Never saved')).rejects.toThrow('simulated write failure');

    expect(await storedKey()).toBe(`${IMAGE_ID}.png`);
    expect(await readdir(blobDir)).toEqual([`${IMAGE_ID}.png`]);
    const read = await Images.findImageById(IMAGE_ID);
    expect(read?.name).toBe('Capture.png');
    expect(read?.data).toEqual(PNG_1PX);
  });

  it('is idempotent for an unchanged name', async () => {
    await createImage('Same');
    const outcome = await Images.rename(IMAGE_ID, 'Same');
    expect(outcome.status).toBe('unchanged');
    expect(await storedKey()).toBe(`${IMAGE_ID}.png`);
  });

  it('reports a conflict when the name changed since the caller saw it', async () => {
    await createImage('Current');
    const outcome = await Images.rename(IMAGE_ID, 'Next', { expectedName: 'Stale' });
    expect(outcome).toEqual({ status: 'conflict', currentName: 'Current' });
    expect((await Images.findMetaById(IMAGE_ID))?.name).toBe('Current');
  });

  it('reports a missing image', async () => {
    expect(await Images.rename('image-2222222222222-bbbbbbbbb', 'Anything')).toEqual({
      status: 'missing',
    });
  });

  it('renames an image whose bytes are inline without writing a file', async () => {
    await Nodes.ensure(IMAGE_ID, 'image');
    const dataUrl = `data:image/png;base64,${PNG_1PX.toString('base64')}`;
    await getDb().query(
      `INSERT INTO public.images (id, url, alt_text, metadata) VALUES ($1, $2, 'Inline', $3::jsonb)`,
      [IMAGE_ID, dataUrl, JSON.stringify({ mimeType: 'image/png', sizeBytes: PNG_1PX.length })]
    );

    const outcome = await Images.rename(IMAGE_ID, 'Inline renamed');
    expect(outcome.status).toBe('renamed');
    expect(await storedKey()).toBe(dataUrl);
    expect(await readdir(blobDir)).toEqual([]);
    const read = await Images.findImageById(IMAGE_ID);
    expect(read?.name).toBe('Inline renamed');
    expect(read?.storageKey).toBeNull();
  });

  it('renames an image whose file is missing and keeps its key', async () => {
    await createImage();
    await rm(join(blobDir, `${IMAGE_ID}.png`));
    const outcome = await Images.rename(IMAGE_ID, 'Lost bytes');
    expect(outcome.status).toBe('renamed');
    expect(await storedKey()).toBe(`${IMAGE_ID}.png`);
  });

  it('finds the bytes when the row names a file from before a rename', async () => {
    await createImage();
    await Images.rename(IMAGE_ID, 'Renamed once');
    // A database backup taken before the rename still names the old key.
    await getDb().query(`UPDATE public.images SET url = $2 WHERE id = $1`, [
      IMAGE_ID,
      `${IMAGE_ID}.png`,
    ]);

    const read = await Images.findImageById(IMAGE_ID);
    expect(read?.data).toEqual(PNG_1PX);
    expect(read?.storageKey).toBe(`Renamed once-${IMAGE_ID}.png`);

    await Images.rename(IMAGE_ID, 'Renamed twice');
    expect(await storedKey()).toBe(`Renamed twice-${IMAGE_ID}.png`);
    expect(await readdir(blobDir)).toEqual([`Renamed twice-${IMAGE_ID}.png`]);
  });

  it('runs two renames of one image one after the other', async () => {
    await createImage();
    const [first, second] = await Promise.all([
      Images.rename(IMAGE_ID, 'First'),
      Images.rename(IMAGE_ID, 'Second'),
    ]);
    expect([first.status, second.status]).toEqual(['renamed', 'renamed']);
    expect(await storedKey()).toBe(`Second-${IMAGE_ID}.png`);
    expect(await readdir(blobDir)).toEqual([`Second-${IMAGE_ID}.png`]);
    expect((await Images.findImageById(IMAGE_ID))?.data).toEqual(PNG_1PX);
  });

  it('lets one of two renames from the same shown name win', async () => {
    await createImage('Shown');
    const outcomes = await Promise.all([
      Images.rename(IMAGE_ID, 'First', { expectedName: 'Shown' }),
      Images.rename(IMAGE_ID, 'Second', { expectedName: 'Shown' }),
    ]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['conflict', 'renamed']);
    const winner = outcomes[0]!.status === 'renamed' ? 'First' : 'Second';
    expect(await storedKey()).toBe(`${winner}-${IMAGE_ID}.png`);
    expect(await readdir(blobDir)).toEqual([`${winner}-${IMAGE_ID}.png`]);
  });

  it('retires the old name when an interrupted rename left a second link', async () => {
    await createImage();
    await link(join(blobDir, `${IMAGE_ID}.png`), join(blobDir, `Later-${IMAGE_ID}.png`));
    await Images.rename(IMAGE_ID, 'Later');
    expect(await storedKey()).toBe(`Later-${IMAGE_ID}.png`);
    expect(await readdir(blobDir)).toEqual([`Later-${IMAGE_ID}.png`]);
    expect((await Images.findImageById(IMAGE_ID))?.data).toEqual(PNG_1PX);
  });

  it('drops stale vectors and makes the new name searchable', async () => {
    await createImage('Before name');
    await Embeddings.replaceChunks(IMAGE_ID, MODEL_ID, 'before-name', [
      { vector: new Array(768).fill(0.25), chunkIndex: 0, chunkStart: 0, chunkEnd: 10 },
    ]);
    const before = await Images.findMetaById(IMAGE_ID);

    await Images.rename(IMAGE_ID, `Renamedphrasezq`);

    expect(await Embeddings.listByNode(IMAGE_ID, MODEL_ID)).toEqual([]);
    const after = await Images.findMetaById(IMAGE_ID);
    expect(Date.parse(after!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before!.updatedAt));
    const hits = await searchPaletteOnlyKind({
      query: `Renamedphrasezq`,
      kind: 'image',
      limit: 10,
    });
    expect(hits.map((hit) => hit.node_id)).toContain(IMAGE_ID);
  });
});
